import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { CircuitService } from '../circuit/circuit.service';
import { enTexte, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { LigneRapportPersonnel, PropositionBm } from '../entities';
import { ConfigRecensementService } from '../recensement/configuration';
import { RecensementService } from '../recensement/recensement.service';
import { cleEcole, CYCLES_ECOLE } from './effectifs-ecoles-regles';
import { EffectifsEcolesService } from './effectifs-ecoles.service';
import { naissanceDe } from './rapprochement-rapports-regles';

const STATUTS = ['FONCTIONNAIRE', 'CONTRACTUEL', 'VOLONTAIRE', 'COMMUNAUTAIRE'];

/**
 * Propositions d'ajout du volet Banque mondiale (DG, 18/11/2026). Le volet n'écrit jamais dans nos
 * bases : il PROPOSE. Une personne absente de nos bases (rapport d'une DDEPPSA) est proposée au
 * contrôle des modifications ; une école hors organigramme est proposée au DG. Rien n'est créé
 * avant la validation ; un rejet ne change rien.
 */
@Injectable()
export class PropositionsBmService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
    private readonly recensement: RecensementService,
    private readonly configRecensement: ConfigRecensementService,
    private readonly circuit: CircuitService,
    private readonly ecoles: EffectifsEcolesService,
  ) {}

  private repo() {
    return this.ds.getRepository(PropositionBm);
  }

  /** Les propositions en attente pour des origines données (lignes, écoles). */
  async enAttente(type: 'AGENT' | 'ECOLE', origines: string[]) {
    if (!origines.length) return new Map<string, PropositionBm>();
    const l = await this.repo().find({
      where: { type, origine: In(origines) },
      order: { faiteLe: 'DESC' },
    });
    const m = new Map<string, PropositionBm>();
    for (const p of l) if (p.origine && !m.has(p.origine)) m.set(p.origine, p);
    return m;
  }

  /* ------------------------------ Personnes ------------------------------ */

  /**
   * Proposer d'ajouter à la base du personnel des personnes du rapport absentes de nos bases. Les
   * valeurs : celles du rapport, ou celles corrigées dans la liste Banque mondiale.
   */
  async proposerAgents(
    u: UtilisateurConnecte,
    lignes: LigneRapportPersonnel[],
    statutChoisi?: string,
  ) {
    if (statutChoisi && !STATUTS.includes(statutChoisi))
      throw new BadRequestException('Type d’agent inconnu.');
    const erreurs: { ligneId: number; nom: string; message: string }[] = [];
    let faits = 0;
    if (!lignes.length) return { faits, erreurs };
    const rapports = new Map(
      (
        await this.ds.query<
          {
            id: number;
            anneeScolaire: string;
            nomFichier: string;
            departement: string | null;
            code: string | null;
          }[]
        >(
          `SELECT r.id, r."anneeScolaire", r."nomFichier", d.nom AS departement, d.code
             FROM rapport_personnel r LEFT JOIN departement d ON d.id = r."departementId"
            WHERE r.id = ANY($1)`,
          [[...new Set(lignes.map((l) => l.rapportId))]],
        )
      ).map((r) => [r.id, r]),
    );
    const deps = new Map(
      (
        await this.ds.query<{ nom: string; code: string }[]>(
          `SELECT nom, code FROM departement`,
        )
      ).map((d) => [d.nom, d.code]),
    );
    const attente = await this.enAttente(
      'AGENT',
      lignes.map((l) => `L${l.id}`),
    );
    for (const l of lignes) {
      const erreur = (message: string) =>
        erreurs.push({ ligneId: l.id, nom: l.nomComplet, message });
      if (l.agentId || l.volontaireId) {
        erreur('A déjà une fiche dans nos bases : confirmez-la plutôt.');
        continue;
      }
      const p = attente.get(`L${l.id}`);
      if (p && p.etat !== 'REJETEE') {
        erreur(
          p.etat === 'VALIDEE'
            ? 'Déjà ajoutée à la base du personnel.'
            : 'Déjà proposée : en attente du contrôle des modifications.',
        );
        continue;
      }
      const statut = statutChoisi ?? l.statut ?? '';
      if (!STATUTS.includes(statut)) {
        erreur(
          'Type d’agent non écrit dans le rapport : choisissez-le (proposition une par une).',
        );
        continue;
      }
      const r = rapports.get(l.rapportId);
      const corr = (k: string) => {
        const v = l.applique?.[k]?.apres;
        return v === undefined || v === null || v === ''
          ? undefined
          : typeof v === 'string'
            ? v
            : JSON.stringify(v);
      };
      const iso = (v: string | null | undefined) =>
        v ? naissanceDe(v).date : null;
      const genre = (l.donnees?.Genre ?? l.donnees?.Sexe ?? '')
        .trim()
        .toUpperCase();
      const dep = corr('DEPARTEMENT');
      const donnees: Record<string, string> = Object.fromEntries(
        Object.entries({
          NOMS_PRENOMS: corr('NOMS_PRENOMS') ?? l.nomComplet,
          DATE_NAISSANCE:
            corr('DATE_NAISSANCE') ?? l.dateNaissance ?? undefined,
          GENRE: genre === 'F' || genre === 'M' ? genre : undefined,
          MATRICULE_SOLDE: corr('MATRICULE_SOLDE') ?? l.matricule ?? undefined,
          LIEU_SERVICE: corr('LIEU_SERVICE') ?? l.ecole ?? undefined,
          FONCTION: l.fonction ?? undefined,
          DATE_PRISE_SERVICE:
            corr('DATE_PRISE_SERVICE') ?? iso(l.priseService) ?? undefined,
          DEPARTEMENT: dep ? deps.get(dep) : (r?.code ?? undefined),
        }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
      ) as Record<string, string>;
      const source =
        `Rapport de fin d’année ${r?.anneeScolaire ?? ''} de la DDEPPSA ${r?.departement ?? ''} (fichier « ${r?.nomFichier ?? ''} », n° ${l.numero ?? l.ordre})`
          .replace(/\s+/g, ' ')
          .trim();
      const n = await this.repo().save(
        this.repo().create({
          type: 'AGENT',
          origine: `L${l.id}`,
          donnees: { statut, donnees, ligneId: l.id, rapportId: l.rapportId },
          source,
          faitePar: u.nom,
        }),
      );
      await this.journal.log(
        u,
        'PROPOSITION_BM_AGENT',
        'proposition_bm',
        n.id,
        { ligneId: l.id },
      );
      faits++;
    }
    return { faits, erreurs };
  }

  /* ------------------------------- Écoles ------------------------------- */

  /** Proposer d'ajouter une école hors organigramme à l'organigramme, sous son inspection. */
  async proposerEcole(
    u: UtilisateurConnecte,
    d: { cle: string; nom: string; cycle: string; inspectionId: number },
  ) {
    const { ecole } = await this.ecoles.ecole(
      String(d.cle ?? '').slice(0, 260),
    );
    if (ecole.organigramme)
      throw new BadRequestException(
        'Cette école est déjà dans l’organigramme.',
      );
    if (!(d.cycle in CYCLES_ECOLE))
      throw new BadRequestException('Choisissez le cycle.');
    const nom = d.nom?.replace(/\s+/g, ' ').trim();
    if (!nom)
      throw new BadRequestException('Écrivez le nom officiel de l’école.');
    const [ins] = await this.ds.query<
      {
        id: number;
        nom: string;
        departementId: number | null;
        departement: string | null;
      }[]
    >(
      `SELECT s.id, s.nom, s."departementId", dp.nom AS departement FROM structure s
         LEFT JOIN departement dp ON dp.id = s."departementId"
        WHERE s.id = $1 AND s.type = 'INSPECTION' AND s.actif`,
      [d.inspectionId],
    );
    if (!ins) throw new BadRequestException('Choisissez l’inspection.');
    const deja = (await this.enAttente('ECOLE', [ecole.id])).get(ecole.id);
    if (deja?.etat === 'A_CONTROLER')
      throw new BadRequestException(
        'Déjà proposée : en attente de la décision du DG.',
      );
    const ecrit = ecole as unknown as {
      nom?: string;
      total?: number;
      departement?: string;
    };
    const n = await this.repo().save(
      this.repo().create({
        type: 'ECOLE',
        origine: ecole.id,
        donnees: {
          nom,
          cycle: d.cycle,
          inspectionId: ins.id,
          inspection: ins.nom,
          departementId: ins.departementId,
          departement: ins.departement,
          nomEcrit: ecrit.nom ?? null,
          personnes: ecrit.total ?? null,
        },
        source: `Écoles à contrôler (Banque mondiale) : « ${ecrit.nom ?? ecole.id} », ${ecrit.departement ?? ''}, hors organigramme${ecrit.total ? `, ${ecrit.total} personne(s) comptée(s)` : ''}`,
        faitePar: u.nom,
      }),
    );
    await this.journal.log(u, 'PROPOSITION_BM_ECOLE', 'proposition_bm', n.id, {
      cle: ecole.id,
      nom,
    });
    return { id: n.id };
  }

  /* ------------------------------ Contrôle ------------------------------ */

  async liste(type: 'AGENT' | 'ECOLE') {
    const l = await this.repo().find({
      where: { type, etat: 'A_CONTROLER' },
      order: { faiteLe: 'ASC' },
      take: 500,
    });
    if (type !== 'AGENT') return { total: l.length, lignes: l };
    // Les fiches au même nom déjà dans la base : à regarder avant de valider
    const nomDe = (p: PropositionBm) =>
      normaliser(
        String(
          (p.donnees.donnees as Record<string, string>)?.NOMS_PRENOMS ?? '',
        ),
      );
    const memes = await this.ds.query<{ nom: string; n: number }[]>(
      `SELECT "nomNormalise" AS nom, count(*)::int AS n FROM agent_recense
        WHERE "nomNormalise" = ANY($1) GROUP BY 1`,
      [[...new Set(l.map(nomDe))]],
    );
    const parNom = new Map(memes.map((m) => [m.nom, m.n]));
    return {
      total: l.length,
      lignes: l.map((p) => ({ ...p, memeNom: parNom.get(nomDe(p)) ?? 0 })),
    };
  }

  /** Valider : la fiche ou l'école est créée maintenant. */
  async valider(
    u: UtilisateurConnecte,
    id: number,
    forcer: boolean,
    type: 'AGENT' | 'ECOLE',
  ) {
    const p = await this.repo().findOne({ where: { id, type } });
    if (!p) throw new NotFoundException('Proposition introuvable.');
    if (p.etat !== 'A_CONTROLER')
      throw new BadRequestException('Proposition déjà traitée.');
    if (p.type === 'AGENT') {
      const d = p.donnees as {
        statut: string;
        donnees: Record<string, unknown>;
        ligneId?: number;
      };
      const donnees = { ...d.donnees };
      let agentId: number | null = null;
      // Une rubrique refusée (mal écrite dans le rapport) est retirée, sauf le nom
      for (let essai = 0; essai < 6 && agentId === null; essai++) {
        try {
          agentId = (
            await this.recensement.creer(u, {
              statut: d.statut,
              donnees,
              forcer,
            })
          ).id;
        } catch (e) {
          const m = (e as Error).message;
          const champ = this.configRecensement
            .get()
            .champs.find((c) => m.startsWith(`${c.libelle} :`))?.code;
          if (!champ || champ === 'NOMS_PRENOMS' || !(champ in donnees))
            throw e;
          delete donnees[champ];
        }
      }
      if (agentId === null)
        throw new BadRequestException('Fiche impossible à créer.');
      p.resultatId = agentId;
      // La ligne du rapport (table du volet) pointe vers la nouvelle fiche
      if (d.ligneId)
        await this.ds
          .getRepository(LigneRapportPersonnel)
          .update(d.ligneId, { agentId, volontaireId: null, methode: 'AJOUT' });
    } else {
      const d = p.donnees as {
        nom: string;
        cycle: string;
        inspectionId: number;
        departementId: number | null;
      };
      const s = await this.circuit.enregistrerStructure(u, null, {
        type: 'ETABLISSEMENT',
        nom: d.nom,
        parentId: d.inspectionId,
        departementId: d.departementId,
        cycle: d.cycle,
      });
      p.resultatId = s.id;
      // La nouvelle clé de l'école : l'ancienne écriture est comptée avec elle
      const cle = `${d.departementId ?? ''}|${d.cycle}|${cleEcole(d.nom)}`;
      if (p.origine && cle !== p.origine && cleEcole(d.nom))
        await this.ecoles
          .decider(u, {
            type: 'JUMELEE',
            cle: p.origine,
            autreCle: cle,
            motif: 'Ajoutée à l’organigramme (proposition validée)',
          })
          .catch(() => undefined);
      this.ecoles.oublier();
    }
    p.etat = 'VALIDEE';
    p.controlePar = u.nom;
    p.controleLe = new Date();
    await this.repo().save(p);
    await this.journal.log(
      u,
      'PROPOSITION_BM_VALIDEE',
      'proposition_bm',
      p.id,
      { type: p.type, resultatId: p.resultatId },
    );
    return { ok: true, resultatId: p.resultatId };
  }

  /**
   * Valider ou rejeter plusieurs propositions d'un coup (19/11/2026 : « tout cocher pour valider
   * directement »). Chacune comme une à une ; jamais forcée : un homonyme déjà recensé reste à
   * décider une par une. Une proposition qui échoue n'arrête pas les autres.
   */
  async lot(
    u: UtilisateurConnecte,
    action: 'VALIDER' | 'REJETER',
    ids: number[],
    note: string,
    type: 'AGENT' | 'ECOLE',
  ) {
    if (action === 'REJETER' && !note?.trim())
      throw new BadRequestException(
        'Dites pourquoi les propositions sont rejetées.',
      );
    const noms = new Map(
      (await this.repo().find({ where: { id: In(ids), type } })).map((p) => [
        p.id,
        type === 'AGENT'
          ? String(
              (p.donnees.donnees as Record<string, string>)?.NOMS_PRENOMS ?? '',
            )
          : enTexte(p.donnees.nom),
      ]),
    );
    let faits = 0;
    const erreurs: {
      id: number;
      nom: string;
      message: string;
      doublon: boolean;
    }[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        if (action === 'VALIDER') await this.valider(u, id, false, type);
        else await this.rejeter(u, id, note, type);
        faits++;
      } catch (e) {
        const message = (e as Error).message;
        erreurs.push({
          id,
          nom: noms.get(id) ?? '',
          message,
          doublon: /Déjà recensé/i.test(message),
        });
      }
    }
    return { faits, erreurs };
  }

  /** Rejeter : rien n'est créé ; le motif est gardé. */
  async rejeter(
    u: UtilisateurConnecte,
    id: number,
    note: string,
    type: 'AGENT' | 'ECOLE',
  ) {
    const p = await this.repo().findOne({ where: { id, type } });
    if (!p) throw new NotFoundException('Proposition introuvable.');
    if (p.etat !== 'A_CONTROLER')
      throw new BadRequestException('Proposition déjà traitée.');
    const n = note?.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!n)
      throw new BadRequestException(
        'Dites pourquoi la proposition est rejetée.',
      );
    p.etat = 'REJETEE';
    p.note = n;
    p.controlePar = u.nom;
    p.controleLe = new Date();
    await this.repo().save(p);
    await this.journal.log(
      u,
      'PROPOSITION_BM_REJETEE',
      'proposition_bm',
      p.id,
      { type: p.type, note: n },
    );
    return { ok: true };
  }
}
