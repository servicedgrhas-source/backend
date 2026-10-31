import { AnomaliesService } from '../common/anomalies';
import { libelleLot } from '../common/lots';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  estContractuel,
  regleDeLAgent,
  salaireBrut,
} from '../affectation/calcul';
import { AffectationService } from '../affectation/affectation.service';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  NOTES_AFFECTATION,
  type TypeNoteAffectation,
} from '../common/referentiels';
import { JournalService } from '../core/core.service';
import {
  Affectation,
  Agent,
  Departement,
  Enveloppe,
  Repartition,
} from '../entities';

export interface EnveloppeDto {
  montantAnnuel: number;
  placesCatI?: number | null;
  placesCatII?: number | null;
  placesCatIII?: number | null;
}

type Etape = 'SAISIE' | 'ENVOYEE' | 'TEXTE_RECU';
const ETAPES: Record<Etape, string> = {
  SAISIE: 'Saisies, pas encore envoyées à la FP',
  ENVOYEE: 'Envoyées à la FP, texte attendu',
  TEXTE_RECU: 'Texte de la FP reçu',
};
const CATEGORIES = ['I', 'II', 'III'] as const;

export interface Alerte {
  niveau: 'rouge' | 'jaune';
  perimetre: string;
  texte: string;
}

const nf = new Intl.NumberFormat('fr-FR');

@Injectable()
export class PilotageService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(Enveloppe)
    private readonly enveloppes: Repository<Enveloppe>,
    @InjectRepository(Repartition)
    private readonly repartitions: Repository<Repartition>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly affectation: AffectationService,
    private readonly anomalies: AnomaliesService,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------ Incidences et enveloppe ------------------------ */

  /** Quotas présents dans la base (« 2026 », « 2025 »…) et le quota « Autres ». */
  async perimetres() {
    const r = await this.agents.query<{ quota: number }[]>(
      `SELECT DISTINCT quota FROM agent WHERE feuille = 'MEPPSA' AND quota IS NOT NULL ORDER BY quota DESC`,
    );
    return [...r.map((x) => String(x.quota)), 'AUTRES'];
  }

  /** Agents d'un périmètre qui pèsent sur l'enveloppe (hors rejetés et exclus). */
  private async agentsDuPerimetre(perimetre: string) {
    const where =
      perimetre === 'AUTRES'
        ? { feuille: 'QUOTA_AUTRES' }
        : { feuille: 'MEPPSA', quota: Number(perimetre) };
    const liste = await this.agents.find({
      where,
      select: [
        'id',
        'diplomeCode',
        'diplomeBrut',
        'dateNaissance',
        'contractuelForce',
        'origineFiche',
        'etatFiche',
        'transmissionNumero',
        'lotPublicationId',
        'contentieuxAge',
      ],
      loadEagerRelations: false,
    });
    const exclus = new Set(
      (
        await this.affectations.find({
          where: { statut: 'EXCLU' },
          select: ['agentId'],
          loadEagerRelations: false,
        })
      ).map((f) => f.agentId),
    );
    return {
      comptes: liste.filter(
        (a) =>
          !exclus.has(a.id) &&
          a.contentieuxAge !== 'REJETE' &&
          a.contentieuxAge !== 'EN_ATTENTE',
      ),
      contentieux: liste.filter((a) => a.contentieuxAge === 'EN_ATTENTE')
        .length,
      exclus: liste.filter((a) => exclus.has(a.id)).length,
    };
  }

  private etape(a: Agent): Etape {
    if (a.lotPublicationId) return 'TEXTE_RECU';
    if (a.origineFiche === 'SAISIE' && !a.transmissionNumero) return 'SAISIE';
    return 'ENVOYEE';
  }

  async tableau(perimetre: string) {
    const regles = await this.affectation.reglesParCode();
    const p = this.affectation.parametresCalcul();
    const env = await this.enveloppes.findOne({ where: { perimetre } });
    const { comptes, contentieux, exclus } =
      await this.agentsDuPerimetre(perimetre);

    const parDiplome = new Map<
      string,
      {
        diplome: string;
        categorie: string | null;
        echelle: number | null;
        indice: number | null;
        effectif: number;
        contractuels: number;
        mensuel: number;
      }
    >();
    const parEtape = new Map<Etape, { effectif: number; annuel: number }>();
    let sansIndice = 0;
    // Validées, pas encore parties : ce que coûtera le prochain envoi à la FP
    const pretes = { effectif: 0, annuel: 0 };
    for (const a of comptes) {
      const r = regleDeLAgent(a, regles);
      const s = salaireBrut(r?.indice, p) ?? 0;
      if (!r?.indice) sansIndice++;
      // Grade choisi à la demande : une ligne à part (autre catégorie, autre indice)
      const cle = r
        ? `${r.code}|${a.gradeChoisi?.code ?? ''}`
        : `?${a.diplomeBrut ?? ''}`;
      const d = parDiplome.get(cle) ?? {
        diplome: r
          ? `${r.libelle}${a.gradeChoisi ? ` (grade ${a.gradeChoisi.abreviation})` : ''}`
          : `${a.diplomeBrut ?? 'Diplôme inconnu'} (non reconnu)`,
        categorie: r?.categorie ?? null,
        echelle: r?.echelle ?? null,
        indice: r?.indice ?? null,
        effectif: 0,
        contractuels: 0,
        mensuel: 0,
      };
      d.effectif++;
      d.mensuel += s;
      if (estContractuel(a, p, r?.categorie).contractuel) d.contractuels++;
      parDiplome.set(cle, d);
      const e = parEtape.get(this.etape(a)) ?? { effectif: 0, annuel: 0 };
      e.effectif++;
      e.annuel += s * 12;
      parEtape.set(this.etape(a), e);
      if (
        a.origineFiche === 'SAISIE' &&
        a.etatFiche === 'VALIDEE' &&
        !a.transmissionNumero
      ) {
        pretes.effectif++;
        pretes.annuel += s * 12;
      }
    }
    const diplomes = [...parDiplome.values()]
      .map((d) => ({ ...d, annuel: d.mensuel * 12 }))
      .sort(
        (a, b) =>
          (a.categorie ?? 'Z').localeCompare(b.categorie ?? 'Z') ||
          (a.echelle ?? 9) - (b.echelle ?? 9) ||
          b.effectif - a.effectif,
      );
    const places: Record<string, number | null> = {
      I: env?.placesCatI ?? null,
      II: env?.placesCatII ?? null,
      III: env?.placesCatIII ?? null,
    };
    const categories = CATEGORIES.map((c) => {
      const ds = diplomes.filter((d) => d.categorie === c);
      const effectif = ds.reduce((n, d) => n + d.effectif, 0);
      return {
        categorie: c,
        effectif,
        places: places[c],
        mensuel: ds.reduce((n, d) => n + d.mensuel, 0),
        annuel: ds.reduce((n, d) => n + d.annuel, 0),
      };
    });
    const total = {
      effectif: comptes.length,
      mensuel: diplomes.reduce((n, d) => n + d.mensuel, 0),
      annuel: diplomes.reduce((n, d) => n + d.annuel, 0),
    };
    const montant = Number(env?.montantAnnuel ?? 0);
    return {
      perimetre,
      libelle: this.libelle(perimetre),
      pointIndiciaire: p.pointIndiciaire,
      enveloppe: env
        ? {
            montantAnnuel: montant,
            placesCatI: env.placesCatI,
            placesCatII: env.placesCatII,
            placesCatIII: env.placesCatIII,
            modifiePar: env.modifiePar,
            modifieLe: env.modifieLe,
          }
        : null,
      total,
      pretes,
      reste: montant ? montant - total.annuel : null,
      taux: montant ? total.annuel / montant : null,
      etapes: (Object.keys(ETAPES) as Etape[]).map((e) => ({
        etape: e,
        libelle: ETAPES[e],
        ...(parEtape.get(e) ?? { effectif: 0, annuel: 0 }),
      })),
      categories,
      diplomes,
      sansIndice,
      contentieux,
      exclus,
      alertes: this.alertesDe(
        perimetre,
        montant,
        total.annuel,
        categories,
        sansIndice,
      ),
    };
  }

  private libelle(perimetre: string) {
    return perimetre === 'AUTRES' ? 'Quota « Autres »' : `Quota ${perimetre}`;
  }

  private alertesDe(
    perimetre: string,
    montant: number,
    annuel: number,
    categories: {
      categorie: string;
      effectif: number;
      places: number | null;
    }[],
    sansIndice: number,
  ): Alerte[] {
    const a: Alerte[] = [];
    const lib = this.libelle(perimetre);
    if (montant && annuel > montant)
      a.push({
        niveau: 'rouge',
        perimetre,
        texte: `${lib} : l’incidence annuelle (${nf.format(annuel)} FCFA) dépasse l’enveloppe de ${nf.format(annuel - montant)} FCFA.`,
      });
    else if (montant && annuel >= montant * 0.9)
      a.push({
        niveau: 'jaune',
        perimetre,
        texte: `${lib} : ${Math.round((100 * annuel) / montant)} % de l’enveloppe déjà consommés (il reste ${nf.format(montant - annuel)} FCFA).`,
      });
    for (const c of categories)
      if (c.places !== null && c.effectif > c.places)
        a.push({
          niveau: 'rouge',
          perimetre,
          texte: `${lib} : catégorie ${c.categorie}, ${c.effectif} recrutés pour ${c.places} places autorisées (${c.effectif - c.places} de trop).`,
        });
    if (sansIndice)
      a.push({
        niveau: 'jaune',
        perimetre,
        texte: `${lib} : ${sansIndice} recruté(s) sans indice (diplôme non reconnu ou grade sans indice) : l’incidence est sous-estimée.`,
      });
    return a;
  }

  /** Alertes de tous les quotas dont l'enveloppe est renseignée (tableau de bord du DG). */
  async alertes() {
    const liste: Alerte[] = [];
    for (const e of await this.enveloppes.find())
      if (
        Number(e.montantAnnuel) ||
        e.placesCatI ||
        e.placesCatII ||
        e.placesCatIII
      )
        liste.push(
          ...(await this.tableau(e.perimetre)).alertes.filter(
            (a) => a.niveau === 'rouge' || !a.texte.includes('sans indice'),
          ),
        );
    return liste;
  }

  async definirEnveloppe(
    u: UtilisateurConnecte,
    perimetre: string,
    dto: EnveloppeDto,
  ) {
    if (
      !(await this.perimetres()).includes(perimetre) &&
      !/^\d{4}$/.test(perimetre)
    )
      throw new BadRequestException('Quota inconnu');
    if (!(dto.montantAnnuel >= 0))
      throw new BadRequestException("Indiquez le montant de l'enveloppe.");
    await this.enveloppes.save({
      perimetre,
      montantAnnuel: String(Math.round(dto.montantAnnuel)),
      placesCatI: dto.placesCatI ?? null,
      placesCatII: dto.placesCatII ?? null,
      placesCatIII: dto.placesCatIII ?? null,
      modifiePar: u.nom,
    });
    await this.journal.log(u, 'ENVELOPPE_MODIFIEE', undefined, null, {
      perimetre,
      ...dto,
    });
    return this.tableau(perimetre);
  }

  /* -------------- Répartition automatique du quota « Autres » -------------- */

  /** Personnes du quota « Autres » sans département, pas encore dans une note validée. */
  private async eligibles(texteRecu: boolean, lot?: number | number[]) {
    const q = this.agents
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.lotPublication', 'l')
      .leftJoin(Affectation, 'f', 'f."agentId" = a.id')
      .where("a.feuille = 'QUOTA_AUTRES'")
      .andWhere('a.departementId IS NULL')
      // Déjà placée (répartition précédente, département retenu saisi) : pas reproposée
      .andWhere('a.repartitionId IS NULL')
      .andWhere('f.departementId IS NULL')
      .andWhere("(a.contentieuxAge IS NULL OR a.contentieuxAge = 'APPROUVE')")
      .andWhere("(f.statut IS NULL OR f.statut = 'A_TRAITER')");
    if (texteRecu) q.andWhere('a.lotPublicationId IS NOT NULL');
    // Un lot, ou les lots choisis ensemble à l'écran des affectations
    if (Array.isArray(lot))
      q.andWhere('l.numero IN (:...lots)', { lots: lot.length ? lot : [-1] });
    else if (lot) q.andWhere('l.numero = :lot', { lot });
    return q.getMany();
  }

  /** Type de note de chaque personne (une seule requête pour toute la liste). */
  private async types(liste: Agent[]) {
    const regles = await this.affectation.reglesParCode();
    const affs = liste.length
      ? await this.affectations.find({
          where: { agentId: In(liste.map((a) => a.id)) },
          select: ['agentId', 'typeNote'],
          loadEagerRelations: false,
        })
      : [];
    const parAgent = new Map(affs.map((f) => [f.agentId, f.typeNote]));
    return new Map(
      liste.map((a) => [
        a.id,
        parAgent.get(a.id) ??
          (a.diplomeCode ? regles.get(a.diplomeCode)?.typeNote : null) ??
          'A_DEFINIR',
      ]),
    );
  }

  async etatRepartition(texteRecu: boolean, lot?: number | number[]) {
    const liste = await this.eligibles(texteRecu, lot);
    const types = await this.types(liste);
    const parType: Record<string, number> = {};
    for (const t of types.values()) parType[t] = (parType[t] ?? 0) + 1;
    const derniere = await this.repartitions.findOne({
      where: { annulee: false },
      order: { creeLe: 'DESC' },
    });
    return {
      eligibles: liste.length,
      parType: Object.entries(parType).map(([type, n]) => ({
        type,
        libelle:
          NOTES_AFFECTATION[type as TypeNoteAffectation]?.libelle ??
          'Type de note à définir',
        n,
      })),
      quotasPrecedents: derniere?.quotas ?? null,
      historique: (
        await this.repartitions.find({ order: { creeLe: 'DESC' }, take: 10 })
      ).map((r) => ({ ...r })),
    };
  }

  /**
   * Proposition : on tire au sort les personnes à placer, puis on les distribue
   * de façon que chaque département reçoive un mélange proportionnel des cycles
   * (« tourniquet pondéré » sur les quotas fixés par le DG). Rien n'est enregistré.
   */
  async proposer(
    quotas: Record<string, number>,
    texteRecu: boolean,
    lot?: number | number[],
    parCycle?: Record<string, Record<string, number>>,
  ) {
    const deps = new Map(
      (await this.deps.find()).map((d) => [String(d.id), d]),
    );
    if (parCycle) return this.proposerParCycle(parCycle, texteRecu, lot, deps);
    const demandes = Object.entries(quotas)
      .map(([id, n]) => [id, Math.max(0, Math.floor(Number(n) || 0))] as const)
      .filter(([id, n]) => n > 0 && deps.has(id));
    const total = demandes.reduce((s, [, n]) => s + n, 0);
    if (!total)
      throw new BadRequestException(
        'Indiquez au moins un département et un nombre de personnes.',
      );
    const liste = await this.eligibles(texteRecu, lot);
    if (total > liste.length)
      throw new BadRequestException(
        `Vous demandez ${total} places, mais seulement ${liste.length} personne(s) sont sans département.`,
      );
    // Tirage au sort des personnes retenues, puis regroupement par type de note
    const tirage = liste
      .map((a) => ({ a, r: Math.random() }))
      .sort((x, y) => x.r - y.r)
      .slice(0, total);
    const types = await this.types(tirage.map((x) => x.a));
    const avecType = tirage.map(({ a, r }) => ({
      a,
      r,
      type: types.get(a.id)!,
    }));
    avecType.sort((x, y) => x.type.localeCompare(y.type) || x.r - y.r);
    // Tourniquet pondéré : chaque département avance selon son quota restant
    const restant = new Map(demandes);
    const credit = new Map(demandes.map(([id]) => [id, 0]));
    const lignes = avecType.map(({ a, type }) => {
      let choisi = '';
      let somme = 0;
      for (const [id, n] of restant) {
        if (!n) continue;
        credit.set(id, credit.get(id)! + n);
        somme += n;
        if (!choisi || credit.get(id)! > credit.get(choisi)!) choisi = id;
      }
      credit.set(choisi, credit.get(choisi)! - somme);
      restant.set(choisi, restant.get(choisi)! - 1);
      return {
        agentId: a.id,
        nomComplet: a.nomComplet,
        diplome: a.diplomeBrut,
        lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
        type,
        departementId: Number(choisi),
        departement: deps.get(choisi)!.nom,
      };
    });
    const resume = demandes.map(([id, n]) => {
      const lesSiens = lignes.filter((l) => String(l.departementId) === id);
      const parType: Record<string, number> = {};
      for (const l of lesSiens) parType[l.type] = (parType[l.type] ?? 0) + 1;
      return {
        departementId: Number(id),
        departement: deps.get(id)!.nom,
        demandes: n,
        parType,
      };
    });
    return {
      eligibles: liste.length,
      places: total,
      restants: liste.length - total,
      resume,
      lignes: lignes.sort(
        (x, y) =>
          x.departement.localeCompare(y.departement, 'fr') ||
          x.nomComplet.localeCompare(y.nomComplet, 'fr'),
      ),
    };
  }

  /**
   * Proposition par département et par cycle : pour chaque cycle (type de note), les personnes
   * sont tirées au sort parmi celles de ce cycle, puis données aux départements selon les nombres
   * fixés (« Brazzaville : 30 primaire »). Rien n'est enregistré.
   */
  private async proposerParCycle(
    parCycle: Record<string, Record<string, number>>,
    texteRecu: boolean,
    lot: number | number[] | undefined,
    deps: Map<string, Departement>,
  ) {
    const demandes: { dep: string; type: string; n: number }[] = [];
    for (const [dep, parType] of Object.entries(parCycle))
      if (deps.has(dep))
        for (const [type, n] of Object.entries(parType ?? {})) {
          const k = Math.max(0, Math.floor(Number(n) || 0));
          if (k) demandes.push({ dep, type, n: k });
        }
    const total = demandes.reduce((s, d) => s + d.n, 0);
    if (!total)
      throw new BadRequestException(
        'Indiquez au moins un département, un cycle et un nombre de personnes.',
      );
    const liste = await this.eligibles(texteRecu, lot);
    const types = await this.types(liste);
    // Personnes de chaque cycle, mélangées au hasard
    const parType = new Map<string, Agent[]>();
    for (const a of liste
      .map((a) => ({ a, r: Math.random() }))
      .sort((x, y) => x.r - y.r)
      .map((x) => x.a)) {
      const t = types.get(a.id)!;
      (parType.get(t) ?? parType.set(t, []).get(t)!).push(a);
    }
    const libelle = (t: string) =>
      NOTES_AFFECTATION[t as TypeNoteAffectation]?.libelle ?? 'À définir';
    for (const t of new Set(demandes.map((d) => d.type))) {
      const voulu = demandes
        .filter((d) => d.type === t)
        .reduce((s, d) => s + d.n, 0);
      const dispo = parType.get(t)?.length ?? 0;
      if (voulu > dispo)
        throw new BadRequestException(
          `${libelle(t)} : ${voulu} place(s) demandée(s), mais seulement ${dispo} personne(s) de ce cycle sans département.`,
        );
    }
    const lignes = demandes.flatMap(({ dep, type, n }) =>
      parType
        .get(type)!
        .splice(0, n)
        .map((a) => ({
          agentId: a.id,
          nomComplet: a.nomComplet,
          diplome: a.diplomeBrut,
          lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
          type,
          departementId: Number(dep),
          departement: deps.get(dep)!.nom,
        })),
    );
    const resume = [...new Set(demandes.map((d) => d.dep))].map((id) => {
      const lesSiens = lignes.filter((l) => String(l.departementId) === id);
      const parTypeDep: Record<string, number> = {};
      for (const l of lesSiens)
        parTypeDep[l.type] = (parTypeDep[l.type] ?? 0) + 1;
      return {
        departementId: Number(id),
        departement: deps.get(id)!.nom,
        demandes: lesSiens.length,
        parType: parTypeDep,
      };
    });
    return {
      eligibles: liste.length,
      places: total,
      restants: liste.length - total,
      resume: resume.sort((x, y) =>
        x.departement.localeCompare(y.departement, 'fr'),
      ),
      lignes: lignes.sort(
        (x, y) =>
          x.departement.localeCompare(y.departement, 'fr') ||
          x.nomComplet.localeCompare(y.nomComplet, 'fr'),
      ),
    };
  }

  /** Validation du DG : les départements proposés sont enregistrés. */
  async appliquer(
    u: UtilisateurConnecte,
    quotas: Record<string, number>,
    lignes: { agentId: string; departementId: number }[],
  ) {
    if (!lignes.length)
      throw new BadRequestException('Aucune personne à placer.');
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d]));
    const agents = await this.agents.find({
      where: { id: In(lignes.map((l) => l.agentId)) },
      loadEagerRelations: false,
    });
    const libres = new Set(
      agents
        .filter(
          (a) =>
            a.feuille === 'QUOTA_AUTRES' &&
            a.departementId === null &&
            a.repartitionId === null,
        )
        .map((a) => a.id),
    );
    const valides = lignes.filter(
      (l) => libres.has(l.agentId) && deps.has(l.departementId),
    );
    if (!valides.length)
      throw new BadRequestException(
        'Ces personnes ont déjà un département : refaites une proposition.',
      );
    const rep = await this.repartitions.save({
      quotas,
      personnes: valides.length,
      validePar: u.nom,
    });
    await this.agents.manager.transaction(async (m) => {
      for (const l of valides) {
        const dep = deps.get(l.departementId)!;
        await m.update(Agent, l.agentId, {
          departementId: dep.id,
          repartitionId: rep.id,
        });
        const aff = await m.findOne(Affectation, {
          where: { agentId: l.agentId },
          loadEagerRelations: false,
        });
        if (aff && aff.statut === 'A_TRAITER')
          await m.update(Affectation, aff.id, {
            departementId: dep.id,
            ...(aff.typeNote === 'PERS_ADM' && !aff.structure
              ? { structure: `DDEPPSA ${dep.nom}` }
              : {}),
          });
      }
    });
    // Les personnes ont maintenant un département : leurs anciennes anomalies « département » tombent
    await this.anomalies.reconcilier(valides.map((l) => l.agentId));
    await this.journal.log(u, 'REPARTITION_QUOTA_AUTRES', undefined, null, {
      personnes: valides.length,
      departements: Object.keys(quotas).length,
    });
    return {
      id: rep.id,
      personnes: valides.length,
      ignorees: lignes.length - valides.length,
    };
  }

  /**
   * Bilan d'une répartition : où en sont les personnes placées. Une personne placée
   * n'entre dans une note que si rien ne la bloque (date de signature, diplôme…).
   */
  async bilan(id: string) {
    const rep = await this.repartitions.findOne({ where: { id } });
    if (!rep) throw new NotFoundException('Répartition introuvable');
    const placees = await this.agents.count({ where: { repartitionId: id } });
    const liste = await this.affectation.listeAffectations({
      repartitionId: id,
    });
    const sansTexte = placees - liste.length;
    const raisons: Record<string, number> = {};
    const parLot = new Map<
      number,
      { numero: number; libelle: string; bloques: number }
    >();
    let prets = 0;
    let affectes = 0;
    let exclus = 0;
    for (const x of liste) {
      if (x.statut === 'AFFECTE') {
        affectes++;
        continue;
      }
      if (x.statut === 'EXCLU') {
        exclus++;
        continue;
      }
      if (!x.derive.bloquants.length) {
        prets++;
        continue;
      }
      for (const b of x.derive.bloquants) {
        const k = b.split(' (')[0].split(' : ')[0];
        raisons[k] = (raisons[k] ?? 0) + 1;
      }
      const l = x.agent.lotPublication;
      if (l) {
        const e = parLot.get(l.numero) ?? {
          numero: l.numero,
          libelle: libelleLot(l),
          bloques: 0,
        };
        e.bloques++;
        parLot.set(l.numero, e);
      }
    }
    return {
      id,
      creeLe: rep.creeLe,
      annulee: rep.annulee,
      placees,
      sansTexte,
      prets,
      affectes,
      exclus,
      bloques: liste.length - prets - affectes - exclus,
      raisons: Object.entries(raisons)
        .sort((a, b) => b[1] - a[1])
        .map(([raison, n]) => ({ raison, n })),
      lots: [...parLot.values()].sort((a, b) => b.bloques - a.bloques),
    };
  }

  /** Annule une répartition (sauf pour les personnes déjà dans une note validée). */
  async annuler(u: UtilisateurConnecte, id: string) {
    const rep = await this.repartitions.findOne({ where: { id } });
    if (!rep || rep.annulee)
      throw new NotFoundException('Répartition introuvable');
    const agents = await this.agents.find({
      where: { repartitionId: id },
      loadEagerRelations: false,
    });
    let annules = 0;
    let gardes = 0;
    await this.agents.manager.transaction(async (m) => {
      for (const a of agents) {
        const aff = await m.findOne(Affectation, {
          where: { agentId: a.id },
          loadEagerRelations: false,
        });
        if (aff && aff.statut !== 'A_TRAITER') {
          gardes++;
          continue;
        }
        await m.update(Agent, a.id, {
          departementId: null,
          repartitionId: null,
        });
        if (aff)
          await m.update(Affectation, aff.id, {
            departementId: null,
            ...(aff.structure?.startsWith('DDEPPSA ')
              ? { structure: null }
              : {}),
          });
        annules++;
      }
      await m.update(Repartition, id, { annulee: true });
    });
    await this.journal.log(u, 'REPARTITION_ANNULEE', undefined, null, {
      annules,
      gardes,
    });
    return { annules, gardes };
  }
}
