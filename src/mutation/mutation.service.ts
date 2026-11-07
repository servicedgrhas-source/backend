import { joursDepuis } from '../common/jours';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Repository } from 'typeorm';
import { classeurMutations, type LigneExport } from './export-mutations';
import type { UtilisateurConnecte } from '../auth/auth';
import { champ, lireClasseur, type Ligne } from '../common/excel';
import {
  codeCycle,
  codeDepartement,
  codeMotif,
  groupeDuCycle,
  lireGradeEchelon,
  MOTIFS,
  MOTIFS_MUTATION,
  SEUIL_ANCIENNETE_ANS,
  SPECIALITES_STAT,
  specialiteStat,
  type GroupeMutation,
  type MotifMutation,
} from '../common/referentiels';
import { gradeAbrege } from '../nominations/categories';
import {
  cleCompacte,
  enTexte,
  lireDate,
  nettoyer,
  normaliser,
  sansPrefixeNumero,
} from '../common/texte';
import { IndexNoms } from '../common/index-noms';
import { JournalService } from '../core/core.service';
import { RattachementService } from '../rattachement/rattachement.service';
import { CircuitService } from '../circuit/circuit.service';
import { DemandeMutation, Departement, PieceDemande } from '../entities';

export type EtatMutation =
  | 'EN_CIRCUIT'
  | 'EN_INSTANCE'
  | 'EN_ATTENTE_DDEPPSA'
  | 'EN_ATTENTE_DGRHAS'
  | 'EN_ATTENTE_MINISTRE'
  | 'ACCORDEE'
  | 'REFUSEE'
  | 'RETIREE';

export function etatMutation(d: DemandeMutation): EtatMutation {
  if (d.retiree) return 'RETIREE';
  // Circuit d'approbation : la décision est prise à la dernière étape
  if (d.circuit) {
    if (d.decision === 'ACCORDEE') return 'ACCORDEE';
    if (d.decision === 'REJETEE') return 'REFUSEE';
    if (d.decision === 'EN_INSTANCE') return 'EN_INSTANCE';
    return 'EN_CIRCUIT';
  }
  if (d.instructionMinistre === 'ACCORDEE') return 'ACCORDEE';
  if (d.instructionMinistre === 'REFUSEE') return 'REFUSEE';
  if (d.avisDgrhas) return 'EN_ATTENTE_MINISTRE';
  if (d.avisDdeppsa) return 'EN_ATTENTE_DGRHAS';
  return 'EN_ATTENTE_DDEPPSA';
}

/** Durée dans le poste, en mois, calculée depuis la prise de service si connue. */
export function dureeMois(
  d: Pick<DemandeMutation, 'datePriseService' | 'dureeMois'>,
  aujourdhui = new Date(),
): number | null {
  if (d.datePriseService) {
    const [a, m, j] = d.datePriseService.split('-').map(Number);
    let mois =
      (aujourdhui.getFullYear() - a) * 12 + (aujourdhui.getMonth() + 1 - m);
    if (aujourdhui.getDate() < j) mois--;
    return Math.max(mois, 0);
  }
  return d.dureeMois ?? null;
}

function lireDuree(brut: unknown): number | null {
  const s = normaliser(brut);
  const m = s.match(/(\d+)\s*(ANS?|MOIS)?/);
  if (!m) return null;
  return m[2] === 'MOIS' ? Number(m[1]) : Number(m[1]) * 12;
}

/**
 * N° d'enregistrement écrit dans le fichier : « 1218 », « N° 1218 », « OO57 » (lettre O tapée
 * au lieu du zéro) → 57. Null s'il n'y a pas de numéro lisible.
 */
export function lireNumeroEnregistrement(brut: unknown): number | null {
  if (typeof brut === 'number')
    return Number.isInteger(brut) && brut > 0 ? brut : null;
  if (typeof brut !== 'string') return null;
  const s = brut
    .replace(/^\s*n\s*[°o]\s*/i, '')
    .replace(/[oO]/g, '0')
    .replace(/[\s.]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** Champs lourds laissés hors de la liste des demandes (lus dans la fiche de chaque demande). */
const HORS_LISTE = [
  'circuit',
  'justificatif',
  'observation',
  'origine',
  'avisDdeppsaCommentaire',
  'avisDgrhasCommentaire',
  'instructionCommentaire',
  'decisionMotivation',
  'motifRetrait',
] as const;

/** Motif des demandes qui ne sont pas des mutations (le motif est obligatoire en base). */
export const MOTIF_PRESTATION = 'PRESTATION';

export function anomaliesMutation(d: Partial<DemandeMutation>): string[] {
  // Les points déclarés vérifiés (sur le dossier papier) ne reviennent pas
  const verifies = new Set(d.anomaliesVerifiees ?? []);
  return calculerAnomalies(d).filter((x) => !verifies.has(x));
}

function calculerAnomalies(d: Partial<DemandeMutation>): string[] {
  const a: string[] = [];
  // Congé, attestation, prime… : pas de département demandé ni d'ancienneté à contrôler
  if (d.motif === MOTIF_PRESTATION) {
    if (d.typeAgent === 'FONCTIONNAIRE' && !d.matricule)
      a.push('Matricule solde non communiqué');
    return a;
  }
  if (!d.departementOrigineId) a.push("Département d'origine non reconnu");
  if (!d.departementSolliciteId) a.push('Département sollicité non reconnu');
  // Mutation interne : on reste dans le département (décidée par le DDEPPSA) ; les autres en sortent
  const interne = d.typePrestation === 'MUTATION_DEPARTEMENT';
  if (
    d.departementOrigineId &&
    d.departementSolliciteId &&
    interne !== (d.departementOrigineId === d.departementSolliciteId)
  )
    a.push(
      interne
        ? "Mutation à l'intérieur du département, mais vers un autre département : changez le type de demande"
        : "Département sollicité identique au département d'origine",
    );
  if (d.typeAgent === 'FONCTIONNAIRE' && !d.matricule)
    a.push('Matricule solde non communiqué');
  if (!d.grade) a.push('Grade non renseigné');
  if (!d.cycle) a.push('Cycle non renseigné');
  const duree = dureeMois(d as DemandeMutation);
  if (
    d.motif === 'ANCIENNETE' &&
    (duree === null || duree < SEUIL_ANCIENNETE_ANS * 12)
  )
    a.push(
      `Ancienneté inférieure à ${SEUIL_ANCIENNETE_ANS} ans (ou non renseignée)`,
    );
  if (
    d.motif === 'RAPPROCHEMENT_CONJOINT' &&
    !d.justificatif &&
    !d.justificatifFichier
  )
    a.push('Acte de mariage non fourni');
  if (d.motif === 'PERMUTATION' && !d.permutationAvecId)
    a.push('Agent permutant non désigné');
  return a;
}

/** Ce qu'on compare entre une demande et la fiche du personnel de l'agent (07/11/2026). */
const CHAMPS_PERSONNEL: [keyof DemandeMutation, string][] = [
  ['matricule', 'Matricule solde'],
  ['gradeBrut', 'Grade et échelon'],
  ['departementOrigineId', "Département d'origine"],
  ['lieuService', 'Lieu de service'],
  ['specialite', 'Spécialité'],
  ['datePriseService', 'Date de prise de service'],
];
const videMut = (v: unknown) =>
  v === null || v === undefined || String(v).trim() === '';
/** Même valeur, écrite autrement : « IE 3 » = « Inst. 3 » ? non ; « 123456 A » = « 123456A » oui. */
function pareilPersonnel(k: keyof DemandeMutation, a: unknown, b: unknown) {
  if (k === 'matricule') return cleCompacte(a) === cleCompacte(b);
  if (k === 'gradeBrut') {
    const x = lireGradeEchelon(a);
    const y = lireGradeEchelon(b);
    return (
      cleCompacte(x.grade) === cleCompacte(y.grade) &&
      (x.echelon ?? null) === (y.echelon ?? null)
    );
  }
  if (k === 'departementOrigineId') return Number(a) === Number(b);
  if (k === 'datePriseService')
    return String(a).slice(0, 10) === String(b).slice(0, 10);
  return (
    normaliser(String(a)).replace(/[^A-Z0-9]/g, '') ===
    normaliser(String(b)).replace(/[^A-Z0-9]/g, '')
  );
}

/** Ce qu'on compare de deux demandes qui se ressemblent (import). */
export interface Apercu {
  matricule: string | null;
  grade: string | null;
  cycle: string | null;
  origine: string | null;
  lieuService: string | null;
  sollicite: string | null;
  lieuSollicite: string | null;
}

/** Ce qu'on peut corriger d'une demande depuis la liste des points à vérifier. */
export interface CorrectionAnomalies {
  matricule?: string | null;
  typeAgent?: string;
  grade?: string | null;
  cycle?: string | null;
  departementOrigineId?: number | null;
  departementSolliciteId?: number | null;
  justificatif?: string | null;
  dureeMois?: number | null;
  permutationAvecId?: string | null;
  verifiees?: string[];
}

export interface DemandeDto {
  dateEnregistrement?: string | null;
  nomComplet: string;
  genre?: 'M' | 'F';
  grade?: string | null;
  echelon?: number | null;
  matricule?: string | null;
  typeAgent?: 'FONCTIONNAIRE' | 'FINALISTE';
  typePrestation?: string | null;
  objet?: string | null;
  structureOrigineId?: number | null;
  structureOrigineTexte?: string | null;
  telephone?: string | null;
  statutAgent?: 'ENSEIGNANT' | 'PERSONNEL_ADMINISTRATIF';
  departementOrigineId?: number | null;
  lieuService?: string | null;
  cycle?: string | null;
  specialite?: string | null;
  datePriseService?: string | null;
  departementSolliciteId?: number | null;
  lieuSollicite?: string | null;
  motif: string;
  justificatif?: string | null;
  permutationAvecId?: string | null;
  origine?: string | null;
  observation?: string | null;
  dateDebut?: string | null;
  dateFin?: string | null;
  agentId?: number | null;
}

@Injectable()
export class MutationService {
  constructor(
    @InjectRepository(DemandeMutation)
    private readonly repo: Repository<DemandeMutation>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
    private readonly circuit: CircuitService,
    @InjectRepository(PieceDemande)
    private readonly pieces: Repository<PieceDemande>,
    private readonly rattachement: RattachementService,
  ) {}

  private presenter(d: DemandeMutation) {
    const e =
      d.circuit && d.etapeCourante !== null ? d.circuit[d.etapeCourante] : null;
    return {
      ...d,
      etat: etatMutation(d),
      dureeMoisCalculee: dureeMois(d),
      // Où se trouve le dossier, et depuis combien de jours
      etapeEnCours: e
        ? {
            sigle: e.sigle,
            nom: e.nom,
            rang: d.etapeCourante! + 1,
            etapes: d.circuit!.length,
            depuis: joursDepuis(e.arriveeLe),
          }
        : null,
    };
  }

  /** Comptes des structures (écoles, inspections, DDEPPSA) : seulement les dossiers de leur circuit. */
  private async visibles(
    u: UtilisateurConnecte | undefined,
    liste: DemandeMutation[],
  ) {
    if (!u || !['STRUCTURE', 'DDEPPSA'].includes(u.role)) return liste;
    const mes = await this.circuit.structuresDe(u);
    return liste.filter((d) =>
      d.circuit?.some((e) => !!e.structureId && mes.includes(e.structureId)),
    );
  }

  async liste(f: {
    motif?: string;
    etat?: string;
    departementId?: number;
    recherche?: string;
    groupe?: string;
    u?: UtilisateurConnecte;
  }) {
    const q = this.repo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.departementOrigine', 'o')
      .leftJoinAndSelect('m.departementSollicite', 's')
      .orderBy('m.numeroEnregistrement', 'DESC');
    if (f.motif) q.andWhere('m.motif = :motif', { motif: f.motif });
    if (f.departementId)
      q.andWhere(
        new Brackets((w) =>
          w
            .where('m.departementOrigineId = :d')
            .orWhere('m.departementSolliciteId = :d'),
        ),
        {
          d: f.departementId,
        },
      );
    if (f.recherche) {
      const r = `%${f.recherche.trim()}%`;
      q.andWhere(
        new Brackets((w) =>
          w
            .where('m.nomComplet ILIKE :r', { r })
            .orWhere('m.matricule ILIKE :r', { r }),
        ),
      );
    }
    let liste = (await this.visibles(f.u, await q.getMany())).map((d) =>
      this.presenter(d),
    );
    if (f.etat) liste = liste.filter((d) => d.etat === f.etat);
    if (f.groupe)
      liste = liste.filter(
        (d) => groupeDuCycle(codeCycle(d.cycle)) === f.groupe,
      );
    // Liste : sans le circuit ni les longs textes (avis, motivations, observations), lus dans la
    // fiche de chaque demande ; la réponse pèse plusieurs fois moins.
    return liste.map((d) => {
      const leger: Partial<typeof d> = { ...d };
      for (const k of HORS_LISTE) delete leger[k];
      return leger as Omit<typeof d, (typeof HORS_LISTE)[number]>;
    });
  }

  async obtenir(id: string, u?: UtilisateurConnecte) {
    const d = await this.repo.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    if (u && !(await this.visibles(u, [d])).length)
      throw new ForbiddenException(
        'Cette demande ne passe pas par votre structure.',
      );
    const permutant = d.permutationAvecId
      ? await this.repo.findOne({ where: { id: d.permutationAvecId } })
      : null;
    return {
      ...this.presenter(d),
      permutant: permutant
        ? { id: permutant.id, nomComplet: permutant.nomComplet }
        : null,
    };
  }

  private async prochainNumero() {
    const [r] = await this.repo.query<{ n: number }[]>(
      `SELECT coalesce(max("numeroEnregistrement"), 0) + 1 AS n FROM demande_mutation`,
    );
    return Number(r.n);
  }

  private normaliserDto(dto: DemandeDto): Partial<DemandeMutation> {
    if (!dto.nomComplet?.trim())
      throw new BadRequestException('Nom et prénoms obligatoires');
    const prestation = dto.motif === MOTIF_PRESTATION;
    if (!prestation && !MOTIFS_MUTATION.includes(dto.motif as MotifMutation))
      throw new BadRequestException('Choisissez le motif de la mutation.');
    if (prestation && (dto.objet?.trim().length ?? 0) < 4)
      throw new BadRequestException(
        'Écrivez l’objet de la demande (ex. « Congé administratif de l’année 2026 »).',
      );
    const jour = (v?: string | null) =>
      v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    if (
      jour(dto.dateDebut) &&
      jour(dto.dateFin) &&
      dto.dateFin! < dto.dateDebut!
    )
      throw new BadRequestException(
        'La date de fin est avant la date de début.',
      );
    const t = (v?: string | null) => nettoyer(v);
    const champs: Partial<DemandeMutation> = {
      dateEnregistrement: dto.dateEnregistrement || null,
      nomComplet: dto.nomComplet.trim(),
      genre: dto.genre === 'F' ? 'F' : 'M',
      grade: t(dto.grade),
      echelon: dto.echelon ?? null,
      matricule: t(dto.matricule),
      typeAgent: dto.typeAgent === 'FINALISTE' ? 'FINALISTE' : 'FONCTIONNAIRE',
      statutAgent:
        dto.statutAgent === 'PERSONNEL_ADMINISTRATIF'
          ? 'PERSONNEL_ADMINISTRATIF'
          : 'ENSEIGNANT',
      departementOrigineId: dto.departementOrigineId ?? null,
      lieuService: t(dto.lieuService),
      cycle: codeCycle(dto.cycle) ?? null,
      specialite: t(dto.specialite),
      datePriseService: dto.datePriseService || null,
      departementSolliciteId: dto.departementSolliciteId ?? null,
      lieuSollicite: t(dto.lieuSollicite),
      motif: dto.motif,
      justificatif: t(dto.justificatif),
      permutationAvecId: dto.permutationAvecId || null,
      origine: t(dto.origine),
      observation: t(dto.observation),
      objet: t(dto.objet),
      structureOrigineId: dto.structureOrigineId ?? null,
      structureOrigineTexte: t(dto.structureOrigineTexte),
      telephone: t(dto.telephone),
      dateDebut: jour(dto.dateDebut),
      dateFin: jour(dto.dateFin),
      agentId: dto.agentId ?? null,
    };
    return champs;
  }

  /** Mutation (département ou lieu demandé) ou autre prestation (congé, attestation, prime…). */
  async estMutation(codeType: string) {
    const t = (await this.circuit.listeTypes()).find(
      (x) => x.code === codeType,
    );
    return !!t?.motifMutation || /^(MUTATION|PERMUTATION)/.test(codeType);
  }

  /** Type de prestation d'une demande de mutation (choisi, sinon déduit du motif). */
  private typeDe(dto: DemandeDto) {
    const parMotif: Record<string, string> = {
      ANCIENNETE: 'MUTATION_ANCIENNETE',
      RAISONS_SANTE: 'MUTATION_SANTE',
      RAISONS_SOCIALES: 'MUTATION_SOCIALE',
      RAPPROCHEMENT_CONJOINT: 'MUTATION_CONJOINT',
      PERMUTATION: 'PERMUTATION',
    };
    return dto.typePrestation || parMotif[dto.motif] || 'MUTATION_SOCIALE';
  }

  /**
   * Dossier papier reçu à la DGRHAS et saisi ici : il entre au bureau de la DGRHAS (la voie
   * hiérarchique a eu lieu sur papier).
   */
  /**
   * Un agent ajouté au recensement n'est pas encore dans la base tant que le bureau du contrôle et le
   * DG ne l'ont pas accepté (DG, 24/10/2026) : il ne peut pas encore déposer de demande.
   */
  private async verifierAgent(agentId: number | null | undefined) {
    if (!agentId) return;
    const [a] = await this.repo.query<{ etat: string | null }[]>(
      `SELECT contentieux->>'etat' AS etat FROM agent_recense WHERE id = $1`,
      [agentId],
    );
    if (a?.etat === 'EN_COURS' || a?.etat === 'CONTROLE')
      throw new BadRequestException(
        'Cet agent a été ajouté au recensement et n’est pas encore accepté dans la base (contrôle, puis décision du DG) : il ne peut pas encore déposer de demande.',
      );
    if (a?.etat === 'REJETE')
      throw new BadRequestException(
        'Cet agent a été rejeté par le DG lors du recensement : il ne peut pas déposer de demande.',
      );
  }

  async creer(u: UtilisateurConnecte, dto: DemandeDto) {
    const champs = this.normaliserDto(dto);
    await this.verifierAgent(champs.agentId);
    const numero = await this.prochainNumero();
    const typePrestation = this.typeDe(dto);
    const c = await this.circuit.construire(
      typePrestation,
      {
        structureId: champs.structureOrigineId ?? null,
        departementOrigineId: champs.departementOrigineId ?? null,
        departementSolliciteId: champs.departementSolliciteId ?? null,
      },
      true,
    );
    const d = await this.repo.save({
      ...champs,
      numeroEnregistrement: numero,
      dateEnregistrement:
        champs.dateEnregistrement ?? new Date().toISOString().slice(0, 10),
      cle: `S|${numero}`,
      saisiePar: u.nom,
      anomalies: anomaliesMutation({ ...champs, typePrestation }),
      typePrestation,
      canal: 'SAISIE',
      circuit: c.circuit,
      etapeCourante: c.etapeCourante,
      decideur: c.decideur,
    });
    await this.circuit.alerterNouvelle(d);
    await this.lierPermutation(d);
    // Rattachée à sa fiche du personnel (sinon : à vérifier ou introuvable, jamais bloquant)
    // Le rattachement à la base du personnel attend la note signée (« Importer dans la base du
    // personnel », 06/11/2026) : le traitement des mutations reste isolé de cette base
    await this.journal.log(
      u,
      'DEMANDE_MUTATION_CREEE',
      'demande_mutation',
      d.id,
      { motif: d.motif },
    );
    return this.obtenir(d.id);
  }

  private async lierPermutation(d: DemandeMutation) {
    if (d.motif === 'PERMUTATION' && d.permutationAvecId) {
      const autre = await this.repo.findOne({
        where: { id: d.permutationAvecId },
      });
      if (autre && !autre.permutationAvecId) {
        await this.repo.update(autre.id, {
          permutationAvecId: d.id,
          anomalies: anomaliesMutation({ ...autre, permutationAvecId: d.id }),
        });
      }
    }
  }

  private async modifiable(id: string) {
    const d = await this.repo.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    if (d.noteId)
      throw new BadRequestException('Demande déjà dans une note validée');
    return d;
  }

  /**
   * Compléter les demandes depuis la base du personnel, avant le traitement (DG, 06/11/2026) : « au
   * lieu d'aller chercher, il va dans la base générale, il trouve, il fait la mise à jour ». Seules
   * les cases VIDES sont remplies (matricule, grade et échelon, département d'origine, lieu de
   * service, spécialité, date de prise de service), et seulement depuis une fiche sûre. Les demandes
   * déjà dans une note ne bougent pas. La base du personnel n'est pas modifiée.
   * `essai` : on montre ce qui serait rempli, sans rien enregistrer.
   */
  /**
   * La base des mutations en Excel (07/11/2026), avec les mêmes filtres que la liste à l'écran ; les
   * demandes qui ont encore des points à vérifier sont en orange.
   */
  async exporterExcel(
    f: Parameters<MutationService['liste']>[0],
    u: UtilisateurConnecte,
  ) {
    const ids = (await this.liste({ ...f, u })).map((d) => d.id as string);
    const toutes = ids.length
      ? await this.repo.find({ where: { id: In(ids) } })
      : [];
    const parId = new Map(toutes.map((d) => [d.id, d] as const));
    const noteIds = [
      ...new Set(toutes.map((d) => d.noteId).filter((x): x is string => !!x)),
    ];
    const notes = new Map(
      noteIds.length
        ? (
            await this.repo.query<
              { id: string; numero: string | null; statut: string }[]
            >(
              `SELECT id, numero, statut FROM note_service WHERE id = ANY($1)`,
              [noteIds],
            )
          ).map(
            (n) =>
              [n.id, n.numero ? `n° ${n.numero}` : 'en préparation'] as const,
          )
        : [],
    );
    const ETAPES: Record<string, string> = {
      EN_CIRCUIT: 'En circuit d’approbation',
      EN_INSTANCE: 'En instance',
      EN_ATTENTE_DDEPPSA: 'Chez le DDEPPSA',
      EN_ATTENTE_DGRHAS: 'Chez la DGRHAS',
      EN_ATTENTE_MINISTRE: 'Chez le Ministre',
      ACCORDEE: 'Accordée',
      REFUSEE: 'Refusée',
      RETIREE: 'Retirée',
    };
    const CYCLES_LIB: Record<string, string> = {
      PRESCOLAIRE: 'Préscolaire',
      PRIMAIRE: 'Primaire',
      COLLEGE: 'Collège',
      LYCEE: 'Lycée',
      ALPHABETISATION: 'Alphabétisation',
      ADMINISTRATION: 'Administration',
    };
    const duree = (d: DemandeMutation) => {
      const mois = d.dureeMois;
      if (mois === null || mois === undefined) return null;
      const a = Math.floor(mois / 12);
      const r = mois % 12;
      return (
        [a ? `${a} an${a > 1 ? 's' : ''}` : '', r ? `${r} mois` : '']
          .filter(Boolean)
          .join(' ') || 'Moins d’un mois'
      );
    };
    const lignes: LigneExport[] = ids.flatMap((id) => {
      const d = parId.get(id);
      if (!d) return [];
      return [
        {
          numero: d.numeroEnregistrement,
          dateEnregistrement: d.dateEnregistrement,
          nom: d.nomComplet,
          genre: d.genre,
          grade:
            d.gradeBrut ??
            ([d.grade, d.echelon]
              .filter((x) => x !== null && x !== undefined)
              .join(' ') ||
              null),
          matricule: d.matricule,
          type: d.typeAgent === 'FINALISTE' ? 'Finaliste' : 'Fonctionnaire',
          statut:
            d.statutAgent === 'PERSONNEL_ADMINISTRATIF'
              ? 'Pers. administratif'
              : 'Enseignant',
          origine: d.departementOrigine?.nom ?? null,
          lieuService: d.lieuService,
          cycle: d.cycle
            ? (CYCLES_LIB[codeCycle(d.cycle) ?? ''] ?? d.cycle)
            : null,
          specialite: d.specialite,
          datePriseService: d.datePriseService,
          duree: duree(d),
          sollicite: d.departementSollicite?.nom ?? null,
          lieuSollicite: d.lieuSollicite,
          motif: MOTIFS[d.motif as MotifMutation]?.libelle ?? d.motif,
          justificatif: d.justificatif,
          etat: ETAPES[etatMutation(d)] ?? etatMutation(d),
          note: d.noteId ? (notes.get(d.noteId) ?? 'oui') : null,
          // Les mêmes points que l’écran (liste, bandeau « Points à vérifier »)
          anomalies: d.anomalies ?? [],
        },
      ];
    });
    const filtres = [
      f.motif ? (MOTIFS[f.motif as MotifMutation]?.libelle ?? f.motif) : '',
      f.etat ? (ETAPES[f.etat] ?? f.etat) : '',
      f.recherche ? `recherche « ${f.recherche} »` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    await this.journal.log(u, 'EXPORT_MUTATIONS', 'demande_mutation', null, {
      demandes: lignes.length,
      filtres,
    });
    return {
      nom: `Base des mutations ${new Date().toISOString().slice(0, 10)}.xlsx`,
      contenu: await classeurMutations(lignes, { filtres, par: u.nom }),
    };
  }

  async completerDepuisPersonnel(
    u: UtilisateurConnecte,
    essai: boolean,
    o: {
      /** Pour de bon : seulement ces demandes (cochées à l'écran). */
      ids?: string[] | null;
      /** Fiche choisie à la main : demande → fiche du personnel. */
      choix?: Record<string, number>;
    } = {},
  ) {
    const demandes = await this.repo.find({
      where: { noteId: IsNull(), retiree: false },
    });
    const { fiches, choisies, doutes, sans, doute, sansFiche } =
      await this.rattachement.fichesSuresMutation(
        demandes.map((d) => d.id),
        o.choix ?? {},
      );
    const cochees = o.ids ? new Set(o.ids) : null;
    const nomsDeps = new Map(
      (await this.deps.find()).map((d) => [d.id, d.nom] as const),
    );
    const parChamp: Record<string, number> = {};
    const aCompleter: {
      id: string;
      nom: string;
      matricule: string | null;
      departement: string | null;
      fiche: { id: number; numero: string | null; nom: string };
      choisie: boolean;
      ajouts: { champ: string; valeur: string }[];
    }[] = [];
    let completees = 0;
    for (const d of demandes) {
      const f = fiches.get(d.id);
      if (!f) continue;
      // Les cases vides de la demande prennent ce que dit la fiche
      const pv = this.valeursDuPersonnel(f);
      const champs: Partial<DemandeMutation> = {};
      const ajouts: { champ: string; valeur: string }[] = [];
      for (const [k, libelle] of CHAMPS_PERSONNEL) {
        if (videMut(pv[k]) || !videMut(d[k])) continue;
        if (k === 'gradeBrut' && !videMut(d.grade)) continue;
        (champs as Record<string, unknown>)[k] = pv[k];
        if (k === 'gradeBrut') {
          champs.grade = pv.grade;
          champs.echelon = pv.echelon;
        }
        ajouts.push({
          champ: libelle,
          valeur: this.lisiblePersonnel(k, pv[k], nomsDeps),
        });
      }
      const choisie = choisies.has(d.id);
      if (!ajouts.length && !choisie) continue;
      aCompleter.push({
        id: d.id,
        nom: d.nomComplet,
        matricule: d.matricule,
        departement: d.departementOrigineId
          ? (nomsDeps.get(d.departementOrigineId) ?? null)
          : null,
        fiche: { id: f.id, numero: f.numeroFiche, nom: f.nomComplet },
        choisie,
        ajouts,
      });
      if (!ajouts.length) continue;
      if (cochees && !cochees.has(d.id)) continue;
      completees++;
      for (const a of ajouts) parChamp[a.champ] = (parChamp[a.champ] ?? 0) + 1;
      if (!essai)
        await this.repo.update(d.id, {
          ...champs,
          anomalies: anomaliesMutation({ ...d, ...champs }),
        });
    }
    const resume = (d: DemandeMutation) => ({
      id: d.id,
      nom: d.nomComplet,
      matricule: d.matricule,
      grade: d.gradeBrut,
      departement: d.departementOrigineId
        ? (nomsDeps.get(d.departementOrigineId) ?? null)
        : null,
      lieuService: d.lieuService,
    });
    const parIdDemande = new Map(demandes.map((d) => [d.id, d] as const));
    if (!essai)
      await this.journal.log(
        u,
        'MUTATIONS_COMPLETEES_PERSONNEL',
        'demande_mutation',
        null,
        { completees, parChamp, choisies: choisies.size },
      );
    return {
      essai,
      lues: demandes.length,
      avecFiche: fiches.size,
      completees,
      parChamp,
      doute,
      sansFiche,
      aCompleter,
      /** Plusieurs fiches possibles : la demande et ses fiches candidates, à choisir. */
      doutes: [...doutes].flatMap(([id, l]) => {
        const d = parIdDemande.get(id);
        return d
          ? [
              {
                ...resume(d),
                candidats: l.map((f) => {
                  const v = this.valeursDuPersonnel(f);
                  return {
                    id: f.id,
                    numero: f.numeroFiche,
                    nom: f.nomComplet,
                    matricule: v.matricule ?? null,
                    grade: v.gradeBrut ?? null,
                    departement: f.departementId
                      ? (nomsDeps.get(f.departementId) ?? null)
                      : null,
                    lieuService: v.lieuService ?? null,
                  };
                }),
              },
            ]
          : [];
      }),
      /** Aucune fiche trouvée : on peut la chercher à la main. */
      sans: sans.flatMap((id) => {
        const d = parIdDemande.get(id);
        return d ? [resume(d)] : [];
      }),
    };
  }

  /**
   * Agents de la base du personnel qui répondent à une recherche (matricule, ou mots du nom dans
   * n'importe quel ordre), avec ce qu'il faut pour remplir une demande de mutation. Lecture seule.
   */
  async rechercherAgents(q: string) {
    const t = (q ?? '').trim();
    if (t.length < 3) return [];
    const mat = cleCompacte(t);
    const mots = normaliser(t)
      .split(/\s+/)
      .filter((m) => m.length >= 2)
      .slice(0, 5);
    const params: unknown[] = [];
    const conds: string[] = [];
    if (/\d{3}/.test(t)) {
      params.push(`%${mat}%`);
      conds.push(
        `regexp_replace(upper(coalesce(a.matricule, a.donnees->>'MATRICULE_SOLDE', '')), '[^A-Z0-9]', '', 'g') LIKE $${params.length}`,
      );
    } else {
      if (!mots.length) return [];
      for (const m of mots) {
        params.push(`%${m}%`);
        conds.push(`a."nomNormalise" LIKE $${params.length}`);
      }
    }
    const lignes = await this.repo.query<
      {
        id: number;
        numeroFiche: string | null;
        nomComplet: string;
        statut: string;
        matricule: string | null;
        departementId: number | null;
        donnees: Record<string, unknown>;
      }[]
    >(
      `SELECT a.id, a."numeroFiche", a."nomComplet", a.statut, a.matricule, a."departementId", a.donnees
         FROM agent_recense a
        WHERE ${conds.join(' AND ')} AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME'
        ORDER BY a."nomComplet" LIMIT 12`,
      params,
    );
    const nomsDeps = new Map(
      (await this.deps.find()).map((d) => [d.id, d.nom] as const),
    );
    const ADMIN = /^(SA|SPA|ECON|COM|CHAUFFEUR|SECR|AGENT|PLANTON)/;
    return lignes.map((a) => {
      const v = this.valeursDuPersonnel(a);
      const don = a.donnees ?? {};
      const cycle = codeCycle(enTexte(don.CYCLE));
      return {
        id: a.id,
        numeroFiche: a.numeroFiche,
        nomComplet: a.nomComplet,
        statut: a.statut,
        genre: /^F/.test(normaliser(don.GENRE)) ? 'F' : 'M',
        matricule: v.matricule ?? null,
        grade: v.grade ?? null,
        echelon: v.echelon ?? null,
        gradeBrut: v.gradeBrut ?? null,
        typeAgent: ['FONCTIONNAIRE', 'CONTRACTUEL'].includes(a.statut)
          ? 'FONCTIONNAIRE'
          : 'FINALISTE',
        statutAgent: ADMIN.test(normaliser(v.gradeBrut ?? ''))
          ? 'PERSONNEL_ADMINISTRATIF'
          : 'ENSEIGNANT',
        departementId: a.departementId,
        departement: a.departementId
          ? (nomsDeps.get(a.departementId) ?? null)
          : null,
        lieuService: v.lieuService ?? null,
        specialite: v.specialite ?? null,
        datePriseService: v.datePriseService ?? null,
        cycle,
        fonction: enTexte(don.FONCTION) || null,
      };
    });
  }

  /** Ce que la fiche du personnel dit d'un agent, au format d'une demande de mutation. */
  private valeursDuPersonnel(f: {
    matricule: string | null;
    departementId: number | null;
    donnees: Record<string, unknown>;
  }): Partial<DemandeMutation> {
    const don = f.donnees ?? {};
    const texte = (v: unknown) => {
      const t = enTexte(v).replace(/\s+/g, ' ').trim();
      return t || null;
    };
    const matricule = texte(f.matricule) ?? texte(don.MATRICULE_SOLDE);
    const abrege = gradeAbrege(texte(don.GRADE));
    const echelon = /\d{1,2}/.exec(enTexte(don.ECHELON))?.[0];
    const brut = abrege
      ? echelon
        ? `${abrege} ${Number(echelon)}`
        : abrege
      : null;
    const ge = brut ? lireGradeEchelon(brut) : { grade: null, echelon: null };
    const prise = enTexte(don.DATE_PRISE_SERVICE).slice(0, 10);
    return {
      matricule: matricule && cleCompacte(matricule) !== 'X' ? matricule : null,
      gradeBrut: brut,
      grade: ge.grade,
      echelon: ge.echelon,
      departementOrigineId: f.departementId,
      lieuService: texte(don.LIEU_SERVICE),
      specialite: texte(don.SPECIALITE),
      datePriseService: /^\d{4}-\d{2}-\d{2}$/.test(prise) ? prise : null,
    };
  }

  private lisiblePersonnel(
    k: keyof DemandeMutation,
    v: unknown,
    nomsDeps: Map<number, string>,
  ) {
    if (videMut(v)) return '';
    if (k === 'departementOrigineId')
      return nomsDeps.get(Number(v)) ?? String(v);
    if (k === 'datePriseService')
      return String(v).slice(0, 10).split('-').reverse().join('/');
    return enTexte(v);
  }

  private nomsDeps: Map<number, string> | null = null;
  private async nomDepartement(id: number | null) {
    if (!id) return null;
    this.nomsDeps ??= new Map(
      (await this.deps.find()).map((x) => [x.id, x.nom] as const),
    );
    return this.nomsDeps.get(id) ?? null;
  }

  /**
   * Corriger les points à vérifier d'une demande depuis la liste (06/11/2026) : seuls les champs
   * donnés changent ; `verifiees` : points vus sur le dossier papier, qui ne reviennent plus.
   * Renvoie la demande et ses points restants.
   */
  async corrigerAnomalies(
    u: UtilisateurConnecte,
    id: string,
    c: CorrectionAnomalies,
  ) {
    const d = await this.modifiable(id);
    const champs: Partial<DemandeMutation> = {};
    const texte = (v: unknown) =>
      typeof v === 'string' ? v.trim() || null : null;
    if (c.matricule !== undefined) champs.matricule = texte(c.matricule);
    if (c.typeAgent === 'FONCTIONNAIRE' || c.typeAgent === 'FINALISTE')
      champs.typeAgent = c.typeAgent;
    if (c.grade !== undefined) {
      const { grade, echelon } = lireGradeEchelon(c.grade);
      champs.grade = grade;
      champs.echelon = echelon;
      champs.gradeBrut = texte(c.grade);
    }
    if (c.cycle !== undefined) champs.cycle = codeCycle(c.cycle);
    if (c.departementOrigineId !== undefined)
      champs.departementOrigineId = c.departementOrigineId || null;
    if (c.departementSolliciteId !== undefined)
      champs.departementSolliciteId = c.departementSolliciteId || null;
    if (c.justificatif !== undefined)
      champs.justificatif = texte(c.justificatif);
    if (c.dureeMois !== undefined)
      champs.dureeMois =
        c.dureeMois && c.dureeMois > 0 ? Math.round(c.dureeMois) : null;
    if (c.permutationAvecId !== undefined) {
      if (c.permutationAvecId) {
        const autre = await this.repo.findOne({
          where: { id: c.permutationAvecId },
        });
        if (!autre || autre.id === d.id || autre.motif !== 'PERMUTATION')
          throw new BadRequestException(
            'Choisissez une autre demande de permutation.',
          );
      }
      champs.permutationAvecId = c.permutationAvecId || null;
    }
    if (Array.isArray(c.verifiees))
      champs.anomaliesVerifiees = [
        ...new Set([
          ...(d.anomaliesVerifiees ?? []),
          ...c.verifiees.map(String),
        ]),
      ];
    if (!Object.keys(champs).length)
      throw new BadRequestException(
        'Remplissez au moins une correction, ou cochez un point comme vérifié.',
      );
    const apres = { ...d, ...champs };
    champs.anomalies = anomaliesMutation(apres);
    await this.repo.update(id, champs);
    await this.lierPermutation(apres);
    await this.journal.log(
      u,
      'MUTATION_POINTS_CORRIGES',
      'demande_mutation',
      id,
      {
        champs: Object.keys(champs).filter((k) => k !== 'anomalies'),
        restent: champs.anomalies.length,
      },
    );
    return { ok: true, anomalies: champs.anomalies };
  }

  /** Contrôle avant d'envoyer un fichier au stockage (rien n'est envoyé pour une demande figée). */
  async verifierModifiable(id: string) {
    await this.modifiable(id);
  }

  /** Nom du fichier du justificatif unique actuel (null s'il n'y en a pas). */
  async justificatifActuel(id: string) {
    const d = await this.repo.findOne({ where: { id } });
    const nom = d?.justificatifFichier;
    return nom && nom !== 'pieces' ? nom : null;
  }

  async modifier(u: UtilisateurConnecte, id: string, dto: DemandeDto) {
    const d = await this.modifiable(id);
    if (d.instructionMinistre)
      throw new BadRequestException('Demande déjà tranchée par le Ministre');
    const champs = this.normaliserDto(dto);
    await this.repo.update(id, {
      ...champs,
      anomalies: anomaliesMutation({ ...d, ...champs }),
    });
    await this.lierPermutation({ ...d, ...champs });
    await this.journal.log(
      u,
      'DEMANDE_MUTATION_MODIFIEE',
      'demande_mutation',
      id,
    );
    return this.obtenir(id);
  }

  /**
   * Demande faite par l'agent lui-même sur le portail : elle part de sa structure et suit
   * toute la voie hiérarchique. Renvoie le n° et le code de suivi.
   */
  async creerDepuisPortail(
    dto: DemandeDto,
    fichiers: { libelle: string; f: Express.Multer.File }[],
    /** Déposée par le chef de l'agent (ou la DGRHAS) depuis son compte. */
    par?: UtilisateurConnecte,
  ) {
    const champs = this.normaliserDto(dto);
    await this.verifierAgent(champs.agentId);
    // Administration centrale : le formulaire ne demande pas de département ; c'est celui de la
    // structure (ou d'une structure au-dessus), sinon Brazzaville (DG, 28/10/2026)
    if (!champs.departementOrigineId && champs.structureOrigineId) {
      const [r] = await this.deps.query<{ departementId: number | null }[]>(
        `WITH RECURSIVE c AS (SELECT id, "parentId", "departementId", 0 AS n FROM structure WHERE id = $1
                              UNION ALL SELECT s.id, s."parentId", s."departementId", c.n + 1 FROM structure s JOIN c ON s.id = c."parentId" WHERE c.n < 10)
         SELECT "departementId" FROM c WHERE "departementId" IS NOT NULL ORDER BY n LIMIT 1`,
        [champs.structureOrigineId],
      );
      champs.departementOrigineId =
        r?.departementId ??
        (await this.deps.findOne({ where: { code: 'BRAZZAVILLE' } }))?.id ??
        null;
    }
    if (!champs.departementOrigineId)
      throw new BadRequestException('Choisissez votre département actuel.');
    if (
      !champs.departementSolliciteId &&
      (await this.estMutation(this.typeDe(dto)))
    )
      throw new BadRequestException('Choisissez le département demandé.');
    if (!fichiers.length)
      throw new BadRequestException(
        'Joignez au moins votre demande manuscrite scannée.',
      );
    const numero = await this.prochainNumero();
    const typePrestation = this.typeDe(dto);
    const c = await this.circuit.construire(typePrestation, {
      structureId: champs.structureOrigineId ?? null,
      departementOrigineId: champs.departementOrigineId,
      departementSolliciteId: champs.departementSolliciteId ?? null,
    });
    const code = Array.from(
      { length: 6 },
      () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)],
    ).join('');
    const d = await this.repo.save({
      ...champs,
      numeroEnregistrement: numero,
      dateEnregistrement: new Date().toISOString().slice(0, 10),
      cle: `${par ? 'C' : 'P'}|${numero}`,
      saisiePar: par ? par.nom : `${champs.nomComplet} (portail)`,
      anomalies: anomaliesMutation({
        ...champs,
        justificatifFichier: 'pieces',
      }),
      typePrestation,
      canal: par ? 'STRUCTURE' : 'PORTAIL',
      codeSuivi: code,
      circuit: c.circuit,
      etapeCourante: c.etapeCourante,
      decideur: c.decideur,
    });
    for (const { libelle, f } of fichiers)
      await this.pieces.save({
        demandeId: d.id,
        libelle,
        nomOrigine: f.originalname.slice(0, 200),
        fichier: f.filename,
        mime: f.mimetype,
        taille: f.size,
        ajoutePar: par ? par.nom : 'Demandeur (portail)',
      });
    await this.circuit.alerterNouvelle(d);
    await this.journal.log(
      par ?? null,
      par ? 'DEMANDE_DEPOSEE' : 'DEMANDE_PORTAIL',
      'demande_mutation',
      d.id,
      {
        type: typePrestation,
        pieces: fichiers.length,
      },
    );
    // Le rattachement à la base du personnel attend la note signée (« Importer dans la base du
    // personnel », 06/11/2026) : le traitement des mutations reste isolé de cette base
    return { id: d.id, numero, code, etape: c.circuit[0].sigle };
  }

  /** Suivi public : n° + code. Montre les étapes franchies et la décision, sans les avis internes. */
  async suivi(numero: number, code: string) {
    const d = await this.repo
      .createQueryBuilder('d')
      .addSelect('d.codeSuivi')
      .where('d.numeroEnregistrement = :numero', { numero })
      .getOne();
    if (!d || !d.codeSuivi || d.codeSuivi !== code.trim().toUpperCase())
      throw new NotFoundException(
        'Aucune demande avec ce numéro et ce code. Vérifiez-les.',
      );
    return {
      numero: d.numeroEnregistrement,
      date: d.dateEnregistrement,
      objet: d.objet,
      typePrestation: d.typePrestation,
      decision: d.decision,
      decisionMotivation: d.decision ? d.decisionMotivation : null,
      dateDebut: d.dateDebut,
      dateFin: d.dateFin,
      // Prestation accordée (autre qu'une mutation) : l'acte s'imprime depuis le portail
      acteDisponible:
        d.decision === 'ACCORDEE' &&
        !(await this.estMutation(d.typePrestation ?? '')),
      etapes: (d.circuit ?? []).map((e, i) => ({
        sigle: e.sigle,
        nom: e.nom,
        etat:
          i === d.etapeCourante && !d.decision
            ? 'EN_COURS'
            : e.visaLe
              ? 'FAIT'
              : 'A_VENIR',
        date: e.visaLe ?? e.arriveeLe,
      })),
    };
  }

  /* ------------------------- Pièces jointes de la demande ------------------------- */

  async piecesDe(id: string) {
    return this.pieces.find({
      where: { demandeId: id },
      order: { creeLe: 'ASC' },
    });
  }

  async ajouterPieces(
    u: UtilisateurConnecte,
    id: string,
    fichiers: { libelle: string; f: Express.Multer.File }[],
  ) {
    const d = await this.modifiable(id);
    for (const { libelle, f } of fichiers)
      await this.pieces.save({
        demandeId: id,
        libelle,
        nomOrigine: f.originalname.slice(0, 200),
        fichier: f.filename,
        mime: f.mimetype,
        taille: f.size,
        ajoutePar: u.nom,
      });
    await this.repo.update(id, {
      anomalies: anomaliesMutation({
        ...d,
        justificatifFichier: d.justificatifFichier ?? 'pieces',
      }),
    });
    await this.journal.log(u, 'PIECES_AJOUTEES', 'demande_mutation', id, {
      n: fichiers.length,
    });
    return this.piecesDe(id);
  }

  async piece(id: string, pieceId: string) {
    const p = await this.pieces.findOne({
      where: { id: pieceId, demandeId: id },
    });
    if (!p) throw new NotFoundException('Pièce introuvable');
    return p;
  }

  async supprimerPiece(u: UtilisateurConnecte, id: string, pieceId: string) {
    await this.modifiable(id);
    const p = await this.piece(id, pieceId);
    await this.pieces.delete(p.id);
    await this.journal.log(u, 'PIECE_RETIREE', 'demande_mutation', id, {
      libelle: p.libelle,
    });
    return p;
  }

  async enregistrerFichier(u: UtilisateurConnecte, id: string, chemin: string) {
    const d = await this.modifiable(id);
    await this.repo.update(id, {
      justificatifFichier: chemin,
      anomalies: anomaliesMutation({ ...d, justificatifFichier: chemin }),
    });
    await this.journal.log(u, 'JUSTIFICATIF_AJOUTE', 'demande_mutation', id);
  }

  async cheminFichier(id: string) {
    const d = await this.repo.findOne({ where: { id } });
    // « pieces » : la demande a des pièces jointes (liste des pièces), pas de justificatif unique
    if (!d?.justificatifFichier || d.justificatifFichier === 'pieces')
      throw new NotFoundException('Aucun justificatif');
    return d.justificatifFichier;
  }

  async avis(
    u: UtilisateurConnecte,
    id: string,
    niveau: 'DDEPPSA' | 'DGRHAS' | 'MINISTRE',
    valeur: string,
    commentaire?: string,
  ) {
    const d = await this.modifiable(id);
    if (d.circuit)
      throw new BadRequestException(
        'Cette demande suit le circuit d’approbation : donnez votre avis à votre étape du circuit.',
      );
    if (d.retiree) throw new BadRequestException('Demande retirée');
    const c = commentaire?.trim() || null;
    if (niveau === 'DDEPPSA') {
      if (!['FAVORABLE', 'DEFAVORABLE'].includes(valeur))
        throw new BadRequestException('Avis invalide');
      if (u.role === 'DDEPPSA' && u.departementId !== d.departementOrigineId)
        throw new ForbiddenException(
          'Vous ne pouvez donner un avis que pour les agents de votre département',
        );
      if (d.instructionMinistre)
        throw new BadRequestException('Demande déjà tranchée');
      await this.repo.update(id, {
        avisDdeppsa: valeur as 'FAVORABLE',
        avisDdeppsaCommentaire: c,
        avisDdeppsaPar: u.nom,
      });
    } else if (niveau === 'DGRHAS') {
      if (!['FAVORABLE', 'DEFAVORABLE'].includes(valeur))
        throw new BadRequestException('Avis invalide');
      if (d.instructionMinistre)
        throw new BadRequestException('Demande déjà tranchée');
      await this.repo.update(id, {
        avisDgrhas: valeur as 'FAVORABLE',
        avisDgrhasCommentaire: c,
        avisDgrhasPar: u.nom,
      });
    } else {
      if (!['ACCORDEE', 'REFUSEE'].includes(valeur))
        throw new BadRequestException('Instruction invalide');
      if (!d.avisDgrhas)
        throw new BadRequestException(
          "L'avis de la DGRHAS est requis avant l'instruction du Ministre",
        );
      await this.repo.update(id, {
        instructionMinistre: valeur as 'ACCORDEE',
        instructionCommentaire: c,
        instructionPar: u.nom,
      });
    }
    await this.journal.log(u, `AVIS_${niveau}`, 'demande_mutation', id, {
      valeur,
      commentaire: c,
    });
    return this.obtenir(id);
  }

  /**
   * Après la décision du DG, le dossier part au secrétariat du DG, qui imprime la fiche individuelle
   * et les pièces jointes pour les annexer à la note envoyée à la signature du ministre.
   */
  async envoyerSecretariat(u: UtilisateurConnecte, id: string) {
    const d = await this.repo.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    if (d.retiree) throw new BadRequestException('Demande retirée');
    if (d.decision !== 'ACCORDEE' && d.instructionMinistre !== 'ACCORDEE')
      throw new BadRequestException(
        'Seul un dossier accordé peut être envoyé au secrétariat : donnez d’abord la décision.',
      );
    await this.repo.update(id, {
      envoyeSecretariatLe: new Date(),
      envoyeSecretariatPar: u.nom,
    });
    await this.journal.log(
      u,
      'DEMANDE_ENVOYEE_SECRETARIAT',
      'demande_mutation',
      id,
      { numero: d.numeroEnregistrement },
    );
    return this.obtenir(id);
  }

  async retirer(
    u: UtilisateurConnecte,
    id: string,
    motif: string,
    retirer: boolean,
  ) {
    await this.modifiable(id);
    if (retirer && !motif?.trim())
      throw new BadRequestException('Motif du retrait obligatoire');
    await this.repo.update(id, {
      retiree: retirer,
      motifRetrait: retirer ? motif.trim() : null,
    });
    await this.journal.log(
      u,
      retirer ? 'DEMANDE_RETIREE' : 'DEMANDE_REINTEGREE',
      'demande_mutation',
      id,
      { motif },
    );
    return this.obtenir(id);
  }

  /** Demandes accordées, non retirées, pas encore dans une note validée. */
  async eligiblesPourNote(motif: MotifMutation, groupe: GroupeMutation) {
    const liste = await this.repo.find({
      where: {
        motif,
        instructionMinistre: 'ACCORDEE',
        retiree: false,
        noteId: IsNull(),
      },
    });
    return liste.filter(
      (d) =>
        // Mutation dans le département : décidée et notée par le DDEPPSA
        d.decideur !== 'DDEPPSA' &&
        groupeDuCycle(codeCycle(d.cycle)) === groupe &&
        d.departementSolliciteId,
    );
  }

  /* --------------------------- Statistiques --------------------------- */

  /**
   * Demandes déjà enregistrées pour la même personne : même matricule,
   * ou tous les mots du nom saisi présents dans le nom (« X née Y » compris).
   */
  async doublons(nom?: string, matricule?: string, exclure?: string) {
    const mots = normaliser(nom)
      .split(/[^A-Z0-9]+/)
      .filter((m) => m.length >= 2 && m !== 'NEE');
    const mat = cleCompacte(matricule);
    if (mots.length < 2 && mat.length < 4) return [];
    const liste = await this.repo.find({
      order: { numeroEnregistrement: 'DESC' },
    });
    return liste
      .filter((d) => d.id !== exclure)
      .filter((d) => {
        if (mat.length >= 4 && cleCompacte(d.matricule) === mat) return true;
        if (mots.length < 2) return false;
        const cible = normaliser(d.nomComplet).split(/[^A-Z0-9]+/);
        return mots.every((m) => cible.includes(m));
      })
      .slice(0, 5)
      .map((d) => ({
        ...this.presenter(d),
        memeMatricule: mat.length >= 4 && cleCompacte(d.matricule) === mat,
      }));
  }

  async statistiques(base: 'accordees' | 'toutes') {
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    // Les mutations seulement (pas les congés, attestations, primes…)
    let liste = (await this.repo.find({ where: { retiree: false } })).filter(
      (d) => d.motif !== MOTIF_PRESTATION,
    );
    if (base === 'accordees')
      liste = liste.filter((d) => d.instructionMinistre === 'ACCORDEE');

    const lignes: { cycle: string; specialite: string | null }[] = [
      { cycle: 'ADMINISTRATION', specialite: null },
      { cycle: 'PRESCOLAIRE', specialite: null },
      { cycle: 'PRIMAIRE', specialite: null },
      { cycle: 'ALPHABETISATION', specialite: null },
      ...SPECIALITES_STAT.COLLEGE.map((s) => ({
        cycle: 'COLLEGE',
        specialite: s,
      })),
      { cycle: 'COLLEGE', specialite: 'AUTRES' },
      ...SPECIALITES_STAT.LYCEE.map((s) => ({ cycle: 'LYCEE', specialite: s })),
      { cycle: 'LYCEE', specialite: 'AUTRES' },
    ];
    const cleLigne = (d: DemandeMutation) => {
      const c =
        d.statutAgent === 'PERSONNEL_ADMINISTRATIF'
          ? 'ADMINISTRATION'
          : (codeCycle(d.cycle) ?? 'ADMINISTRATION');
      if (c === 'COLLEGE' || c === 'LYCEE')
        return `${c}|${specialiteStat(d.specialite)}`;
      return `${c}|`;
    };
    const vide = () =>
      Object.fromEntries(deps.map((dep) => [dep.code, { M: 0, R: 0, E: 0 }]));
    const table = new Map(
      lignes.map((l) => [`${l.cycle}|${l.specialite ?? ''}`, vide()]),
    );
    for (const d of liste) {
      const t = table.get(cleLigne(d));
      if (!t) continue;
      const o = deps.find((x) => x.id === d.departementOrigineId);
      const s = deps.find((x) => x.id === d.departementSolliciteId);
      if (o) t[o.code].M++;
      if (s) t[s.code].R++;
    }
    for (const t of table.values())
      for (const v of Object.values(t)) v.E = v.M - v.R;
    return {
      base,
      total: liste.length,
      departements: deps.map((d) => ({ code: d.code, nom: d.nom })),
      lignes: lignes.map((l) => ({
        ...l,
        valeurs: table.get(`${l.cycle}|${l.specialite ?? ''}`)!,
      })),
    };
  }

  /* ------------------------------ Import ------------------------------ */

  /**
   * Importer le registre Excel des demandes (refait le 06/11/2026), en trois temps, comme
   * l'enrôlement : 1. l'utilisateur choisit la ou les feuilles (le fichier a souvent une feuille
   * « DOUBLONS » ou des copies de la compilation) ; 2. essai : chaque ligne est comparée à la
   * base des MUTATIONS seulement (même personne et même motif, demande proche déjà enregistrée)
   * et au fichier lui-même ; 3. import, avec les décisions prises ligne par ligne ou par groupe
   * (`decisions` : clé de la ligne → MAJ, FUSION, AJOUTER ou IGNORER). La base du personnel n'est
   * pas touchée : le rattachement se fait après la note signée (« Importer dans la base du
   * personnel »).
   */
  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    essai = false,
    feuillesChoisies: string[] | null = null,
    decisions: Record<string, string> = {},
    /**
     * Base du personnel (07/11/2026) : `personnel` dit, par ligne, s'il faut garder la demande telle
     * quelle (GARDER, par défaut) ou prendre les valeurs de la fiche du personnel quand elles
     * diffèrent (PERSONNEL) ; `completer` remplit les cases vides de la demande depuis la fiche.
     */
    o: { personnel?: Record<string, string>; completer?: boolean } = {},
  ) {
    const toutes = await lireClasseur(contenu, ['NOMSETPRENOMS', 'MOTIF']);
    if (!toutes.length)
      throw new BadRequestException(
        'Aucune feuille visible avec les colonnes « Noms et prénoms » et « Motif évoqué ».',
      );
    const feuillesDispo = toutes.map((f) => ({
      nom: f.nom,
      lignes: f.lignes.length,
    }));
    if (!feuillesChoisies?.length && toutes.length > 1)
      return { choisirFeuille: true as const, feuillesDispo };
    const feuilles = feuillesChoisies?.length
      ? toutes.filter((f) => feuillesChoisies.includes(f.nom))
      : toutes;
    if (!feuilles.length)
      throw new BadRequestException(
        'La feuille choisie n’est pas dans ce fichier (ou n’a pas les colonnes attendues).',
      );
    // La compilation passe d'abord : elle fait foi. Les feuilles par motif sont lues ensuite pour
    // ne pas perdre les demandes que la compilation n'a pas reprises.
    const choisies = [...feuilles].sort(
      (a, b) =>
        Number(cleCompacte(b.nom).startsWith('COMPIL')) -
        Number(cleCompacte(a.nom).startsWith('COMPIL')),
    );
    const deps = new Map((await this.deps.find()).map((d) => [d.code, d.id]));
    const nomsDeps = new Map(
      (await this.deps.find()).map((d) => [d.id, d.nom] as const),
    );
    const base = await this.repo.find();
    const existants = new Map(base.map((d) => [d.cle, d]));

    type Retenue = {
      l: Ligne;
      feuille: string;
      nom: string;
      motif: MotifMutation;
      cle: string;
      ligne: string;
      /** Lignes identiques fusionnées dans celle-ci : elles complètent les cases vides. */
      complements?: Ligne[];
    };
    const retenues: Retenue[] = [];
    const parFeuille = new Map(
      choisies.map((f) => [f.nom, { nom: f.nom, lues: 0, retenues: 0 }]),
    );
    let ignorees = 0;
    let dejaVues = 0;
    const premiere = new Map<string, Retenue>();
    const dansCompil = new Set<string>();
    const personne = (nom: string, l: Ligne) =>
      `${normaliser(nom)}|${codeDepartement(champ(l, 'DEPARTEMENTSOLLICITE')) ?? ''}`;
    const details = {
      aMettreAJour: [] as {
        cle: string;
        nom: string;
        motif: string;
        existant: { id: string; numero: number; bloquee: string | null };
        ecarts: {
          champ: string;
          libelle: string;
          base: string;
          fichier: string;
        }[];
      }[],
      doublonsFichier: [] as {
        cle: string;
        nom: string;
        motif: string;
        valeurs: Apercu;
        avec: { cle: string; nom: string; motif: string; valeurs: Apercu };
        exact: boolean;
        raison: string;
      }[],
      personnel: [] as {
        cle: string;
        nom: string;
        motif: string;
        etat: 'TROUVE' | 'DOUTE' | 'INTROUVABLE';
        fiche: { id: number; numero: string | null; nom: string } | null;
        candidats: number;
        ecarts: {
          champ: string;
          libelle: string;
          demande: string;
          personnel: string;
        }[];
        manquants: { champ: string; libelle: string; personnel: string }[];
        choix: string;
      }[],
      doublonsBase: [] as {
        cle: string;
        nom: string;
        motif: string;
        existant: {
          id: string;
          numero: number;
          nom: string;
          motif: string;
          departement: string | null;
          etat: string;
          valeurs: Apercu;
        };
        valeurs: Apercu;
        raison: string;
      }[],
    };
    const rapport = {
      feuillesDispo,
      feuilles: choisies.map((f) => f.nom),
      parFeuille: [] as { nom: string; lues: number; retenues: number }[],
      lues: 0,
      creees: 0,
      misesAJour: 0,
      identiques: 0,
      fusionnees: 0,
      ecartees: 0,
      ignorees,
      dejaDansCompilation: 0,
      numerosAttribues: 0,
      numerosCorriges: 0,
      numerosEnDouble: [] as number[],
      anomalies: {} as Record<string, number>,
    };
    const libMotif = (m: string) => MOTIFS[m as MotifMutation]?.libelle ?? m;

    // 1. Lecture : une ligne par demande (personne + motif)
    const champsDe = (l: Ligne, nom: string, motif: MotifMutation) => {
      const statutBrut = cleCompacte(sansPrefixeNumero(champ(l, 'STATUT')));
      const obs = nettoyer(champ(l, 'OBS'));
      const { grade, echelon } = lireGradeEchelon(
        champ(l, 'GRADEECHELLON', 'GRADE'),
      );
      const codeO = codeDepartement(champ(l, 'DEPARTEMENTDORIGINE'));
      const codeS = codeDepartement(champ(l, 'DEPARTEMENTSOLLICITE'));
      const matricule = nettoyer(champ(l, 'MATRICULESOLDE', 'MATRICULE'));
      const lieuSollicite = nettoyer(champ(l, 'LIEUSOLLICITE', 'PERMUTATION'));
      const champs: Partial<DemandeMutation> = {
        dateEnregistrement: lireDate(champ(l, 'DATEDENREG')),
        nomComplet: nom,
        genre:
          /\bNEE\b/.test(normaliser(nom)) || statutBrut.includes('ACTIVE')
            ? 'F'
            : 'M',
        grade,
        echelon,
        gradeBrut: nettoyer(champ(l, 'GRADEECHELLON', 'GRADE')),
        matricule:
          matricule && cleCompacte(matricule) !== 'X' ? matricule : null,
        typeAgent: cleCompacte(obs).includes('FINALISTE')
          ? 'FINALISTE'
          : 'FONCTIONNAIRE',
        statutAgent:
          statutBrut.startsWith('PERSONNEL') || statutBrut === 'PA'
            ? 'PERSONNEL_ADMINISTRATIF'
            : 'ENSEIGNANT',
        departementOrigineId: codeO ? (deps.get(codeO) ?? null) : null,
        lieuService: nettoyer(champ(l, 'LIEUDESERVICE')),
        cycle: codeCycle(champ(l, 'CYCLE')),
        specialite: nettoyer(champ(l, 'SPECIALITE')),
        dureeMois: lireDuree(champ(l, 'DUREE')),
        departementSolliciteId: codeS ? (deps.get(codeS) ?? null) : null,
        lieuSollicite:
          cleCompacte(lieuSollicite) === 'PERMUTE' ? null : lieuSollicite,
        motif,
        justificatif: nettoyer(champ(l, 'JUSTIFICATIF', 'REFACTEDEMARIAGE')),
        origine: nettoyer(champ(l, 'ORIGINE')),
        observation: obs,
      };
      champs.anomalies = anomaliesMutation(champs);
      return champs;
    };
    const apercu = (c: Partial<DemandeMutation>): Apercu => ({
      matricule: c.matricule ?? null,
      grade: c.gradeBrut ?? null,
      cycle: c.cycle ?? null,
      origine: c.departementOrigineId
        ? (nomsDeps.get(c.departementOrigineId) ?? null)
        : null,
      lieuService: c.lieuService ?? null,
      sollicite: c.departementSolliciteId
        ? (nomsDeps.get(c.departementSolliciteId) ?? null)
        : null,
      lieuSollicite: c.lieuSollicite ?? null,
    });
    /** Cases vides de `cible` remplies avec `source` (fusion de deux lignes de la même personne). */
    const completer = (
      cible: Partial<DemandeMutation>,
      source: Partial<DemandeMutation>,
    ) => {
      for (const [k, v] of Object.entries(source)) {
        const actuel = (cible as Record<string, unknown>)[k];
        if (
          v !== null &&
          v !== undefined &&
          v !== '' &&
          (actuel === null || actuel === undefined || actuel === '')
        )
          (cible as Record<string, unknown>)[k] = v;
      }
      cible.anomalies = anomaliesMutation(cible);
      return cible;
    };
    for (const f of choisies) {
      const compte = parFeuille.get(f.nom)!;
      const estCompil = cleCompacte(f.nom).startsWith('COMPIL');
      for (const l of f.lignes) {
        const nom = nettoyer(champ(l, 'NOMSETPRENOMS'));
        const motif = codeMotif(champ(l, 'MOTIF'));
        if (!nom || !motif) {
          ignorees++;
          continue;
        }
        compte.lues++;
        const cle = `I|${normaliser(nom)}|${motif}`;
        const ligne = `${f.nom}#${l._ligne}`;
        const dejaLa = premiere.get(cle);
        if (dejaLa) {
          // Même feuille : vraie ligne en double (fusionnée par défaut) ; autre feuille : déjà reprise
          if (dejaLa.feuille === f.nom) {
            details.doublonsFichier.push({
              cle: ligne,
              nom,
              motif: libMotif(motif),
              valeurs: apercu(champsDe(l, nom, motif)),
              avec: {
                cle: dejaLa.ligne,
                nom: dejaLa.nom,
                motif: libMotif(dejaLa.motif),
                valeurs: apercu(champsDe(dejaLa.l, dejaLa.nom, dejaLa.motif)),
              },
              exact: true,
              raison: 'même nom, même motif',
            });
            // FUSION : une seule demande, complétée ; REMPLACER : cette ligne-ci à la place de
            // l'autre ; IGNORER : on garde l'autre ; AJOUTER : deux demandes
            const d = decisions[ligne] ?? 'FUSION';
            if (d === 'REMPLACER') {
              dejaLa.l = l;
              rapport.ecartees++;
            } else if (d === 'AJOUTER') {
              // Deux demandes distinctes : la seconde garde sa propre clé
              retenues.push({
                l,
                feuille: f.nom,
                nom,
                motif,
                cle: `${cle}|${ligne}`,
                ligne,
              });
              compte.retenues++;
            } else if (d === 'IGNORER') rapport.ecartees++;
            else {
              dejaLa.complements = [...(dejaLa.complements ?? []), l];
              rapport.fusionnees++;
            }
          } else dejaVues++;
          continue;
        }
        if (estCompil) dansCompil.add(personne(nom, l));
        else if (dansCompil.has(personne(nom, l))) {
          dejaVues++;
          continue;
        }
        const r = { l, feuille: f.nom, nom, motif, cle, ligne };
        premiere.set(cle, r);
        compte.retenues++;
        retenues.push(r);
      }
    }
    rapport.parFeuille = [...parFeuille.values()];
    rapport.dejaDansCompilation = dejaVues;
    rapport.ignorees = ignorees;

    // Numéros : celui du registre quand il est écrit ; sinon le suivant du plus grand connu
    const numerosFichier = retenues.map((r) =>
      lireNumeroEnregistrement(champ(r.l, 'NDENREG')),
    );
    let numero =
      Math.max(
        (await this.prochainNumero()) - 1,
        ...numerosFichier.map((n) => n ?? 0),
      ) + 1;
    const numerosEcrits = new Set(
      numerosFichier.filter((n): n is number => n !== null),
    );
    const utilises = new Map<number, number>();
    /** Numéros écrits dans ce fichier ou donnés par cet import. */
    const touches = new Set<number>();
    for (const d of existants.values())
      utilises.set(
        d.numeroEnregistrement,
        (utilises.get(d.numeroEnregistrement) ?? 0) + 1,
      );

    // Index des demandes de la base (noms, matricules) : les demandes proches
    const index = new IndexNoms<DemandeMutation>();
    for (const d of base) index.ajouter(d.nomComplet, null, d);
    const parMatricule = new Map<string, DemandeMutation[]>();
    for (const d of base) {
      const m = cleCompacte(d.matricule);
      if (m.length >= 4)
        parMatricule.set(m, [...(parMatricule.get(m) ?? []), d]);
    }
    const etatDe = (d: DemandeMutation) =>
      d.noteId
        ? 'dans une note'
        : d.retiree
          ? 'retirée'
          : d.instructionMinistre === 'ACCORDEE'
            ? 'accordée'
            : d.instructionMinistre
              ? 'refusée'
              : 'en instruction';
    const CHAMPS: [keyof DemandeMutation, string][] = [
      ['matricule', 'Matricule'],
      ['gradeBrut', 'Grade/échelon'],
      ['departementOrigineId', 'Département d’origine'],
      ['lieuService', 'Lieu de service'],
      ['cycle', 'Cycle'],
      ['specialite', 'Spécialité'],
      ['departementSolliciteId', 'Département sollicité'],
      ['lieuSollicite', 'Lieu sollicité'],
      ['justificatif', 'Justificatif'],
      ['origine', 'Origine'],
      ['observation', 'Observation'],
    ];
    const lisible = (champ: keyof DemandeMutation, v: unknown) =>
      champ === 'departementOrigineId' || champ === 'departementSolliciteId'
        ? v
          ? String(nomsDeps.get(v as number) ?? v)
          : ''
        : String(v ?? '');
    // Fichiers anciens : la date d'enregistrement n'est pas comparée

    // Lignes du fichier déjà retenues comme nouvelles demandes (noms proches dans le fichier)
    const vusFichier = new IndexNoms<{
      r: Retenue;
      champs: Partial<DemandeMutation>;
      id: string | null;
    }>();
    const parMatriculeFichier = new Map<
      string,
      { r: Retenue; champs: Partial<DemandeMutation>; id: string | null }
    >();
    // Base du personnel (07/11/2026) : la fiche de chaque agent, LUE seulement
    const champsListe = retenues.map((r) => {
      const c = champsDe(r.l, r.nom, r.motif);
      for (const x of r.complements ?? [])
        completer(c, champsDe(x, r.nom, r.motif));
      return c;
    });
    const situations = await this.rattachement.chercherPour(
      retenues.map((r, i) => ({
        id: r.ligne,
        nom: r.nom,
        matricule: champsListe[i].matricule ?? null,
        departementId: champsListe[i].departementOrigineId ?? null,
      })),
    );
    const bilanPersonnel = {
      trouvees: 0,
      doute: 0,
      introuvables: 0,
      avecEcarts: 0,
      aCompleter: 0,
    };
    for (const [i, r] of retenues.entries()) {
      const champs = champsListe[i];
      {
        const s = situations.get(r.ligne);
        if (s?.fiche) {
          bilanPersonnel.trouvees++;
          const pv = this.valeursDuPersonnel(s.fiche);
          const ecarts: {
            champ: string;
            libelle: string;
            demande: string;
            personnel: string;
          }[] = [];
          const manquants: {
            champ: string;
            libelle: string;
            personnel: string;
          }[] = [];
          for (const [k, libelle] of CHAMPS_PERSONNEL) {
            const p = pv[k];
            if (videMut(p)) continue;
            const dv = champs[k];
            const vue = (x: unknown) => this.lisiblePersonnel(k, x, nomsDeps);
            if (videMut(dv))
              manquants.push({ champ: String(k), libelle, personnel: vue(p) });
            else if (!pareilPersonnel(k, dv, p))
              ecarts.push({
                champ: String(k),
                libelle,
                demande: vue(dv),
                personnel: vue(p),
              });
          }
          const choix =
            o.personnel?.[r.ligne] === 'PERSONNEL' ? 'PERSONNEL' : 'GARDER';
          const prendre = (k: keyof DemandeMutation) => {
            (champs as Record<string, unknown>)[k] = pv[k];
            if (k === 'gradeBrut') {
              champs.grade = pv.grade;
              champs.echelon = pv.echelon;
            }
          };
          if (o.completer !== false)
            for (const m of manquants)
              prendre(m.champ as keyof DemandeMutation);
          if (choix === 'PERSONNEL')
            for (const e of ecarts) prendre(e.champ as keyof DemandeMutation);
          if (
            (o.completer !== false && manquants.length) ||
            (choix === 'PERSONNEL' && ecarts.length)
          )
            champs.anomalies = anomaliesMutation(champs);
          if (ecarts.length) bilanPersonnel.avecEcarts++;
          if (manquants.length) bilanPersonnel.aCompleter++;
          if (ecarts.length || manquants.length)
            details.personnel.push({
              cle: r.ligne,
              nom: r.nom,
              motif: libMotif(r.motif),
              etat: 'TROUVE',
              fiche: {
                id: s.fiche.id,
                numero: s.fiche.numeroFiche,
                nom: s.fiche.nomComplet,
              },
              candidats: s.candidats,
              ecarts,
              manquants,
              choix,
            });
        } else {
          // Pas trouvée (ou plusieurs fiches possibles) : signalé, jamais bloquant
          const doute = s?.etat === 'A_VERIFIER';
          if (doute) bilanPersonnel.doute++;
          else bilanPersonnel.introuvables++;
          details.personnel.push({
            cle: r.ligne,
            nom: r.nom,
            motif: libMotif(r.motif),
            etat: doute ? 'DOUTE' : 'INTROUVABLE',
            fiche: null,
            candidats: s?.candidats ?? 0,
            ecarts: [],
            manquants: [],
            choix: 'GARDER',
          });
        }
      }
      for (const a of champs.anomalies ?? [])
        rapport.anomalies[a] = (rapport.anomalies[a] ?? 0) + 1;
      const ex = existants.get(r.cle);
      // a. Même personne, même motif : déjà dans la base
      if (ex) {
        const ecarts = CHAMPS.flatMap(([c, libelle]) => {
          const f = lisible(c, champs[c]);
          const b = lisible(c, ex[c]);
          return f.trim() && normaliser(f) !== normaliser(b)
            ? [{ champ: String(c), libelle, base: b, fichier: f }]
            : [];
        });
        const bloquee = ex.noteId
          ? 'déjà dans une note'
          : ex.instructionMinistre
            ? 'déjà décidée par le Ministre'
            : null;
        // Numéro : le registre fait foi (ancienne numérotation corrigée)
        const ecrit = numerosFichier[i];
        let nouveau: number | null = null;
        if (!bloquee) {
          if (ecrit !== null && ecrit !== ex.numeroEnregistrement)
            nouveau = ecrit;
          else if (
            ecrit === null &&
            ex.canal !== 'PORTAIL' &&
            numerosEcrits.has(ex.numeroEnregistrement)
          )
            nouveau = numero++;
        }
        if (!ecarts.length && nouveau === null) {
          rapport.identiques++;
          continue;
        }
        if (ecarts.length)
          details.aMettreAJour.push({
            cle: r.ligne,
            nom: r.nom,
            motif: libMotif(r.motif),
            existant: { id: ex.id, numero: ex.numeroEnregistrement, bloquee },
            ecarts,
          });
        // Par défaut, le fichier (le registre tenu à jour) met la demande à jour
        const d = decisions[r.ligne] ?? 'MAJ';
        if (bloquee || d === 'IGNORER') {
          rapport.identiques++;
          continue;
        }
        if (nouveau !== null) {
          utilises.set(
            ex.numeroEnregistrement,
            (utilises.get(ex.numeroEnregistrement) ?? 1) - 1,
          );
          utilises.set(nouveau, (utilises.get(nouveau) ?? 0) + 1);
          touches.add(nouveau);
          champs.numeroEnregistrement = nouveau;
          rapport.numerosCorriges++;
        }
        if (!essai) await this.repo.update(ex.id, champs);
        rapport.misesAJour++;
        continue;
      }
      // b. Demande proche dans la base : même matricule, ou même nom écrit autrement
      const m = cleCompacte(champs.matricule);
      const parMat = m.length >= 4 ? (parMatricule.get(m) ?? []) : [];
      const parNom = index.memesNoms(r.nom);
      const proche = [...parMat, ...parNom].find((x) => x.cle !== r.cle);
      if (proche) {
        details.doublonsBase.push({
          cle: r.ligne,
          nom: r.nom,
          motif: libMotif(r.motif),
          existant: {
            id: proche.id,
            numero: proche.numeroEnregistrement,
            nom: proche.nomComplet,
            motif: libMotif(proche.motif),
            departement: proche.departementSolliciteId
              ? (nomsDeps.get(proche.departementSolliciteId) ?? null)
              : null,
            etat: etatDe(proche),
            valeurs: apercu(proche),
          },
          valeurs: apercu(champs),
          raison: parMat.includes(proche)
            ? 'même matricule'
            : proche.motif === r.motif
              ? 'nom très proche, même motif'
              : 'même personne, autre motif',
        });
        const d = decisions[r.ligne] ?? 'AJOUTER';
        if (d === 'IGNORER') {
          rapport.ecartees++;
          continue;
        }
        if (d === 'MAJ') {
          if (proche.noteId || proche.instructionMinistre) {
            rapport.ecartees++;
            continue;
          }
          if (!essai)
            await this.repo.update(proche.id, { ...champs, cle: r.cle });
          rapport.misesAJour++;
          continue;
        }
      }
      // c. Deux noms très proches (ou même matricule) dans le fichier : deux personnes par défaut
      const mf = cleCompacte(champs.matricule);
      const procheFichier =
        (mf.length >= 4 ? parMatriculeFichier.get(mf) : undefined) ??
        vusFichier
          .memesNoms(r.nom)
          .find((x) => normaliser(x.r.nom) !== normaliser(r.nom));
      if (procheFichier && procheFichier.r.cle !== r.cle) {
        details.doublonsFichier.push({
          cle: r.ligne,
          nom: r.nom,
          motif: libMotif(r.motif),
          valeurs: apercu(champs),
          avec: {
            cle: procheFichier.r.ligne,
            nom: procheFichier.r.nom,
            motif: libMotif(procheFichier.r.motif),
            valeurs: apercu(procheFichier.champs),
          },
          exact: false,
          raison:
            mf.length >= 4 && cleCompacte(procheFichier.champs.matricule) === mf
              ? 'même matricule'
              : 'nom très proche',
        });
        const d = decisions[r.ligne] ?? 'AJOUTER';
        if (d === 'IGNORER') {
          rapport.ecartees++;
          continue;
        }
        if (d === 'FUSION' || d === 'REMPLACER') {
          // La demande déjà retenue garde sa clé ; elle est complétée, ou prend cette ligne-ci
          const valeurs =
            d === 'FUSION'
              ? completer({ ...procheFichier.champs }, champs)
              : { ...champs, nomComplet: champs.nomComplet };
          if (!essai && procheFichier.id)
            await this.repo.update(procheFichier.id, {
              ...valeurs,
              anomalies: anomaliesMutation(valeurs),
            });
          procheFichier.champs = valeurs;
          if (d === 'FUSION') rapport.fusionnees++;
          else rapport.ecartees++;
          continue;
        }
      }
      // d. Nouvelle demande
      let n = numerosFichier[i];
      if (n === null) {
        n = numero++;
        rapport.numerosAttribues++;
      }
      utilises.set(n, (utilises.get(n) ?? 0) + 1);
      touches.add(n);
      let id: string | null = null;
      if (!essai) {
        const nouvelle = await this.repo.save({
          ...champs,
          cle: r.cle,
          numeroEnregistrement: n,
          saisiePar: u.nom,
        });
        existants.set(r.cle, nouvelle);
        id = nouvelle.id;
      }
      const vu = { r, champs, id };
      vusFichier.ajouter(r.nom, null, vu);
      if (mf.length >= 4 && !parMatriculeFichier.has(mf))
        parMatriculeFichier.set(mf, vu);
      rapport.creees++;
    }
    rapport.lues = retenues.length;
    // Seulement les numéros de ce fichier (ceux déjà en double dans la base ne sont pas son affaire)
    for (const n of numerosFichier) if (n !== null) touches.add(n);
    rapport.numerosEnDouble = [...utilises]
      .filter(([n, fois]) => fois > 1 && touches.has(n))
      .map(([n]) => n)
      .sort((a, b) => a - b);
    if (!essai) {
      await this.journal.log(u, 'IMPORT_MUTATIONS', 'demande_mutation', null, {
        ...rapport,
        feuillesDispo: undefined,
      });
      await this.circuit.mettreEnCircuit();
    }
    const MAX = 2000;
    return {
      ...rapport,
      personnel: bilanPersonnel,
      details: {
        personnel: details.personnel.slice(0, MAX * 3),
        aMettreAJour: details.aMettreAJour.slice(0, MAX),
        doublonsFichier: details.doublonsFichier.slice(0, MAX),
        doublonsBase: details.doublonsBase.slice(0, MAX),
      },
      tronque: Object.values(details).some((l) => l.length > MAX),
    };
  }
}
