import {
  anomaliesAJour,
  cleTexte,
  nomRessemblant,
  RESSEMBLE,
  TEXTE_PARTAGE,
} from '../common/anomalies';
import { LotsReceptionService } from './lots-reception.service';
import {
  GROUPES_QUOTA,
  groupeQuota,
  libelleLot,
  libellePaquet,
  sqlGroupeQuota,
  sqlLibelleLot,
} from '../common/lots';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  LIBELLE_CYCLE,
  NOTES_AFFECTATION,
  type Cycle,
} from '../common/referentiels';
import { normaliser } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  Affectation,
  Agent,
  Departement,
  LotPublication,
  PaquetReception,
  Recommandation,
  ReferenceNote,
  RegleDiplome,
} from '../entities';
import {
  deriver,
  estContractuel,
  referenceTexte,
  type ParametresCalcul,
} from './calcul';

export interface FiltreAffectations {
  lot?: number;
  /** Plusieurs lots à la fois (identifiants des lots de publication). */
  lotsIds?: number[];
  /** Plusieurs lots à la fois (n° des lots, comme `lot`). */
  lots?: number[];
  /** Groupes de quota : MEPPSA, AUTRES_AVEC, AUTRES_SANS (vide : tous). */
  groupes?: string[];
  typeNote?: string;
  departementId?: number;
  statut?: string;
  recherche?: string;
  probleme?: 'bloquant' | 'avertissement';
  /** Personnes placées par une répartition du quota « Autres ». */
  repartitionId?: string;
}

/**
 * Première étape d'une recommandation : le directeur donne son avis sur celle d'un chef de service
 * ou d'un agent ; proposée par un directeur ou par le DG, elle va directement à la décision du DG.
 */
export const etapeInitiale = (role: string) =>
  ['DIRECTEUR', 'DG', 'ADMIN'].includes(role)
    ? 'DECISION_DG'
    : 'AVIS_DIRECTEUR';

@Injectable()
export class AffectationService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(LotPublication)
    private readonly lots: Repository<LotPublication>,
    @InjectRepository(Recommandation)
    private readonly recos: Repository<Recommandation>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
    private readonly lotsReception: LotsReceptionService,
    @InjectRepository(ReferenceNote)
    private readonly refsNotes: Repository<ReferenceNote>,
  ) {}

  parametresCalcul(): ParametresCalcul {
    return {
      ageLimite: Number(this.params.get('CONTRACTUEL_AGE_LIMITE')) || 30,
      ageLimiteCatI:
        Number(this.params.get('CONTRACTUEL_AGE_LIMITE_CAT_I')) || 35,
      // Sans texte signé, l'âge est compté à aujourd'hui (prévision)
      dateReference: new Date().toISOString().slice(0, 10),
      pointIndiciaire: Number(this.params.get('POINT_INDICIAIRE')) || 300,
    };
  }

  async reglesParCode() {
    return new Map((await this.regles.find()).map((r) => [r.code, r]));
  }

  /* ------------------------------- Lots ------------------------------- */

  async listeLots() {
    // Lectures indépendantes : en parallèle (et non l'une après l'autre)
    const [
      lots,
      paquetsListe,
      stats,
      agents,
      parQuota,
      notesOuvertes,
      aTraiter,
    ] = await Promise.all([
      this.lots.find({ order: { numero: 'ASC' } }),
      this.lots.manager.getRepository(PaquetReception).find(),
      this.affectations.query<{ lot: number; statut: string; n: number }[]>(`
        SELECT f."lotPublicationId" AS lot, f.statut, count(*)::int AS n
        FROM affectation f GROUP BY 1, 2`),
      this.agents.query<{ lot: number; type: string; n: number }[]>(`
        SELECT "lotPublicationId" AS lot, "typeTexte" AS type, count(*)::int AS n
        FROM agent WHERE "lotPublicationId" IS NOT NULL GROUP BY 1, 2`),
      // Répartition de chaque lot par quota (la FP mélange les quotas dans un lot)
      this.agents.query<{ lot: number; quota: string; n: number }[]>(`
        SELECT "lotPublicationId" AS lot,
          CASE WHEN feuille = 'QUOTA_AUTRES' THEN 'Autres'
               ELSE coalesce(quota::text, 'sans quota') END AS quota,
          count(*)::int AS n
        FROM agent WHERE "lotPublicationId" IS NOT NULL
        GROUP BY 1, 2`),
      // Détail des « pas encore affectés » : où en est chaque personne
      this.agents.query<{ lot: number; type: string; statut: string }[]>(`
        SELECT "lotPublicationId" AS lot, "typeNote" AS type, statut
        FROM note_service
        WHERE module = 'AFFECTATION' AND statut IN ('BROUILLON', 'SOUMISE')`),
      this.requete({ statut: 'A_TRAITER' }).getMany(),
    ]);
    // Groupes de quota de chaque lot (MEPPSA, Autres avec / sans département) et déport
    const groupes = await this.agents.query<
      { lot: number; g: string; statut: string | null; n: number }[]
    >(`
      SELECT a."lotPublicationId" AS lot, ${sqlGroupeQuota('a')} AS g, f.statut, count(*)::int AS n
      FROM agent a LEFT JOIN affectation f ON f."agentId" = a.id
      WHERE a."lotPublicationId" IS NOT NULL GROUP BY 1, 2, 3`);
    const aDeporter = await this.agents.query<{ lot: number; n: number }[]>(`
      SELECT f."lotPublicationId" AS lot, count(*)::int AS n FROM affectation f
      JOIN note_service n ON n.id = f."noteId" AND n.statut = 'SIGNEE'
      WHERE f.statut = 'AFFECTE' AND f."deporteLe" IS NULL GROUP BY 1`);
    const paquets = new Map(paquetsListe.map((p) => [p.id, p]));
    const enCours = await this.enrichir(aTraiter);
    const detail = new Map<
      number,
      {
        enValidation: number;
        enBrouillon: number;
        sansNote: number;
        aCompleter: number;
        raisons: Record<string, number>;
      }
    >();
    for (const x of enCours) {
      const lotId = x.agent.lotPublicationId!;
      const d = detail.get(lotId) ?? {
        enValidation: 0,
        enBrouillon: 0,
        sansNote: 0,
        aCompleter: 0,
        raisons: {},
      };
      detail.set(lotId, d);
      if (x.derive.bloquants.length) {
        d.aCompleter++;
        for (const r of x.derive.bloquants) {
          const k = r.split(' (')[0];
          d.raisons[k] = (d.raisons[k] ?? 0) + 1;
        }
        continue;
      }
      const note = notesOuvertes.filter(
        (n) => n.lot === lotId && n.type === x.typeNote,
      );
      if (note.some((n) => n.statut === 'SOUMISE')) d.enValidation++;
      else if (note.length) d.enBrouillon++;
      else d.sansNote++;
    }
    return lots.map((l) => {
      const s = (st: string) =>
        stats.find((x) => x.lot === l.id && x.statut === st)?.n ?? 0;
      const t = (ty: string) =>
        agents.find((x) => x.lot === l.id && x.type === ty)?.n ?? 0;
      const p = l.paquetId ? paquets.get(l.paquetId) : undefined;
      return {
        ...l,
        libelle: libelleLot(l),
        paquet: p
          ? {
              numero: p.numero,
              dateReception: p.dateReception,
              libelle: libellePaquet(p),
            }
          : null,
        arretes: t('ARRETE'),
        decrets: t('DECRET'),
        aTraiter: s('A_TRAITER'),
        quotas: parQuota
          .filter((q) => q.lot === l.id)
          .sort((x, y) =>
            // années d'abord (de la plus ancienne), puis « Autres », puis « sans quota »
            /^\d+$/.test(x.quota) && /^\d+$/.test(y.quota)
              ? Number(x.quota) - Number(y.quota)
              : /^\d+$/.test(x.quota)
                ? -1
                : /^\d+$/.test(y.quota)
                  ? 1
                  : x.quota.localeCompare(y.quota),
          )
          .map((q) => ({ quota: q.quota, n: q.n })),
        detailATraiter: detail.get(l.id) ?? {
          enValidation: 0,
          enBrouillon: 0,
          sansNote: 0,
          aCompleter: 0,
          raisons: {},
        },
        exclus: s('EXCLU'),
        affectes: s('AFFECTE'),
        groupes: Object.fromEntries(
          GROUPES_QUOTA.map((g) => {
            const ici = groupes.filter((x) => x.lot === l.id && x.g === g);
            const somme = (st?: string) =>
              ici
                .filter((x) => !st || x.statut === st)
                .reduce((n, x) => n + x.n, 0);
            return [
              g,
              {
                total: somme(),
                aTraiter: somme('A_TRAITER'),
                affectes: somme('AFFECTE'),
              },
            ];
          }),
        ),
        aDeporter: aDeporter.find((x) => x.lot === l.id)?.n ?? 0,
      };
    });
  }

  async modifierLot(
    u: UtilisateurConnecte,
    id: number,
    dto: Partial<
      Pick<
        LotPublication,
        | 'dateSignatureArretes'
        | 'dateSignatureDecrets'
        | 'dateReception'
        | 'observation'
        | 'archive'
      >
    >,
  ) {
    const lot = await this.lots.findOne({ where: { id } });
    if (!lot) throw new NotFoundException('Lot introuvable');
    await this.lots.update(id, dto);
    await this.journal.log(u, 'MODIFICATION_LOT', 'lot_publication', id, dto);
    return this.lots.findOne({ where: { id } });
  }

  /* ------------------------------ Agents ------------------------------ */

  async listeAgents(f: {
    recherche?: string;
    lot?: number;
    texte?: 'recu' | 'attente';
    feuille?: string;
    anomalies?: boolean;
    page?: number;
    taille?: number;
  }) {
    const taille = Math.min(f.taille ?? 50, 500);
    const page = Math.max(f.page ?? 1, 1);
    const q = this.agents
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.departement', 'd')
      .leftJoinAndSelect('a.lotPublication', 'l')
      .orderBy('a.nomNormalise', 'ASC');
    if (f.recherche) {
      const r = `%${normaliser(f.recherche)}%`;
      q.andWhere(
        new Brackets((w) =>
          w
            .where('a.nomNormalise LIKE :r', { r })
            .orWhere('a.numeroTexte = :n', { n: f.recherche!.trim() }),
        ),
      );
    }
    if (f.lot) q.andWhere('l.numero = :lot', { lot: f.lot });
    if (f.texte === 'recu') q.andWhere('a.lotPublicationId IS NOT NULL');
    if (f.texte === 'attente') q.andWhere('a.lotPublicationId IS NULL');
    if (f.feuille) q.andWhere('a.feuille = :fe', { fe: f.feuille });
    if (f.anomalies) q.andWhere('jsonb_array_length(a.anomalies) > 0');
    const [items, total] = await q
      .skip((page - 1) * taille)
      .take(taille)
      .getManyAndCount();
    const p = this.parametresCalcul();
    const regles = await this.reglesParCode();
    return {
      total,
      page,
      taille,
      items: items.map((a) => ({
        ...a,
        // Seulement ce qui est encore vrai d'après la fiche (jamais un message périmé)
        anomalies: anomaliesAJour(a, (c) => regles.get(c)?.cycle),
        ...estContractuel(
          a,
          p,
          a.diplomeCode ? regles.get(a.diplomeCode)?.categorie : null,
        ),
        reference: referenceTexte(a).reference,
      })),
    };
  }

  /** Toute la base des recrutés, dans l'ordre de la fiche de suivi. */
  async toutesLesFiches() {
    return this.agents.find({
      order: {
        feuille: 'ASC',
        quota: 'ASC',
        numeroOrdre: 'ASC',
        nomNormalise: 'ASC',
      },
    });
  }

  async statistiquesAgents() {
    const [r] = await this.agents.query<Record<string, number>[]>(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE "lotPublicationId" IS NOT NULL)::int AS "textesRecus",
        count(*) FILTER (WHERE "lotPublicationId" IS NULL)::int AS "enAttente",
        count(*) FILTER (WHERE jsonb_array_length(anomalies) > 0)::int AS "avecAnomalies",
        count(*) FILTER (WHERE feuille = 'QUOTA_AUTRES')::int AS "quotaAutres"
      FROM agent`);
    return r;
  }

  async modifierAgent(
    u: UtilisateurConnecte,
    id: string,
    dto: Partial<
      Pick<
        Agent,
        | 'dateNaissance'
        | 'departementId'
        | 'diplomeCode'
        | 'numeroTexte'
        | 'typeTexte'
        | 'dateSignatureTexte'
        | 'contractuelForce'
        | 'anomaliesVerifiees'
      >
    >,
  ) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a) throw new NotFoundException('Agent introuvable');
    const aff = await this.affectations.findOne({
      where: { agentId: id },
      loadEagerRelations: false,
    });
    // Déclarer une anomalie vérifiée ne change rien à la note : permis même après validation
    const seulementVerification = Object.keys(dto).every(
      (k) => k === 'anomaliesVerifiees',
    );
    if (aff?.statut === 'AFFECTE' && !seulementVerification)
      throw new BadRequestException(
        'Agent déjà dans une note validée : modification impossible',
      );

    const avant: Record<string, unknown> = {};
    for (const k of Object.keys(dto))
      avant[k] = (a as unknown as Record<string, unknown>)[k];
    const { anomaliesVerifiees: verifiees, ...champs } = dto;
    const maj: Partial<Agent> = { ...champs };
    // Les anomalies corrigées à la main disparaissent
    let anomalies = a.anomalies ?? [];
    if ('numeroTexte' in dto && dto.numeroTexte)
      anomalies = anomalies.filter(
        (x) => !x.startsWith('Lot de publication sans numéro'),
      );
    if (verifiees?.length) {
      const motif = (x: string) => x.split(' (')[0];
      const aRetirer = new Set(verifiees.map(motif));
      anomalies = anomalies.filter((x) => !aRetirer.has(motif(x)));
      maj.anomaliesVerifiees = [
        ...new Set([...(a.anomaliesVerifiees ?? []), ...aRetirer]),
      ];
      // Cycle : la règle du diplôme fait foi, la fiche est alignée sur elle
      if ([...aRetirer].some((x) => x.startsWith('Cycle de la base'))) {
        const regle = a.diplomeCode
          ? await this.regles.findOne({ where: { code: a.diplomeCode } })
          : null;
        if (regle) maj.cycleBrut = LIBELLE_CYCLE[regle.cycle as Cycle];
      }
    }
    if ('dateNaissance' in dto && dto.dateNaissance)
      anomalies = anomalies.filter((x) => !x.startsWith('Date de naissance'));
    if ('departementId' in dto && dto.departementId)
      anomalies = anomalies.filter((x) => !x.startsWith('Département'));
    if ('diplomeCode' in dto && dto.diplomeCode)
      anomalies = anomalies.filter((x) => !x.startsWith('Diplôme'));
    maj.anomalies = anomaliesAJour({ ...a, ...maj, anomalies });
    await this.agents.update(id, maj);

    // N° de texte corrigé : l'ancien numéro n'est peut-être plus partagé ; l'alerte « N° de texte
    // partagé » disparaît alors aussi de l'autre fiche
    if (
      'numeroTexte' in dto &&
      dto.numeroTexte &&
      a.numeroTexte &&
      cleTexte(dto.numeroTexte) !== cleTexte(a.numeroTexte)
    ) {
      const ancien = cleTexte(a.numeroTexte);
      const memes = (
        await this.agents.find({
          select: ['id', 'numeroTexte', 'anomalies'],
          where: { id: Not(id) },
          loadEagerRelations: false,
        })
      ).filter((x) => cleTexte(x.numeroTexte) === ancien);
      if (memes.length <= 1)
        for (const x of memes) {
          const restantes = (x.anomalies ?? []).filter(
            (y) =>
              !(
                y.startsWith(TEXTE_PARTAGE) &&
                cleTexte(/^[^(]*\(([^,)]+)/.exec(y)?.[1]) === ancien
              ),
          );
          if (restantes.length !== (x.anomalies ?? []).length)
            await this.agents.update(x.id, { anomalies: restantes });
        }
    }

    // Changement de diplôme -> type de note par défaut recalculé
    if (aff && dto.diplomeCode && dto.diplomeCode !== a.diplomeCode) {
      const regle = await this.regles.findOne({
        where: { code: dto.diplomeCode },
      });
      if (regle)
        await this.affectations.update(aff.id, { typeNote: regle.typeNote });
    }
    // Département corrigé dans la base : l'affectation pas encore dans une note validée suit
    // (la note en préparation se recalcule ; une note validée ne change plus)
    if (
      aff &&
      aff.statut === 'A_TRAITER' &&
      'departementId' in dto &&
      dto.departementId &&
      dto.departementId !== aff.departementId
    ) {
      const dep = await this.deps.findOne({ where: { id: dto.departementId } });
      await this.affectations.update(aff.id, {
        departementId: dto.departementId,
        // L'établissement était dans l'ancien département
        etablissement: null,
        ...(aff.typeNote === 'PERS_ADM' && dep
          ? { structure: `DDEPPSA ${dep.nom}` }
          : {}),
      });
    }

    // Type de texte ou diplôme changé (décret PM ↔ PR…) : la personne change de lot, même paquet
    if (
      a.lotPublicationId &&
      ((dto.typeTexte && dto.typeTexte !== a.typeTexte) ||
        (dto.diplomeCode && dto.diplomeCode !== a.diplomeCode))
    ) {
      const [p] = await this.lots.query<{ date: string | null }[]>(
        `SELECT p."dateReception"::text AS date FROM lot_publication l
         JOIN paquet_reception p ON p.id = l."paquetId" WHERE l.id = $1`,
        [a.lotPublicationId],
      );
      if (p) {
        await this.lotsReception.ranger([{ id, date: p.date }]);
        await this.lotsReception.nettoyer();
      }
    }

    await this.journal.log(u, 'CORRECTION_AGENT', 'agent', id, {
      avant,
      apres: dto,
    });
    return this.agents.findOne({ where: { id } });
  }

  /** Nombre de fiches par anomalie (pour les corrections groupées). */
  async resumeAnomalies() {
    return this.agents.query<{ anomalie: string; n: number }[]>(`
      SELECT split_part(x, ' (', 1) AS anomalie, count(*)::int AS n
      FROM agent, jsonb_array_elements_text(anomalies) x GROUP BY 1 ORDER BY 2 DESC`);
  }

  /** Applique la règle du diplôme à toutes les fiches dont le cycle Excel diffère. */
  async appliquerReglesCycle(u: UtilisateurConnecte) {
    const ANOMALIE = 'Cycle de la base différent de celui du diplôme';
    const r = await this.agents.query<unknown[]>(
      `UPDATE agent a SET
         anomalies = a.anomalies - $1,
         "anomaliesVerifiees" = CASE WHEN a."anomaliesVerifiees" ? $1 THEN a."anomaliesVerifiees"
                                     ELSE a."anomaliesVerifiees" || to_jsonb($1::text) END,
         "cycleBrut" = CASE r.cycle WHEN 'PRESCOLAIRE' THEN 'Préscolaire' WHEN 'PRIMAIRE' THEN 'Primaire'
                         WHEN 'COLLEGE' THEN 'Collège' WHEN 'LYCEE' THEN 'Lycée' ELSE 'Administration' END
       FROM regle_diplome r
       WHERE r.code = a."diplomeCode" AND a.anomalies ? $1
       RETURNING a.id`,
      [ANOMALIE],
    );
    const n = Array.isArray(r[0]) ? (r[0] as unknown[]).length : r.length;
    await this.journal.log(u, 'CORRECTION_CYCLES', 'agent', null, {
      fiches: n,
    });
    return { fiches: n };
  }

  /* --------------------------- Affectations --------------------------- */

  private requete(f: FiltreAffectations) {
    const q = this.affectations
      .createQueryBuilder('f')
      .leftJoinAndSelect('f.agent', 'a')
      .leftJoinAndSelect('a.lotPublication', 'l')
      .leftJoinAndSelect('a.departement', 'ad')
      .leftJoinAndSelect('f.departement', 'd');
    if (f.lot) q.andWhere('l.numero = :lot', { lot: f.lot });
    if (f.lots)
      q.andWhere('l.numero IN (:...lots)', {
        lots: f.lots.length ? f.lots : [-1],
      });
    if (f.groupes?.length)
      q.andWhere(`(${sqlGroupeQuota('a')}) IN (:...groupes)`, {
        groupes: f.groupes,
      });
    if (f.lotsIds)
      q.andWhere('a.lotPublicationId IN (:...lotsIds)', {
        lotsIds: f.lotsIds.length ? f.lotsIds : [-1],
      });
    if (f.typeNote) q.andWhere('f.typeNote = :t', { t: f.typeNote });
    if (f.departementId)
      q.andWhere('f.departementId = :d', { d: f.departementId });
    if (f.statut) q.andWhere('f.statut = :s', { s: f.statut });
    if (f.repartitionId)
      q.andWhere('a.repartitionId = :rep', { rep: f.repartitionId });
    if (f.recherche) {
      const r = `%${normaliser(f.recherche)}%`;
      q.andWhere(
        new Brackets((w) =>
          w
            .where('a.nomNormalise LIKE :r', { r })
            .orWhere('a.numeroTexte = :n', { n: f.recherche!.trim() }),
        ),
      );
    }
    return q;
  }

  async enrichir(liste: Affectation[]) {
    const regles = await this.reglesParCode();
    const p = this.parametresCalcul();
    const attente = new Set(
      (
        await this.recos.find({
          where: { statut: 'EN_ATTENTE', operation: 'AFFECTATION' },
          select: ['affectationId'],
          loadEagerRelations: false,
        })
      ).map((r) => r.affectationId),
    );
    // Personnes déjà dans une note signée hors du système (fichier de contrôle des affectations)
    const dejaAffectes = new Map<string, string>();
    const ids = liste.map((a) => a.agentId);
    for (let i = 0; i < ids.length; i += 1000)
      for (const r of await this.refsNotes.find({
        where: { agentId: In(ids.slice(i, i + 1000)) },
        select: ['agentId', 'brut'],
      }))
        dejaAffectes.set(r.agentId, r.brut);
    const doublons = await this.doublonsActifs(liste);
    return liste.map((aff) => {
      const d = deriver(aff, regles, p);
      const doublon = doublons.get(aff.agentId);
      if (aff.statut === 'A_TRAITER' && doublon)
        d.bloquants.push(
          `Doublon probable avec ${doublon} : cliquez pour comparer les deux fiches (supprimer celle en trop, ou deux personnes différentes)`,
        );
      if (attente.has(aff.id))
        d.bloquants.push('Recommandation en attente de décision du DG');
      if (aff.statut === 'A_TRAITER' && dejaAffectes.has(aff.agentId))
        d.bloquants.push(
          `Déjà dans la note n° ${dejaAffectes.get(aff.agentId)} (signée hors du système)`,
        );
      return {
        ...aff,
        derive: d,
        recommandationEnAttente: attente.has(aff.id),
      };
    });
  }

  /**
   * Fiches signalées « Ressemble à NOM » dont l'autre fiche est encore à affecter ou affectée :
   * la même personne ne doit pas sortir dans deux notes. Le blocage tombe dès que l'une des
   * deux est retirée de la note (exclue) ou que l'anomalie est déclarée vérifiée.
   */
  private async doublonsActifs(liste: Affectation[]) {
    const res = new Map<string, string>();
    const suspects = liste.filter((x) =>
      (x.agent?.anomalies ?? []).some((a) => a.startsWith(RESSEMBLE)),
    );
    if (!suspects.length) return res;
    const noms = new Set(
      suspects.flatMap((x) =>
        x.agent.anomalies
          .filter((a) => a.startsWith(RESSEMBLE))
          .map((a) => normaliser(nomRessemblant(a))),
      ),
    );
    const autres = await this.agents.query<
      {
        id: string;
        nom: string;
        nomNormalise: string;
        lot: string | null;
        verifiees: string[] | null;
      }[]
    >(
      `SELECT a.id, a."nomComplet" AS nom, a."nomNormalise", a."anomaliesVerifiees" AS verifiees,
              ${sqlLibelleLot('l')} AS lot
         FROM agent a
         JOIN affectation f ON f."agentId" = a.id AND f.statut <> 'EXCLU'
         LEFT JOIN lot_publication l ON l.id = f."lotPublicationId"
        WHERE a."nomNormalise" = ANY($1)`,
      [[...noms]],
    );
    for (const x of suspects)
      for (const a of x.agent.anomalies.filter((y) =>
        y.startsWith(RESSEMBLE),
      )) {
        const autre = autres.find(
          (o) =>
            o.id !== x.agentId &&
            o.nomNormalise === normaliser(nomRessemblant(a)) &&
            // « Ce n'est pas la même personne », déclaré sur l'autre fiche, vaut pour les deux
            !(o.verifiees ?? []).includes(`${RESSEMBLE}${x.agent.nomComplet}`),
        );
        if (autre) {
          res.set(
            x.agentId,
            `${autre.nom}${autre.lot ? ` (${autre.lot})` : ''}`,
          );
          break;
        }
      }
    return res;
  }

  async listeAffectations(f: FiltreAffectations) {
    const liste = await this.requete(f)
      .orderBy('d.ordre', 'ASC', 'NULLS LAST')
      .addOrderBy('a.nomNormalise')
      .getMany();
    let res = await this.enrichir(liste);
    if (f.probleme === 'bloquant')
      res = res.filter(
        (x) => x.derive.bloquants.length && x.statut === 'A_TRAITER',
      );
    if (f.probleme === 'avertissement')
      res = res.filter((x) => x.derive.avertissements.length);
    return res;
  }

  async resumeLot(lot: number) {
    const liste = await this.listeAffectations({ lot });
    const parType: Record<
      string,
      {
        total: number;
        prets: number;
        bloques: number;
        exclus: number;
        affectes: number;
      }
    > = {};
    for (const x of liste) {
      const t = (parType[x.typeNote] ??= {
        total: 0,
        prets: 0,
        bloques: 0,
        exclus: 0,
        affectes: 0,
      });
      t.total++;
      if (x.statut === 'EXCLU') t.exclus++;
      else if (x.statut === 'AFFECTE') t.affectes++;
      else if (x.derive.bloquants.length) t.bloques++;
      else t.prets++;
    }
    return parType;
  }

  /**
   * Résumé de lots choisis ensemble (« Décrets lots III et IV ») et de groupes de quota : par
   * groupe et par type de note, les personnes prêtes, à compléter (avec la raison), affectées.
   */
  async resumeSelection(lots: number[], groupes: string[]) {
    const liste = await this.listeAffectations({ lots, groupes });
    const vide = () => ({
      total: 0,
      prets: 0,
      bloques: 0,
      exclus: 0,
      affectes: 0,
    });
    const parType: Record<string, ReturnType<typeof vide>> = {};
    const parGroupe: Record<string, ReturnType<typeof vide>> = {};
    const raisons: Record<string, number> = {};
    let aDeporter = 0;
    let aRepartir = 0;
    let sansSpecialite = 0;
    for (const x of liste) {
      if (
        x.statut === 'A_TRAITER' &&
        !x.noteId &&
        ['PRIMAIRE', 'PRESCOLAIRE'].includes(x.typeNote) &&
        !x.specialite?.trim()
      )
        sansSpecialite++;
      const t = (parType[x.typeNote] ??= vide());
      const g = (parGroupe[groupeQuota(x.agent)] ??= vide());
      for (const c of [t, g]) {
        c.total++;
        if (x.statut === 'EXCLU') c.exclus++;
        else if (x.statut === 'AFFECTE') c.affectes++;
        else if (x.derive.bloquants.length) c.bloques++;
        else c.prets++;
      }
      if (x.statut === 'A_TRAITER')
        for (const r of x.derive.bloquants) {
          const k = r.split(' (')[0];
          raisons[k] = (raisons[k] ?? 0) + 1;
        }
      if (x.statut === 'AFFECTE' && !x.deporteLe) aDeporter++;
      // Quota « Autres » sans département retenu : à répartir (DG, 30/10/2026)
      if (
        x.statut === 'A_TRAITER' &&
        x.agent.feuille === 'QUOTA_AUTRES' &&
        !x.departementId &&
        !x.agent.departementId
      )
        aRepartir++;
    }
    return {
      parType,
      parGroupe,
      raisons,
      aDeporter,
      aRepartir,
      sansSpecialite,
    };
  }

  async obtenir(id: string) {
    const aff = await this.affectations.findOne({ where: { id } });
    if (!aff) throw new NotFoundException('Affectation introuvable');
    return aff;
  }

  private verifierModifiable(aff: Affectation) {
    if (aff.statut === 'AFFECTE')
      throw new BadRequestException(
        'Cet agent figure déjà dans une note validée par le DG',
      );
  }

  async modifier(
    u: UtilisateurConnecte,
    id: string,
    dto: Partial<
      Pick<Affectation, 'specialite' | 'structure' | 'etablissement' | 'obs'>
    >,
  ) {
    const aff = await this.obtenir(id);
    this.verifierModifiable(aff);
    const maj: Partial<Affectation> = { traitePar: u.initiales ?? u.nom };
    for (const k of [
      'specialite',
      'structure',
      'etablissement',
      'obs',
    ] as const)
      if (k in dto) maj[k] = dto[k]?.toString().trim() || null;
    await this.affectations.update(id, maj);
    await this.journal.log(
      u,
      'MODIFICATION_AFFECTATION',
      'affectation',
      id,
      dto,
    );
    return (await this.enrichir([await this.obtenir(id)]))[0];
  }

  async exclure(u: UtilisateurConnecte, id: string, motif: string) {
    const aff = await this.obtenir(id);
    this.verifierModifiable(aff);
    if (!motif?.trim())
      throw new BadRequestException("Le motif d'exclusion est obligatoire");
    await this.affectations.update(id, {
      statut: 'EXCLU',
      motifExclusion: motif.trim(),
      traitePar: u.initiales ?? u.nom,
    });
    await this.journal.log(u, 'EXCLUSION_AFFECTATION', 'affectation', id, {
      motif,
    });
    return { ok: true };
  }

  async reintegrer(u: UtilisateurConnecte, id: string) {
    const aff = await this.obtenir(id);
    if (aff.statut !== 'EXCLU')
      throw new BadRequestException("Cet agent n'est pas exclu");
    await this.affectations.update(id, {
      statut: 'A_TRAITER',
      motifExclusion: null,
    });
    await this.journal.log(u, 'REINTEGRATION_AFFECTATION', 'affectation', id);
    return { ok: true };
  }

  /* ------------------------- Recommandations -------------------------- */

  async proposerRecommandation(
    u: UtilisateurConnecte,
    affectationId: string,
    dto: {
      typeNote?: string | null;
      departementId?: number | null;
      structure?: string | null;
      etablissement?: string | null;
      origine: string;
      motif?: string | null;
    },
  ) {
    const aff = await this.obtenir(affectationId);
    this.verifierModifiable(aff);
    if (!dto.origine?.trim())
      throw new BadRequestException(
        "L'origine de la recommandation est obligatoire",
      );
    if (dto.typeNote && !(dto.typeNote in NOTES_AFFECTATION))
      throw new BadRequestException('Type de note invalide');
    if (
      await this.recos.findOne({
        where: { affectationId, statut: 'EN_ATTENTE' },
        loadEagerRelations: false,
      })
    )
      throw new BadRequestException(
        'Une recommandation est déjà en attente pour cet agent',
      );
    const typeNote = dto.typeNote || null;
    if (typeNote === 'PERS_ADM' && !dto.structure?.trim() && !aff.structure)
      throw new BadRequestException('Précisez la structure administrative');
    if (typeNote === 'ETS' && !dto.etablissement?.trim())
      throw new BadRequestException("Précisez l'établissement");
    if (!typeNote && !dto.departementId && !dto.structure && !dto.etablissement)
      throw new BadRequestException('La recommandation ne change rien');

    const r = await this.recos.save({
      operation: 'AFFECTATION',
      affectationId,
      personne: aff.agent?.nomComplet ?? null,
      etape: etapeInitiale(u.role),
      typeNote,
      departementId: dto.departementId ?? null,
      structure: dto.structure?.trim() || null,
      etablissement: dto.etablissement?.trim() || null,
      origine: dto.origine.trim(),
      motif: dto.motif?.trim() || null,
      statut: 'EN_ATTENTE',
      soumisPar: u.nom,
      avant: {
        typeNote: aff.typeNote,
        departementId: aff.departementId,
        structure: aff.structure,
        etablissement: aff.etablissement,
      },
    });
    await this.journal.log(
      u,
      'RECOMMANDATION_PROPOSEE',
      'affectation',
      affectationId,
      dto,
    );
    return r;
  }

  async listeRecommandations(statut?: string) {
    const liste = await this.recos.find({
      where: {
        operation: 'AFFECTATION',
        ...(statut ? { statut: statut as Recommandation['statut'] } : {}),
      },
      order: { creeLe: 'DESC' },
    });
    const enrichies = await this.enrichir(liste.map((r) => r.affectation!));
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    return liste.map((r, i) => ({
      ...r,
      affectation: enrichies[i],
      departementPropose: r.departementId ? deps.get(r.departementId) : null,
      departementAvant: r.avant?.departementId
        ? deps.get(r.avant.departementId as number)
        : null,
    }));
  }

  async deciderRecommandation(
    u: UtilisateurConnecte,
    id: string,
    decision: 'VALIDEE' | 'REJETEE',
    commentaire?: string,
  ) {
    const r = await this.recos.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Recommandation introuvable');
    if (r.statut !== 'EN_ATTENTE')
      throw new BadRequestException('Recommandation déjà traitée');
    if (decision === 'VALIDEE') {
      const aff = await this.obtenir(r.affectationId!);
      this.verifierModifiable(aff);
      const maj: Partial<Affectation> = {
        origine: [aff.origine, r.origine].filter(Boolean).join(' ; '),
      };
      if (r.typeNote) maj.typeNote = r.typeNote;
      if (r.departementId) maj.departementId = r.departementId;
      // Autre département sans établissement précisé : l'ancien établissement ne vaut plus
      if (
        r.departementId &&
        r.departementId !== aff.departementId &&
        !r.etablissement
      )
        maj.etablissement = null;
      if (r.structure) maj.structure = r.structure;
      if (r.etablissement) maj.etablissement = r.etablissement;
      if (r.typeNote === 'ETS' && !aff.obs) maj.obs = 'Ens. actif';
      if (maj.typeNote === 'PERS_ADM' && !maj.structure && !aff.structure) {
        const dep = await this.deps.findOne({
          where: { id: maj.departementId ?? aff.departementId ?? -1 },
        });
        if (dep) maj.structure = `DDEPPSA ${dep.nom}`;
      }
      await this.affectations.update(aff.id, maj);
    }
    await this.recos.update(id, {
      statut: decision,
      decidePar: u.nom,
      dateDecision: new Date(),
      commentaireDecision: commentaire?.trim() || null,
    });
    await this.journal.log(
      u,
      decision === 'VALIDEE'
        ? 'RECOMMANDATION_VALIDEE'
        : 'RECOMMANDATION_REJETEE',
      'affectation',
      r.affectationId,
      { commentaire },
    );
    return { ok: true };
  }
}
