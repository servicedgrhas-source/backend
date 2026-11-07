import { joursDepuis } from '../common/jours';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { randomUUID } from 'crypto';
import { In, IsNull, Not, Repository } from 'typeorm';
import { AffectationService } from '../affectation/affectation.service';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  codeCycle,
  GROUPES_MUTATION,
  LIBELLE_CYCLE,
  LIBELLE_GROUPE,
  MOTIFS,
  MOTIFS_MUTATION,
  NOTES_AFFECTATION,
  TYPES_NOTE_AFFECTATION,
  titreDepartement,
  type GroupeMutation,
  type MotifMutation,
  type TypeNoteAffectation,
} from '../common/referentiels';
import {
  dateEnLettres,
  entierVersRomain,
  normaliser,
  siglesDesDirections,
  structureAbregee,
} from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  GROUPES_QUOTA,
  groupeQuota,
  libelleLot,
  libelleLots,
  ordreLots,
  enTete,
  repereLot,
} from '../common/lots';
import {
  Affectation,
  Alerte,
  DemandeMutation,
  Departement,
  LotPublication,
  NoteService,
  CampagneEnrolement,
  Enrole,
  type Rectification,
  Nomination,
  Structure,
  type AvisConformite,
} from '../entities';
import { MutationService } from '../mutation/mutation.service';
import { AffectationsPersonnelService } from '../recensement/affectations-personnel.service';
import { RattachementService } from '../rattachement/rattachement.service';
import {
  DIPLOMES_ENROLEMENT,
  noteEnrolementDe,
} from '../enrolement/enrolement.service';
import { nombreEnLettres } from '../common/lettres';
import { enteteParDefaut, noteWord } from './note-word';
import {
  CATEGORIE as CATEGORIE_NOMINATION,
  echelonBase,
  gradeAbrege,
  repereNomination,
} from '../nominations/categories';
import { NominationsService } from '../nominations/nominations.service';

export interface Colonne {
  cle: string;
  libelle: string;
}

export interface LigneNote {
  id: string;
  n: number;
  [cle: string]: string | number | null;
}

export interface SectionNote {
  /** Titre du département (« I- DEPARTEMENT DE LA BOUENZA »), sur le premier tableau du département. */
  titre: string | null;
  /** Notes d'enrôlement : « Quatre-vingt-deux (82) », sous le titre du département. */
  effectif?: string | null;
  /** Établissement (« Lycée de Bouansa ») quand les personnes du département en ont un. */
  sousTitre?: string | null;
  lignes: LigneNote[];
}

export interface ContenuNote {
  titre: string;
  introduction: string;
  colonnes: Colonne[];
  classification: boolean;
  sections: SectionNote[];
  total: number;
  departements: number;
  ampliations: { libelle: string; nombre: string }[];
  mentions: string[];
  piedDePage: string;
  repere: string;
}

/** « conformément aux tableaux ci-après » devient « au tableau » s'il n'y en a qu'un. */
export function accordTableaux(texte: string, nbTableaux: number) {
  return nbTableaux > 1
    ? texte.replace(/au tableau ci-après/g, 'aux tableaux ci-après')
    : texte.replace(/aux tableaux ci-après/g, 'au tableau ci-après');
}

/** Abréviations du repère imprimé en haut des notes de mutation. */
const ABREGE_MOTIF: Record<MotifMutation, string> = {
  RAPPROCHEMENT_CONJOINT: 'Rapp.Conj.',
  RAISONS_SOCIALES: 'Rais.Soc.',
  RAISONS_SANTE: 'Rais.Santé',
  PERMUTATION: 'Permut.',
  ANCIENNETE: 'Ancien.',
};

const GROUPE_COURT: Record<GroupeMutation, string> = {
  PRESCO_PRIMAIRE: 'Préscolaire-Primaire',
  COLLEGE_LYCEE_ADMIN: 'Collège-Lycée-Administration',
};

/** Objet de la note imprimé en bas à gauche : « Mutations Rapprochement de Conjoints ». */
const OBJET_MUTATION: Record<MotifMutation, string> = {
  RAPPROCHEMENT_CONJOINT: 'Mutations Rapprochement de Conjoints',
  RAISONS_SOCIALES: 'Mutations Raisons Sociales',
  RAISONS_SANTE: 'Mutations Raisons de Santé',
  PERMUTATION: 'Permutations',
  ANCIENNETE: 'Mutations Ancienneté',
};

const COLONNES_LIBELLES: Record<string, string> = {
  CYCLE: 'Cycle',
  SPECIALITE: 'Spécialité',
  ETABLISSEMENT: 'Etablissements',
  OBS: 'Obs',
  STRUCTURE: 'Structure',
};

export interface Entete {
  reference: string;
  signataireTitre: string;
  signataireNom: string;
  lieu: string;
  piedDroite: string;
  piedDroiteModele?: string;
  adresse: string;
  /** Police de la note : Times New Roman ou Sylfaen (paramètre, jamais figé avec la note). */
  police?: 'Times New Roman' | 'Sylfaen';
  /** Lignes du ministère, « --- » pour un trait (06/11/2026) ; libre : réécrites pour cette note. */
  lignes?: string[];
  libre?: boolean;
}

/** Critères pour découper une note en lots (06/11/2026) : enrôlement et mutation. */
export const CRITERES_LOT = {
  specialite: {
    libelle: 'Par spécialité',
    court: 'Spécialités',
    vide: 'Sans spécialité',
  },
  diplome: {
    libelle: 'Par diplôme',
    court: 'Diplômes',
    vide: 'Diplôme non précisé',
  },
  promotion: {
    libelle: 'Par promotion',
    court: 'Promotions',
    vide: 'Promotion non précisée',
  },
  cycle: { libelle: 'Par cycle', court: 'Cycles', vide: 'Cycle non précisé' },
  origine: {
    libelle: "Par département d'origine",
    court: "Départements d'origine",
    vide: 'Origine non précisée',
  },
  departement: {
    libelle: 'Par département',
    court: 'Départements',
    vide: 'Sans département',
  },
} as const;
const CRITERES_ENROLEMENT = [
  'specialite',
  'diplome',
  'promotion',
  'departement',
];
const CRITERES_MUTATION = ['departement', 'cycle', 'specialite', 'origine'];
/** Une personne d'une note à découper : son département dans la note et les valeurs des critères. */
/** Demande accordée qui attend hors de la note de mutation, et pourquoi (07/11/2026). */
interface TenueMutation {
  d: DemandeMutation;
  raisons: string[];
}

interface GensNote {
  id: string;
  nom: string;
  cleTri: string;
  departementId: number | null;
  valeurs: Partial<Record<string, string>>;
}
export type CritereLot = keyof typeof CRITERES_LOT;

/**
 * Notes d'enrôlement, d'après les notes signées (2018-2023) et le cadrage du 05/11/2026 :
 * « titulaires du … » (repris dans l'additif et le rectificatif), pied de page, colonnes par défaut.
 */
const INTRO_ENROLEMENT = (titulaires: string) =>
  `Les enseignants finalistes dont les noms et prénoms suivent, titulaires ${titulaires}, reçoivent les affectations ci-dessous en qualité d'enseignants volontaires, dans les départements ci-après, au titre de l'année scolaire {annee}.`;
const COLONNES_ENROLEMENT = ['naissance', 'lieu', 'promotion', 'specialite'];
const NOTES_ENROLEMENT: Record<
  string,
  {
    court: string;
    titulaires: string;
    introduction: string;
    colonnes: string[];
  }
> = Object.fromEntries(
  (
    [
      [
        'MASTER',
        'ENS/Master et CAPES',
        "du master d'enseignement ou du certificat d'aptitude au professorat de l'enseignement secondaire (CAPES) de l'Ecole Normale Supérieure (ENS)",
      ],
      [
        'LICENCE',
        'ENS/Licence et CAP-CEG',
        "de la licence d'enseignement ou du certificat d'aptitude au professorat dans les collèges d'enseignement général (CAP-CEG) de l'Ecole Normale Supérieure (ENS)",
      ],
      ['DEMA', 'DEMA', 'du DEMA'],
      ['DCAF', 'DCAF', 'du DCAF'],
      [
        'CFEEN',
        'ENI (cycle primaire)',
        "du certificat de fin d'études des écoles normales (CFEEN) des Ecoles Normales des Instituteurs (ENI), spécialité : primaire",
      ],
      [
        'BET',
        'ENI et CETF (cycle préscolaire)',
        "du certificat de fin d'études des écoles normales (CFEEN) des Ecoles Normales des Instituteurs (ENI) ou du brevet d'études techniques (BET) des Collèges d'Enseignement Technique Féminin (CETF), spécialité : préscolaire",
      ],
      ['AUTRE', 'Volontaires', "d'un diplôme professionnel de l'enseignement"],
    ] as const
  ).map(([code, court, titulaires]) => [
    code,
    {
      court,
      titulaires,
      introduction: INTRO_ENROLEMENT(titulaires),
      // Préscolaire : la colonne « Diplôme » (BET ou CFEEN) au lieu de la spécialité, comme la note n° 072
      colonnes:
        code === 'BET'
          ? ['naissance', 'lieu', 'promotion', 'diplome']
          : COLONNES_ENROLEMENT,
    },
  ]),
);
/** Colonnes possibles d'une note d'enrôlement (en plus du N° et du nom). */
const COLONNES_POSSIBLES: Record<string, string> = {
  naissance: 'Date de nais.',
  lieu: 'Lieu de nais.',
  promotion: 'Promotion',
  specialite: 'Spécialité',
  diplome: 'Diplôme',
  etablissement: 'Etablissement',
};

/**
 * Colonnes possibles d'une note de mutation (en plus du N° et du nom). « Durée » et « Justification »
 * sont mises par défaut : le DG veut voir sur le projet de note de quoi décider (réunion du 06/11/2026).
 */
const COLONNES_MUTATION: Record<string, string> = {
  ge: 'G/E',
  matricule: 'Matricule Solde',
  cycle: 'Cycle',
  specialite: 'Spécialité',
  ancienPoste: 'Ancien Poste',
  origine: "Dépar-tement d'origine",
  accueil: "Dépar-tement d'accueil",
  lieuSollicite: 'Lieu sollicité',
  duree: 'Durée dans le poste',
  justification: 'Justification',
  obs: 'Obs',
};
const COLONNES_MUTATION_DEFAUT = [
  'ge',
  'matricule',
  'cycle',
  'specialite',
  'ancienPoste',
  'origine',
  'duree',
  'justification',
  'obs',
];

/** « 7 ans », « 8 mois », « 3 ans 2 mois » ; sinon calculée depuis la prise de service. */
function dureeDansLePoste(d: DemandeMutation) {
  let mois = d.dureeMois;
  if ((mois === null || mois === undefined) && d.datePriseService) {
    const debut = new Date(d.datePriseService);
    if (!Number.isNaN(debut.getTime())) {
      const m = new Date();
      mois =
        (m.getFullYear() - debut.getFullYear()) * 12 +
        (m.getMonth() - debut.getMonth());
    }
  }
  if (mois === null || mois === undefined || mois < 0) return null;
  const a = Math.floor(mois / 12);
  const r = mois % 12;
  return (
    [a ? `${a} an${a > 1 ? 's' : ''}` : '', r ? `${r} mois` : '']
      .filter(Boolean)
      .join(' ') || 'Moins d’un mois'
  );
}

/** « Quatre-vingt-deux (82) », « Quatre (04) » : effectif d'un département sur la note. */
const effectifEnLettres = (n: number) => {
  const l = nombreEnLettres(n);
  return `${l.charAt(0).toUpperCase()}${l.slice(1)} (${String(n).padStart(2, '0')})`;
};

/** Diplôme d'un volontaire tel qu'écrit sur la note : « BET-Préscolaire », « CFEEN-Préscolaire », « CAPES »… */
function diplomeSurLaNote(e: Enrole) {
  const brut = normaliser(e.diplomePrecision ?? '').replace(/[^A-Z]/g, '');
  if (
    e.diplome === 'BET' ||
    (e.diplome === 'CFEEN' && noteEnrolementDe(e) === 'BET')
  )
    return brut.startsWith('CFEEN') ||
      brut.startsWith('CEFEN') ||
      e.diplome === 'CFEEN'
      ? 'CFEEN-Préscolaire'
      : 'BET-Préscolaire';
  if (e.diplome === 'MASTER')
    return brut.startsWith('CAPES')
      ? 'CAPES'
      : brut.startsWith('MAITRISE')
        ? 'Maîtrise'
        : 'Master';
  if (e.diplome === 'LICENCE')
    return brut.startsWith('CAPCEG') ? 'CAP-CEG' : 'Licence';
  return e.diplomePrecision?.trim() || e.diplome;
}

type Niveau = AvisConformite['niveau'];

const LIBELLE_NIVEAU: Record<Niveau, string> = {
  BUREAU: 'le chef de bureau',
  SERVICE: 'le chef de service',
  DIRECTION: 'le directeur',
};
const NIVEAU_PAR_ROLE: Record<string, Niveau> = {
  AGENT: 'BUREAU',
  CHEF_SERVICE: 'SERVICE',
  DIRECTEUR: 'DIRECTION',
  BUREAU_ETUDES: 'DIRECTION',
};
const NIVEAU_PAR_STRUCTURE: Record<string, Niveau> = {
  BUREAU_DGRHAS: 'BUREAU',
  SERVICE_DGRHAS: 'SERVICE',
  DIRECTION_DGRHAS: 'DIRECTION',
};

@Injectable()
export class NotesService {
  constructor(
    @InjectRepository(NoteService)
    private readonly notes: Repository<NoteService>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(DemandeMutation)
    private readonly demandes: Repository<DemandeMutation>,
    @InjectRepository(LotPublication)
    private readonly lots: Repository<LotPublication>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly affSvc: AffectationService,
    private readonly mutSvc: MutationService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    @InjectRepository(CampagneEnrolement)
    private readonly campagnes: Repository<CampagneEnrolement>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    private readonly personnel: AffectationsPersonnelService,
    private readonly nomSvc: NominationsService,
    private readonly rattachementSvc: RattachementService,
  ) {}

  private annee(
    module:
      'AFFECTATION' | 'MUTATION' | 'ENROLEMENT' | 'NOMINATION' = 'AFFECTATION',
  ) {
    return (
      (module === 'MUTATION' && this.params.get('ANNEE_SCOLAIRE_MUTATION')) ||
      this.params.get('ANNEE_SCOLAIRE')
    );
  }

  /**
   * Une note encore ouverte (pas validée) suit l'année scolaire réglée dans les paramètres ;
   * une note validée garde la sienne.
   */
  private async suivreAnnee(n: NoteService) {
    if (n.contenu || !['BROUILLON', 'SOUMISE'].includes(n.statut)) return n;
    if (n.module === 'ENROLEMENT' || n.module === 'NOMINATION') return n;
    const annee = this.annee(n.module);
    if (annee && annee !== n.anneeScolaire) {
      await this.notes.update(n.id, { anneeScolaire: annee });
      n.anneeScolaire = annee;
    }
    return n;
  }

  /**
   * Lignes d'ampliation gardées (les décochées sont retirées) ; les archives ne se décochent pas
   * et valent 2 sur le total des exemplaires : 2 + somme des lignes gardées.
   */
  private ampliationsGardees(
    toutes: ContenuNote['ampliations'],
    exclues: string[],
  ) {
    const gardees = toutes
      .filter((a) => a.libelle === 'Archives' || !exclues.includes(a.libelle))
      .map(({ libelle, nombre }) => ({ libelle, nombre }));
    const somme =
      gardees
        .filter((a) => a.libelle !== 'Archives')
        .reduce((s, a) => s + (Number(a.nombre) || 0), 0) + 2;
    return gardees.map((a) =>
      a.libelle === 'Archives' ? { ...a, nombre: `2/${somme}` } : a,
    );
  }

  private ampliations(dg: string | string[], nbDeps: number, total: number) {
    const fixes: [string, number][] = [
      ['MEPPSA-CAB', 2],
      ['IGEPSA', 2],
      ['DGRHAS-DRSC', 2],
      ...[dg].flat().map((x): [string, number] => [x, 2]),
      ['DGFP', 1],
      ['DGB-DGBCB-D/SOLDE', 3],
      ['DDEPPSA', nbDeps],
      ['Intéressés', total],
      ['Dossiers', total],
    ];
    const somme = fixes.reduce((s, [, n]) => s + n, 0) + 2;
    return [
      ...fixes.map(([libelle, n]) => ({ libelle, nombre: String(n) })),
      { libelle: 'Archives', nombre: `2/${somme}` },
    ];
  }

  /* ======================== Notes d'affectation ======================== */

  /**
   * Lignes éligibles : non exclues, sans blocage, pas encore dans une note validée, des groupes de
   * quota choisis (vide : tous). Une personne qu'une note ouverte plus ancienne couvre déjà (mêmes
   * lots, même type, même groupe) n'est pas reprise : jamais deux notes pour la même personne.
   */
  private async lignesAffectation(
    lotsIds: number[],
    typeNote: string,
    groupes: string[] = [],
    note?: NoteService,
  ) {
    const liste = await this.affSvc.listeAffectations({
      lotsIds,
      typeNote,
      statut: 'A_TRAITER',
      groupes,
    });
    const autres = (
      await this.notes
        .createQueryBuilder('n')
        .where("n.module = 'AFFECTATION' AND n.typeNote = :typeNote", {
          typeNote,
        })
        .andWhere("n.statut IN ('BROUILLON', 'SOUMISE')")
        .getMany()
    ).filter(
      (n) =>
        !note ||
        (n.id !== note.id &&
          new Date(n.creeLe).getTime() < new Date(note.creeLe).getTime()),
    );
    const couverte = (x: (typeof liste)[number]) =>
      autres.some(
        (n) =>
          [n.lotPublicationId, ...(n.lotsFusionnes ?? [])].includes(
            x.agent.lotPublicationId,
          ) &&
          (!n.groupes?.length || n.groupes.includes(groupeQuota(x.agent))),
      );
    const libres = liste.filter((x) => !couverte(x));
    return {
      prets: libres.filter((x) => !x.derive.bloquants.length),
      bloques: libres.filter((x) => x.derive.bloquants.length),
    };
  }

  private async contenuAffectation(
    note: NoteService,
  ): Promise<ContenuNote & { bloques: unknown[] }> {
    const lot = await this.lots.findOne({
      where: { id: note.lotPublicationId! },
    });
    const reunis = note.lotsFusionnes?.length
      ? await this.lots.find({ where: { id: In(note.lotsFusionnes) } })
      : [];
    const def = NOTES_AFFECTATION[note.typeNote as TypeNoteAffectation];
    const { prets, bloques } = await this.lignesAffectation(
      [lot!.id, ...reunis.map((l) => l.id)],
      note.typeNote,
      note.groupes ?? [],
      note,
    );
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const sigles = await siglesDesDirections(this.notes);

    const colonnes: Colonne[] = [
      { cle: 'nom', libelle: 'Noms et prénoms' },
      { cle: 'grade', libelle: 'Grade' },
      { cle: 'reference', libelle: def.libelleRef },
      ...def.colonnes.map((c) => ({
        cle: c.toLowerCase(),
        libelle: COLONNES_LIBELLES[c],
      })),
    ];
    const ligne = (x: (typeof prets)[number], n: number): LigneNote => ({
      id: x.id,
      n,
      nom: x.agent.nomComplet,
      grade: x.derive.grade,
      cat: x.derive.categorie,
      ech: x.derive.echelle,
      echl: x.derive.echelon,
      reference: x.derive.reference,
      cycle: x.derive.cycleLibelle,
      specialite: x.specialite,
      etablissement: x.etablissement,
      obs: x.obs ?? 'Ens. actif',
      structure: structureAbregee(x.structure, sigles),
      origine: x.origine,
    });

    const tri = (a: (typeof prets)[number], b: (typeof prets)[number]) =>
      a.agent.nomNormalise.localeCompare(b.agent.nomNormalise);
    let sections: SectionNote[];
    if (def.parDepartement) {
      sections = deps
        .map((d) => ({
          d,
          items: prets.filter((x) => x.departementId === d.id).sort(tri),
        }))
        .filter((s) => s.items.length)
        .flatMap((s, i): SectionNote[] => {
          const titre = `${entierVersRomain(i + 1)}- ${titreDepartement(s.d)}`;
          // Sans établissement : un seul tableau par département (présentation habituelle)
          if (!s.items.some((x) => x.etablissement))
            return [{ titre, lignes: s.items.map((x, j) => ligne(x, j + 1)) }];
          // Avec établissements : les personnes sans établissement (à la disposition de la
          // DDEPPSA) d'abord, puis un tableau par établissement, chacun numéroté à partir de 1
          const groupes = new Map<string, typeof s.items>();
          for (const x of s.items) {
            const k = x.etablissement?.trim() ?? '';
            groupes.set(k, [...(groupes.get(k) ?? []), x]);
          }
          return [...groupes.entries()]
            .sort(([a], [b]) =>
              a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'fr'),
            )
            .map(([etab, items], k) => ({
              titre: k === 0 ? titre : null,
              sousTitre: etab || null,
              lignes: items.map((x, j) => ligne(x, j + 1)),
            }));
        });
    } else {
      sections = [
        {
          titre: null,
          lignes: [...prets].sort(tri).map((x, j) => ligne(x, j + 1)),
        },
      ];
    }
    const nbDeps = new Set(prets.map((x) => x.departementId).filter(Boolean))
      .size;
    const annee = note.anneeScolaire;
    const typeTexte = note.typeNote.startsWith('DECRET') ? 'Déc' : 'Arr';
    const tableaux = sections.filter((s) => s.lignes.length).length;
    return {
      titre: 'NOTE DE SERVICE',
      introduction: accordTableaux(
        note.introduction.replaceAll('{annee}', annee),
        tableaux,
      ),
      colonnes,
      classification: true,
      sections: sections.filter((s) => s.lignes.length),
      total: prets.length,
      departements: nbDeps,
      ampliations: this.ampliations(
        def.directionGenerale,
        nbDeps,
        prets.length,
      ),
      mentions: [
        ...(def.fraisVoyage
          ? [
              'Les frais de voyage et de transport des bagages sont à la charge des intéressés.',
            ]
          : []),
        'La présente note de service prend effet à compter de la date de signature.',
      ],
      piedDePage: def.piedDePage.replaceAll('{annee}', annee),
      repere: [lot!, ...reunis]
        .map((l) => (l.rang ? repereLot(l) : `${typeTexte}/Lot${l.numero}`))
        .join('+'),
      bloques: bloques.map((x) => ({
        id: x.id,
        nom: x.agent.nomComplet,
        raisons: x.derive.bloquants,
      })),
    };
  }

  async preparerAffectation(u: UtilisateurConnecte, lotNumero: number) {
    return this.preparerSelection(u, [lotNumero], []);
  }

  /**
   * Notes de lots choisis ensemble (« Décrets lots III et IV ») et de groupes de quota choisis
   * (« quota MEPPSA et quota Autres avec département », DG 30/10/2026) : une note par type de note,
   * pour les personnes prêtes que n'a pas déjà une note ouverte.
   */
  async preparerSelection(
    u: UtilisateurConnecte,
    lotNumeros: number[],
    groupes: string[],
  ) {
    const lots = await this.lots.find({
      where: { numero: In(lotNumeros) },
      order: { numero: 'ASC' },
    });
    if (!lots.length) throw new NotFoundException('Lot introuvable');
    const ids = lots.map((l) => l.id);
    // Les trois groupes choisis : la note les couvre tous (comme une note d'avant les groupes)
    const choisis = GROUPES_QUOTA.every((g) => groupes.includes(g))
      ? []
      : GROUPES_QUOTA.filter((g) => groupes.includes(g));
    const creees: NoteService[] = [];
    for (const type of TYPES_NOTE_AFFECTATION) {
      const { prets } = await this.lignesAffectation(ids, type, choisis);
      if (!prets.length) continue;
      const rang =
        (await this.notes.count({
          where: {
            module: 'AFFECTATION',
            lotPublicationId: lots[0].id,
            typeNote: type,
          },
        })) + 1;
      creees.push(
        await this.notes.save({
          module: 'AFFECTATION',
          typeNote: type,
          lotPublicationId: lots[0].id,
          lotsFusionnes: ids.slice(1),
          groupes: choisis,
          anneeScolaire: this.annee(),
          rang,
          introduction: NOTES_AFFECTATION[type].introduction,
          statut: 'BROUILLON',
          creePar: u.nom,
        }),
      );
    }
    await this.journal.log(
      u,
      'PREPARATION_NOTES_AFFECTATION',
      'lot_publication',
      lots[0].id,
      {
        lots: lots.map((l) => l.numero),
        groupes: choisis,
        notes: creees.map((n) => n.typeNote),
      },
    );
    return creees;
  }

  /* ========================= Notes de mutation ========================= */

  /** Groupes d'une note de mutation : le sien et celui qu'on y a réuni (06/11/2026). */
  private groupesMutation(n: NoteService) {
    return [n.typeNote, ...(n.groupes ?? [])] as GroupeMutation[];
  }

  /** Demandes d'une note de mutation : accordées, de ses groupes, de son lot de rangement. */
  private async demandesDeLaNoteMutation(n: NoteService) {
    return (await this.lignesMutationNote(n)).prets;
  }

  /**
   * Les demandes accordées d'une note de mutation, en deux parts : celles qui entrent dans la
   * note, et celles qui attendent hors de la note parce qu'elles ont encore des points à vérifier
   * (DG, 07/11/2026 ; paramètre MUTATION_NOTE_SANS_POINTS). Corrigées, ou déclarées vérifiées sur
   * le dossier papier, elles rejoignent la note d'elles-mêmes.
   */
  private async lignesMutationNote(n: NoteService) {
    if (n.rectificatifDe)
      return { prets: [] as DemandeMutation[], tenues: [] as TenueMutation[] };
    const listes = await Promise.all(
      this.groupesMutation(n).map((g) =>
        this.mutSvc.eligiblesPourNote(n.motif as MotifMutation, g),
      ),
    );
    const toutes = listes
      .flat()
      .filter((d) => (d.lotRangement ?? null) === (n.lotRangement ?? null));
    if (!this.mutationSansPoints())
      return { prets: toutes, tenues: [] as TenueMutation[] };
    // Une permutation va par paire : si l'un des deux a des points à vérifier, les deux attendent
    // (sinon la note ne porterait qu'une moitié de l'échange)
    const avec = toutes
      .map((d) => d.permutationAvecId)
      .filter((x): x is string => !!x);
    const permutants = new Map(
      (avec.length
        ? await this.demandes.find({
            where: { id: In(avec) },
            select: { id: true, nomComplet: true, anomalies: true },
          })
        : []
      ).map((x) => [x.id, x] as const),
    );
    const prets: DemandeMutation[] = [];
    const tenues: TenueMutation[] = [];
    for (const d of toutes) {
      const p = d.permutationAvecId
        ? permutants.get(d.permutationAvecId)
        : null;
      const raisons = [
        ...(d.anomalies ?? []),
        ...(p?.anomalies?.length
          ? [`Son permutant (${p.nomComplet}) a des points à vérifier`]
          : []),
      ];
      if (raisons.length) tenues.push({ d, raisons });
      else prets.push(d);
    }
    return { prets, tenues };
  }

  /** Les demandes qui ont des points à vérifier attendent-elles hors des notes ? (oui par défaut) */
  private mutationSansPoints() {
    return this.params.get('MUTATION_NOTE_SANS_POINTS') !== 'NON';
  }

  /**
   * Colonnes d'une note de mutation : celles choisies pour la note, sinon celles par défaut (avec la
   * durée et la justification, 06/11/2026). La permutation dit aussi le département d'accueil. Le
   * rectificatif garde les colonnes du modèle (« au lieu de … lire … »).
   */
  private colonnesMutation(
    motif: MotifMutation,
    choisies?: string[] | null,
    rectificatif = false,
  ): Colonne[] {
    const permutation = motif === 'PERMUTATION';
    let cles = choisies?.length
      ? choisies.filter((k) => COLONNES_MUTATION[k])
      : COLONNES_MUTATION_DEFAUT.flatMap((k) =>
          k === 'origine' && permutation ? [k, 'accueil'] : [k],
        );
    if (rectificatif)
      cles = cles.filter((k) => k !== 'duree' && k !== 'justification');
    return [
      { cle: 'nom', libelle: 'Noms et prénoms' },
      ...cles.map((cle) => ({ cle, libelle: COLONNES_MUTATION[cle] })),
    ];
  }

  /** Ce qui justifie la demande : la pièce ou le motif précis, le permutant, l'acte de mariage. */
  private justificationMutation(d: DemandeMutation, permutant?: string | null) {
    const t = (d.justificatif ?? '').trim();
    if (d.motif === 'PERMUTATION')
      return (
        [permutant ? `Permute avec ${permutant}` : '', t]
          .filter(Boolean)
          .join(' ; ') || null
      );
    if (d.motif === 'RAPPROCHEMENT_CONJOINT')
      return t
        ? /acte|mariage/i.test(t)
          ? t
          : `Acte de mariage : ${t}`
        : null;
    return t || null;
  }

  /** Ligne d'une demande dans la note (aussi les « au lieu de » d'un rectificatif). */
  private ligneMutation(
    d: DemandeMutation,
    n: number,
    permutant?: string | null,
  ): LigneNote {
    return {
      id: d.id,
      n,
      nom: d.nomComplet,
      ge: [d.grade, d.echelon]
        .filter((x) => x !== null && x !== undefined)
        .join(' '),
      matricule: d.matricule ?? 'X',
      ...(() => {
        // Au préscolaire et au primaire, la spécialité est le cycle lui-même
        const c = codeCycle(d.cycle);
        const cycle = c ? LIBELLE_CYCLE[c] : d.cycle;
        const memeQueCycle = c === 'PRESCOLAIRE' || c === 'PRIMAIRE';
        return {
          cycle,
          specialite: d.specialite || (memeQueCycle ? cycle : null),
        };
      })(),
      ancienPoste: d.lieuService,
      origine: d.departementOrigine?.nom ?? null,
      accueil: d.departementSollicite?.nom ?? null,
      lieuSollicite: d.lieuSollicite,
      duree: dureeDansLePoste(d),
      justification: this.justificationMutation(d, permutant),
      obs:
        d.typeAgent === 'FINALISTE'
          ? 'Finaliste'
          : d.statutAgent === 'PERSONNEL_ADMINISTRATIF'
            ? 'Pers. adm.'
            : d.genre === 'F'
              ? 'Ens. active'
              : 'Ens. actif',
    };
  }

  private async contenuMutation(
    note: NoteService,
  ): Promise<ContenuNote & { bloques: unknown[] }> {
    const motif = note.motif as MotifMutation;
    const groupes = this.groupesMutation(note);
    const { prets: liste, tenues } = await this.lignesMutationNote(note);
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const permutation = motif === 'PERMUTATION';
    const colonnes = this.colonnesMutation(motif, note.colonnesNote);
    // Le nom du permutant (pour la colonne « Justification »)
    const permutants = new Map<string, string>();
    const avec = liste
      .map((d) => d.permutationAvecId)
      .filter((x): x is string => !!x);
    if (avec.length)
      for (const x of await this.demandes.find({
        where: { id: In(avec) },
        select: { id: true, nomComplet: true },
      }))
        permutants.set(x.id, x.nomComplet);
    const ligne = (d: DemandeMutation, n: number) =>
      this.ligneMutation(
        d,
        n,
        d.permutationAvecId ? permutants.get(d.permutationAvecId) : null,
      );
    const tri = (a: DemandeMutation, b: DemandeMutation) =>
      a.nomComplet.localeCompare(b.nomComplet, 'fr');
    const sections: SectionNote[] = permutation
      ? [
          {
            titre: null,
            lignes: [...liste].sort(tri).map((d, j) => ligne(d, j + 1)),
          },
        ]
      : deps
          .map((dep) => ({
            dep,
            items: liste
              .filter((d) => d.departementSolliciteId === dep.id)
              .sort(tri),
          }))
          .filter((s) => s.items.length)
          .map((s, i) => ({
            titre: `${entierVersRomain(i + 1)}- ${titreDepartement(s.dep)}`,
            lignes: s.items.map((d, j) => ligne(d, j + 1)),
          }));
    const nbDeps = new Set(
      liste
        .flatMap((d) => [d.departementOrigineId, d.departementSolliciteId])
        .filter(Boolean),
    ).size;
    return {
      titre: 'NOTE DE SERVICE',
      introduction: accordTableaux(
        note.introduction.replaceAll('{annee}', note.anneeScolaire),
        sections.length,
      ),
      colonnes,
      classification: false,
      sections,
      total: liste.length,
      departements: nbDeps,
      // Deux groupes réunis : la DGEB et la DGES-DC reçoivent chacune la note
      ampliations: this.ampliations(
        groupes.map((g) => (g === 'PRESCO_PRIMAIRE' ? 'DGEB' : 'DGES-DC')),
        nbDeps,
        liste.length,
      ),
      mentions: [
        'Les frais de voyage et de transport des bagages sont à la charge des intéressés.',
        'La présente note de service prend effet à compter de la date de signature.',
      ],
      piedDePage: `${OBJET_MUTATION[motif]}/${groupes.map((g) => GROUPE_COURT[g]).join('-')}/${note.anneeScolaire}`,
      repere: `Mut./${ABREGE_MOTIF[motif]}`,
      bloques: tenues.map((t) => ({
        id: t.d.id,
        nom: t.d.nomComplet,
        raisons: t.raisons,
      })),
    };
  }

  introductionMutation(
    motif: MotifMutation,
    groupe: GroupeMutation | GroupeMutation[],
  ) {
    const g = [groupe].flat();
    // Deux groupes réunis dans une note : tous les agents (06/11/2026)
    const qui =
      g.length > 1
        ? 'Les agents du préscolaire, du primaire, du collège, du lycée et de l’administration'
        : g[0] === 'PRESCO_PRIMAIRE'
          ? 'Les enseignants du préscolaire et du primaire'
          : 'Les agents du collège, du lycée et de l’administration';
    return `${qui} dont les noms et prénoms suivent, sont mutés ${MOTIFS[motif].formule}, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`;
  }

  async preparerMutation(u: UtilisateurConnecte) {
    const creees: NoteService[] = [];
    for (const motif of MOTIFS_MUTATION)
      for (const groupe of GROUPES_MUTATION) {
        const ouvertes = await this.notes.find({
          where: {
            module: 'MUTATION',
            motif,
            statut: In(['BROUILLON', 'SOUMISE']),
            rectificatifDe: IsNull(),
          },
        });
        if (
          ouvertes.some(
            (o) =>
              o.lotRangement == null &&
              this.groupesMutation(o).includes(groupe),
          )
        )
          continue;
        // Les demandes rangées dans un lot ont déjà leur note
        const liste = (
          await this.mutSvc.eligiblesPourNote(motif, groupe)
        ).filter((d) => d.lotRangement == null);
        if (!liste.length) continue;
        const rang =
          (await this.notes.count({
            where: { module: 'MUTATION', motif, typeNote: groupe },
          })) + 1;
        creees.push(
          await this.notes.save({
            module: 'MUTATION',
            typeNote: groupe,
            motif,
            lotPublicationId: null,
            anneeScolaire: this.annee('MUTATION'),
            rang,
            introduction: this.introductionMutation(motif, groupe),
            statut: 'BROUILLON',
            creePar: u.nom,
          }),
        );
      }
    await this.journal.log(
      u,
      'PREPARATION_NOTES_MUTATION',
      'note_service',
      null,
      {
        notes: creees.map((n) => `${n.motif}/${n.typeNote}`),
      },
    );
    return creees;
  }

  /* ======================== Notes de nomination ======================== */

  /**
   * Note de nomination d'une catégorie (DGRHAS, 26/10/2026, modèles « Notes de service
   * nominations ») : par département, puis par circonscription ; les colonnes de la catégorie
   * (établissements : G/E ; inspections : grade, catégorie, échelle, échelon, spécialité).
   */
  private async contenuNomination(note: NoteService): Promise<ContenuNote> {
    const cat = CATEGORIE_NOMINATION.get(note.typeNote);
    const liste = await this.nomSvc.pourNote(note.anneeScolaire, note.typeNote);
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const g = cat?.gabarit ?? 'ETAB';
    const colonnes: Colonne[] = [
      { cle: 'nom', libelle: 'Noms et prénoms' },
      ...(g === 'ETAB_VAGUE' ? [{ cle: 'vague', libelle: 'Vague' }] : []),
      ...(g === 'ETAB' || g === 'ETAB_VAGUE'
        ? [{ cle: 'ge', libelle: 'G/E' }]
        : []),
      ...(g === 'INSP' || g === 'INSP_SPEC' || g === 'ITIN'
        ? [
            { cle: 'grade', libelle: 'Grade' },
            { cle: 'cat', libelle: 'Cat.' },
            { cle: 'echl', libelle: 'Echelle' },
            { cle: 'ech', libelle: 'Echelon' },
          ]
        : []),
      ...(g === 'CP'
        ? [
            { cle: 'grade', libelle: 'Grade' },
            { cle: 'ech', libelle: 'Echelon' },
          ]
        : []),
      ...(g === 'INSP_SPEC' || g === 'ITIN'
        ? [{ cle: 'specialite', libelle: 'Spécialité' }]
        : []),
      ...(g === 'ITIN'
        ? []
        : [{ cle: 'ancienPoste', libelle: 'Ancien poste' }]),
      { cle: 'nouveauPoste', libelle: 'Nouveau poste' },
      { cle: 'obs', libelle: 'Obs.' },
    ];
    const ligne = (x: Nomination, n: number): LigneNote => ({
      id: String(x.id),
      n,
      nom: x.nomComplet,
      vague: x.vague,
      // Grade en abrégé (« Inst. C. 1er ») : réunion du 29/10/2026
      ge: [
        gradeAbrege(x.grade),
        (() => {
          const e = echelonBase(x.echelon);
          return e
            ? `${e}${/^\d+$/.test(e) ? (e === '1' ? 'er' : 'e') : ''}`
            : null;
        })(),
      ]
        .filter(Boolean)
        .join(' '),
      grade: x.grade,
      cat: x.categorieAgent,
      echl: x.echelle,
      ech: x.echelon,
      specialite: x.specialite,
      ancienPoste: x.ancienPoste,
      nouveauPoste: x.nouveauPoste,
      obs: NominationsService.obsImprimee(x),
    });
    const tri = (a: Nomination, b: Nomination) =>
      (a.circonscription ?? '').localeCompare(b.circonscription ?? '', 'fr', {
        numeric: true,
      }) || a.nomComplet.localeCompare(b.nomComplet, 'fr');
    const sections: SectionNote[] = [];
    let i = 0;
    for (const dep of deps) {
      const items = liste.filter((x) => x.departementId === dep.id).sort(tri);
      if (!items.length) continue;
      i++;
      // Une section par circonscription ; le titre du département sur la première seulement
      const circos = [...new Set(items.map((x) => x.circonscription ?? ''))];
      circos.forEach((c, k) =>
        sections.push({
          titre:
            // « DEPARTEMENT SCOLAIRE : BOUENZA » (DG, 30/10/2026), sans « de la »
            k === 0
              ? `${entierVersRomain(i)}- DEPARTEMENT SCOLAIRE : ${normaliser(dep.nom)}`
              : null,
          sousTitre: c
            ? `${String(k + 1).padStart(2, '0')}- Circonscription scolaire : ${c}`
            : null,
          lignes: items
            .filter((x) => (x.circonscription ?? '') === c)
            .map((x, j) => ligne(x, j + 1)),
        }),
      );
    }
    const nbDeps = new Set(liste.map((x) => x.departementId)).size;
    return {
      titre: 'NOTE DE SERVICE',
      introduction: accordTableaux(
        note.introduction.replaceAll('{annee}', note.anneeScolaire),
        sections.length,
      ),
      colonnes,
      classification: false,
      sections,
      total: liste.length,
      departements: nbDeps,
      ampliations: this.ampliations(
        cat?.directionGenerale ?? 'DGES-DC',
        nbDeps,
        liste.length,
      ),
      // Une seule personne : « L'intéressé(e) percevra » (réunion du 29/10/2026 : deux modèles)
      mentions: [
        liste.length === 1
          ? `${liste[0].genre === 'F' ? 'L’intéressée percevra' : liste[0].genre === 'M' ? 'L’intéressé percevra' : 'L’intéressé(e) percevra'} les indemnités prévues par les textes en vigueur.`
          : 'Les intéressés percevront les indemnités prévues par les textes en vigueur.',
        'La présente note de service prend effet à compter de la date de signature.',
      ],
      piedDePage: `Note de nomination des ${cat?.formule ?? note.typeNote}/MEPPSA/${note.anneeScolaire}`,
      // « 29/10/2026/Nomm. Provis. » : on sait d'un coup d'œil qui la note nomme
      repere: repereNomination(note.typeNote),
    };
  }

  introductionNomination(categorie: string) {
    const cat = CATEGORIE_NOMINATION.get(categorie);
    return `Les cadres de l’enseignement dont les noms et prénoms suivent, sont nommés ${cat?.formule ?? categorie}, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`;
  }

  /** Une note par catégorie qui a des nominations validées hors note (pas deux notes ouvertes). */
  async preparerNomination(u: UtilisateurConnecte, anneeDemandee?: string) {
    const annee =
      anneeDemandee && /^\d{4}-\d{4}$/.test(anneeDemandee)
        ? anneeDemandee
        : await this.nomSvc.anneeCourante();
    const creees: NoteService[] = [];
    for (const { categorie } of await this.nomSvc.categoriesAPublier(annee)) {
      const ouverte = await this.notes.findOne({
        where: {
          module: 'NOMINATION',
          typeNote: categorie,
          anneeScolaire: annee,
          statut: In(['BROUILLON', 'SOUMISE']),
        },
      });
      if (ouverte) continue;
      const rang =
        (await this.notes.count({
          where: {
            module: 'NOMINATION',
            typeNote: categorie,
            anneeScolaire: annee,
          },
        })) + 1;
      creees.push(
        await this.notes.save({
          module: 'NOMINATION',
          typeNote: categorie,
          motif: null,
          lotPublicationId: null,
          anneeScolaire: annee,
          rang,
          introduction: this.introductionNomination(categorie),
          statut: 'BROUILLON',
          creePar: u.nom,
        }),
      );
    }
    await this.journal.log(
      u,
      'PREPARATION_NOTES_NOMINATION',
      'note_service',
      null,
      {
        annee,
        notes: creees.map((n) => n.typeNote),
      },
    );
    return creees;
  }

  /* ======================== Notes d'enrôlement ======================== */

  /**
   * Volontaires retenus d'une campagne qui vont dans cette note (préscolaire : BET et CFEEN
   * préscolaire ; lycée : masters et licences placées au lycée), pas encore dans une autre note
   * validée. Un rectificatif n'a pas de liste : il porte ses corrections.
   */
  private async lignesEnrolement(note: NoteService) {
    if (note.rectificatifDe) return { prets: [], bloques: [] };
    const liste = (
      await this.enroles
        .createQueryBuilder('e')
        .where('e.campagneId = :c', { c: note.campagneId })
        .andWhere("e.etat = 'RETENU'")
        .andWhere('(e.noteId IS NULL OR e.noteId = :n)', { n: note.id })
        .orderBy('e.nomNormalise', 'ASC')
        .getMany()
    ).filter(
      (e) =>
        this.typesEnrolement(note).includes(noteEnrolementDe(e)) &&
        // Lot de rangement : chaque note découpée a les siens (null : la note principale)
        (e.lotRangement ?? null) === (note.lotRangement ?? null),
    );
    return {
      prets: liste.filter((e) => e.departementRetenuId),
      bloques: liste.filter((e) => !e.departementRetenuId),
    };
  }

  private async contenuEnrolement(
    note: NoteService,
  ): Promise<ContenuNote & { bloques: unknown[] }> {
    const { prets, bloques } = await this.lignesEnrolement(note);
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const ligne = (e: Enrole, n: number): LigneNote => ({
      ...this.ligneEnrole(e),
      n,
    });
    // Par département, puis par établissement (comme les notes signées n° 1006 et 1038)
    const sections: SectionNote[] = deps
      .map((d) => ({
        d,
        items: prets.filter((e) => e.departementRetenuId === d.id),
      }))
      .filter((x) => x.items.length)
      .flatMap((x, i): SectionNote[] => {
        const titre = `${entierVersRomain(i + 1)}- DEPARTEMENT ${x.d.article} ${x.d.nom.toUpperCase()}`;
        const groupes = new Map<string, Enrole[]>();
        for (const e of x.items) {
          const k = e.etablissement?.trim() ?? '';
          groupes.set(k, [...(groupes.get(k) ?? []), e]);
        }
        return [...groupes.entries()]
          .sort(([a], [b]) =>
            a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'fr'),
          )
          .map(([etab, items], k) => ({
            titre: k === 0 ? titre : null,
            // « Effectif : Quatre-vingt-deux (82) » sous le département (cadrage du 05/11/2026)
            effectif: k === 0 ? effectifEnLettres(x.items.length) : null,
            sousTitre: etab || null,
            lignes: items.map((e, j) => ligne(e, j + 1)),
          }));
      });
    const nbDeps = new Set(prets.map((e) => e.departementRetenuId)).size;
    const def = NOTES_ENROLEMENT[note.typeNote] ?? NOTES_ENROLEMENT.AUTRE;
    const total = prets.length;
    const fixes: [string, number][] = [
      ['MEPPSA-CAB', 2],
      ['IGEPSA', 2],
      ['DGRHAS', 2],
      ['DGES', 2],
      ['DGB-DGCB', 2],
      ['DDEPPSA', nbDeps],
      ['Intéressés', total],
      ['Dossiers', total],
    ];
    const somme = fixes.reduce((t, [, n]) => t + n, 0) + 2;
    return {
      titre: 'NOTE DE SERVICE',
      introduction: note.introduction.replaceAll('{annee}', note.anneeScolaire),
      colonnes: this.colonnesEnrolement(note),
      classification: false,
      sections,
      total,
      departements: nbDeps,
      ampliations: [
        ...fixes.map(([libelle, n]) => ({ libelle, nombre: String(n) })),
        { libelle: 'Archives', nombre: `2/${somme}` },
      ],
      mentions: [
        this.params.get('MENTION_BOURSE_ENROLEMENT'),
        'La présente note de service prend effet à compter de la date de signature./-',
      ].filter(Boolean),
      piedDePage: `Affectation des enseignants finalistes/${def.court}/${note.anneeScolaire}`,
      repere: `Enr./${def.court}`,
      bloques: bloques.map((e) => ({
        id: e.id,
        nom: e.nomComplet,
        raisons: ['Département retenu pas encore choisi'],
      })),
    };
  }

  /** Une personne retenue telle qu'elle s'écrit sur une note d'enrôlement (toutes les colonnes possibles). */
  private ligneEnrole(e: Enrole): LigneNote {
    return {
      id: e.id,
      n: 0,
      nom: e.nomComplet,
      naissance: e.dateNaissance
        ? e.dateNaissance.split('-').reverse().join('/')
        : '',
      lieu: e.lieuNaissance,
      promotion: e.promotion,
      specialite: e.specialite ?? DIPLOMES_ENROLEMENT[e.diplome]?.cycle ?? null,
      diplome: diplomeSurLaNote(e),
      etablissement: e.etablissement,
    };
  }

  /**
   * Colonnes d'une note d'enrôlement : celles choisies pour cette note, sinon celles de son type
   * (« Promotion » partout ; « Diplôme » au lieu de « Spécialité » au préscolaire).
   */
  private colonnesEnrolement(n: NoteService) {
    const def = NOTES_ENROLEMENT[n.typeNote] ?? NOTES_ENROLEMENT.AUTRE;
    const cles = (
      n.colonnesNote?.length ? n.colonnesNote : def.colonnes
    ).filter((k) => COLONNES_POSSIBLES[k]);
    return [
      { cle: 'nom', libelle: 'Noms et prénoms' },
      ...cles.map((cle) => ({ cle, libelle: COLONNES_POSSIBLES[cle] })),
    ];
  }

  /**
   * Introduction d'un ADDITIF ou d'un RECTIFICATIF (modèles n° 0083 et n° 0079) : « À la note de
   * service n° 0425/MEPSA-CAB-DGRHAS du 13 novembre 2018, relative à l'affectation des enseignants
   * finalistes, titulaires du …, en qualité d'enseignants volontaires, dans les départements
   * ci-dessous, au titre de l'année scolaire 2018-2019. »
   */
  private async introductionLiee(n: NoteService, lieeId: string) {
    const o = await this.notes.findOne({ where: { id: lieeId } });
    if (n.module === 'MUTATION') {
      const ref =
        (o?.contenu as { entete?: { reference?: string } } | null)?.entete
          ?.reference ?? this.params.get('REFERENCE_NOTE');
      const numero = o?.numero ? `n° ${o.numero}/${ref}` : `n° ____/${ref}`;
      const du = dateEnLettres(o?.dateSignature)?.toLowerCase() ?? '__________';
      return `À la note de service ${numero} du ${du}, relative à la mutation des agents ${MOTIFS[(o?.motif ?? n.motif) as MotifMutation]?.formule ?? ''}, au titre de l'année scolaire ${o?.anneeScolaire ?? n.anneeScolaire}.`;
    }
    const def = NOTES_ENROLEMENT[n.typeNote] ?? NOTES_ENROLEMENT.AUTRE;
    const ref =
      (o?.contenu as { entete?: { reference?: string } } | null)?.entete
        ?.reference ?? this.params.get('REFERENCE_NOTE');
    const numero = o?.numero ? `n° ${o.numero}/${ref}` : `n° ____/${ref}`;
    // « du 13 novembre 2018 », comme les modèles signés (mois en minuscules)
    const du = dateEnLettres(o?.dateSignature)?.toLowerCase() ?? '__________';
    return `À la note de service ${numero} du ${du}, relative à l'affectation des enseignants finalistes, titulaires ${def.titulaires}, en qualité d'enseignants volontaires, dans les départements ci-dessous, au titre de l'année scolaire ${o?.anneeScolaire ?? n.anneeScolaire}.`;
  }

  /**
   * Personnes de la note corrigée par un rectificatif : leur ligne (N° de la note, nom, date…), le
   * titre de leur département dans la note et leur département retenu.
   */
  private async personnesDeLaNote(noteId: string) {
    const o = await this.obtenir(noteId);
    const res = new Map<
      string,
      { ligne: LigneNote; titre: string; ordre: number }
    >();
    let titre = '';
    let ordre = 0;
    for (const s of o.contenu.sections) {
      if (s.titre) {
        titre = s.titre;
        ordre++;
      }
      for (const l of s.lignes) res.set(l.id, { ligne: l, titre, ordre });
    }
    return { note: o, personnes: res };
  }

  /**
   * RECTIFICATIF (modèle n° 0079) : par département, « AU LIEU DE : » la ligne de la note signée,
   * puis « LIRE : » la ligne corrigée ou la personne qui remplace ; « Le reste demeure sans
   * changement. »
   */
  private async contenuRectificatif(
    n: NoteService,
  ): Promise<ContenuNote & { bloques: unknown[] }> {
    const { personnes } = await this.personnesDeLaNote(n.rectificatifDe!);
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d] as const),
    );
    const mutation = n.module === 'MUTATION';
    const demandes = mutation
      ? new Map(
          (
            await this.demandes.find({
              where: {
                id: In(
                  [
                    ...new Set((n.rectifications ?? []).map((r) => r.enroleId)),
                  ].concat(['00000000-0000-0000-0000-000000000000']),
                ),
              },
            })
          ).map((d) => [d.id, d] as const),
        )
      : new Map<string, DemandeMutation>();
    const enroles = new Map(
      (
        await this.enroles.find({
          where: {
            id: In(
              [
                ...new Set((n.rectifications ?? []).map((r) => r.enroleId)),
              ].concat(['00000000-0000-0000-0000-000000000000']),
            ),
          },
        })
      ).map((e) => [e.id, e] as const),
    );
    const parDep = new Map<
      string,
      { ordre: number; auLieuDe: LigneNote[]; lire: Map<string, LigneNote[]> }
    >();
    for (const r of n.rectifications ?? []) {
      const p = personnes.get(r.enroleId);
      if (!p) continue;
      const g = parDep.get(p.titre) ?? {
        ordre: p.ordre,
        auLieuDe: [],
        lire: new Map<string, LigneNote[]>(),
      };
      parDep.set(p.titre, g);
      g.auLieuDe.push(p.ligne);
      // Autre département que celui de la note signée : on le dit au-dessus de la ligne à lire
      const depAvant = mutation
        ? (demandes.get(r.enroleId)?.departementSolliciteId ?? null)
        : (enroles.get(r.enroleId)?.departementRetenuId ?? null);
      const dep =
        r.lire.departementId && r.lire.departementId !== depAvant
          ? deps.get(r.lire.departementId)
          : null;
      const libelle = dep
        ? `LIRE (département ${dep.article.toLowerCase()} ${dep.nom}) :`
        : 'LIRE :';
      g.lire.set(libelle, [
        ...(g.lire.get(libelle) ?? []),
        mutation
          ? {
              // La ligne de la note signée, avec ce qu'il faut lire
              ...p.ligne,
              id: r.lire.enroleId ?? `libre-${r.id}`,
              nom: r.lire.nom,
              matricule: r.lire.matricule ?? 'X',
              ge: r.lire.ge ?? '',
              cycle: r.lire.cycle ?? p.ligne.cycle,
              specialite: r.lire.specialite,
              ancienPoste: r.lire.ancienPoste ?? null,
              accueil: r.lire.departementId
                ? (deps.get(r.lire.departementId)?.nom ?? p.ligne.accueil)
                : p.ligne.accueil,
            }
          : {
              id: r.lire.enroleId ?? `libre-${r.id}`,
              n: p.ligne.n,
              nom: r.lire.nom,
              naissance: r.lire.naissance
                ? r.lire.naissance.split('-').reverse().join('/')
                : '',
              lieu: r.lire.lieu,
              promotion: r.lire.promotion,
              specialite: r.lire.specialite,
              diplome: r.lire.diplome,
              etablissement: null,
            },
      ]);
    }
    const sections: SectionNote[] = [...parDep.entries()]
      .sort(([, a], [, b]) => a.ordre - b.ordre)
      .flatMap(([titre, g]) => [
        // Dans l'ordre des numéros de la note signée
        {
          titre,
          sousTitre: 'AU LIEU DE :',
          lignes: [...g.auLieuDe].sort((x, y) => x.n - y.n),
        },
        ...[...g.lire.entries()].map(([sousTitre, lignes]) => ({
          titre: null,
          sousTitre,
          lignes: [...lignes].sort((x, y) => x.n - y.n),
        })),
      ]);
    const total = (n.rectifications ?? []).length;
    const nbDeps = parDep.size;
    if (mutation)
      return {
        titre: 'RECTIFICATIF',
        introduction: '',
        colonnes: this.colonnesMutation(
          n.motif as MotifMutation,
          n.colonnesNote,
          true,
        ),
        classification: false,
        sections,
        total,
        departements: nbDeps,
        ampliations: this.ampliations(
          this.groupesMutation(n).map((g) =>
            g === 'PRESCO_PRIMAIRE' ? 'DGEB' : 'DGES-DC',
          ),
          nbDeps,
          total,
        ),
        mentions: [
          'Le reste demeure sans changement.',
          'La présente note de service prend effet à compter de la date de signature./-',
        ],
        piedDePage: '',
        repere: '',
        bloques: [],
      };
    const fixes: [string, number][] = [
      ['MEPPSA-CAB', 2],
      ['IGEPSA', 2],
      ['DGRHAS', 2],
      ['DGES', 2],
      ['DGB-DGCB', 2],
      ['DDEPPSA', nbDeps],
      ['Intéressés', total],
    ];
    const somme = fixes.reduce((t, [, x]) => t + x, 0) + 2;
    return {
      titre: 'RECTIFICATIF',
      introduction: '',
      colonnes: this.colonnesEnrolement(n),
      classification: false,
      sections,
      total,
      departements: nbDeps,
      ampliations: [
        ...fixes.map(([libelle, x]) => ({ libelle, nombre: String(x) })),
        { libelle: 'Archives', nombre: `2/${somme}` },
      ],
      mentions: [
        'Le reste demeure sans changement.',
        'La présente note de service prend effet à compter de la date de signature./-',
      ],
      piedDePage: '',
      repere: '',
      bloques: [],
    };
  }

  /** Types d'une note d'enrôlement : le sien et ceux qu'on y a réunis (06/11/2026). */
  private typesEnrolement(n: NoteService) {
    return [n.typeNote, ...(n.groupes ?? [])];
  }

  /** Introduction d'une note qui réunit plusieurs types : « titulaires du …, ou du … ». */
  private introductionReunie(types: string[]) {
    return INTRO_ENROLEMENT(
      types
        .map((t) => (NOTES_ENROLEMENT[t] ?? NOTES_ENROLEMENT.AUTRE).titulaires)
        .join(', ou '),
    );
  }

  /**
   * Réunir des notes d'enrôlement de types différents en une seule (06/11/2026), au choix : par
   * exemple le préscolaire et le primaire. Les autres notes sont retirées ; leurs volontaires passent
   * dans celle-ci, l'introduction cite tous les diplômes.
   */
  private async reunirEnrolement(
    u: UtilisateurConnecte,
    n: NoteService,
    liste: NoteService[],
  ) {
    for (const x of [n, ...liste]) {
      if (x.module !== 'ENROLEMENT' || x.campagneId !== n.campagneId)
        throw new BadRequestException(
          'On réunit des notes d’enrôlement de la même campagne.',
        );
      if (x.statut !== 'BROUILLON')
        throw new BadRequestException(
          'Seules les notes « à soumettre au DG » se réunissent.',
        );
      if (x.additifDe || x.rectificatifDe)
        throw new BadRequestException(
          'Un additif ou un rectificatif ne se réunit pas avec une autre note.',
        );
      if (x.lotRangement != null)
        throw new BadRequestException(
          'Un lot ne se réunit pas avec une autre note : remettez-le d’abord dans la note principale.',
        );
    }
    const types = [
      ...new Set([n, ...liste].flatMap((x) => this.typesEnrolement(x))),
    ];
    const def = NOTES_ENROLEMENT[n.typeNote] ?? NOTES_ENROLEMENT.AUTRE;
    // L'introduction suit, sauf si elle a été réécrite à la main
    const intro =
      n.introduction === def.introduction ||
      n.introduction === this.introductionReunie(this.typesEnrolement(n))
        ? this.introductionReunie(types)
        : n.introduction;
    await this.notes.manager.transaction(async (m) => {
      // Les volontaires d'un autre lot de rangement passent dans le lot de cette note
      for (const x of liste.filter(
        (y) => (y.lotRangement ?? null) !== (n.lotRangement ?? null),
      ))
        await m.update(
          Enrole,
          {
            campagneId: x.campagneId ?? -1,
            lotRangement: x.lotRangement ?? IsNull(),
            noteId: IsNull(),
          },
          { lotRangement: n.lotRangement ?? null },
        );
      await m.update(NoteService, n.id, {
        groupes: types.filter((t) => t !== n.typeNote),
        introduction: intro,
      });
      await m.delete(NoteService, { id: In(liste.map((x) => x.id)) });
    });
    await this.journal.log(u, 'NOTES_REUNIES', 'note_service', n.id, {
      types,
      notesRetirees: liste.length,
    });
    return { ok: true, types: types.length };
  }

  /**
   * Réunir les deux notes d'un même motif (préscolaire-primaire et collège-lycée-administration) en
   * une seule (06/11/2026). L'autre note est retirée ; ses demandes passent dans celle-ci.
   */
  private async reunirMutation(
    u: UtilisateurConnecte,
    n: NoteService,
    liste: NoteService[],
  ) {
    for (const x of [n, ...liste]) {
      if (x.module !== 'MUTATION' || x.motif !== n.motif)
        throw new BadRequestException(
          'On réunit des notes de mutation du même motif (une note par motif).',
        );
      if (x.statut !== 'BROUILLON')
        throw new BadRequestException(
          'Seules les notes « à soumettre au DG » se réunissent.',
        );
      if (x.additifDe || x.rectificatifDe || x.lotRangement != null)
        throw new BadRequestException(
          'Un additif, un rectificatif ou un lot ne se réunit pas avec une autre note.',
        );
    }
    const groupes = [
      ...new Set([n, ...liste].flatMap((x) => this.groupesMutation(x))),
    ];
    const motif = n.motif as MotifMutation;
    // L'introduction suit, sauf si elle a été réécrite à la main
    const intro =
      n.introduction ===
      this.introductionMutation(motif, this.groupesMutation(n))
        ? this.introductionMutation(motif, groupes)
        : n.introduction;
    await this.notes.manager.transaction(async (m) => {
      await m.update(NoteService, n.id, {
        groupes: groupes.filter((g) => g !== n.typeNote),
        introduction: intro,
      });
      await m.delete(NoteService, { id: In(liste.map((x) => x.id)) });
    });
    await this.journal.log(u, 'NOTES_REUNIES', 'note_service', n.id, {
      groupes,
      notesRetirees: liste.length,
    });
    return { ok: true, types: groupes.length };
  }

  /** Défaire la réunion d'une note de mutation : l'autre groupe retrouve sa note. */
  private async separerMutation(u: UtilisateurConnecte, n: NoteService) {
    if (n.lotRangement != null)
      throw new BadRequestException(
        'Un lot ne se sépare pas : remettez-le d’abord dans la note principale.',
      );
    const autres = (n.groupes ?? []) as GroupeMutation[];
    if (!autres.length)
      throw new BadRequestException('Cette note ne réunit qu’un seul groupe.');
    const motif = n.motif as MotifMutation;
    await this.notes.update(n.id, {
      groupes: [],
      introduction:
        n.introduction ===
        this.introductionMutation(motif, this.groupesMutation(n))
          ? this.introductionMutation(motif, n.typeNote as GroupeMutation)
          : n.introduction,
    });
    const recreees: NoteService[] = [];
    for (const g of autres) {
      const rang =
        (await this.notes.count({
          where: { module: 'MUTATION', motif, typeNote: g },
        })) + 1;
      recreees.push(
        await this.notes.save({
          module: 'MUTATION',
          typeNote: g,
          motif,
          anneeScolaire: n.anneeScolaire,
          rang,
          introduction: this.introductionMutation(motif, g),
          statut: 'BROUILLON',
          creePar: u.nom,
        }),
      );
    }
    await this.journal.log(u, 'NOTES_SEPAREES', 'note_service', n.id, {
      recreees: recreees.length,
    });
    return { ok: true, recreees: recreees.length };
  }

  /** Défaire la réunion : la note garde son type ; chaque autre type retrouve sa note. */
  private async separerEnrolement(u: UtilisateurConnecte, n: NoteService) {
    if (n.lotRangement != null)
      throw new BadRequestException(
        'Un lot ne se sépare pas : remettez-le d’abord dans la note principale.',
      );
    const autres = n.groupes ?? [];
    if (!autres.length)
      throw new BadRequestException('Cette note ne réunit qu’un seul type.');
    const def = NOTES_ENROLEMENT[n.typeNote] ?? NOTES_ENROLEMENT.AUTRE;
    await this.notes.update(n.id, {
      groupes: [],
      introduction:
        n.introduction === this.introductionReunie(this.typesEnrolement(n))
          ? def.introduction
          : n.introduction,
    });
    const recreees: NoteService[] = [];
    for (const t of autres) {
      const rang =
        (await this.notes.count({
          where: {
            module: 'ENROLEMENT',
            campagneId: n.campagneId ?? undefined,
            typeNote: t,
          },
        })) + 1;
      const x = await this.notes.save({
        module: 'ENROLEMENT',
        typeNote: t,
        campagneId: n.campagneId,
        anneeScolaire: n.anneeScolaire,
        rang,
        introduction: (NOTES_ENROLEMENT[t] ?? NOTES_ENROLEMENT.AUTRE)
          .introduction,
        statut: 'BROUILLON',
        creePar: u.nom,
      });
      // Pas de volontaire pour ce type : pas de note vide
      if ((await this.lignesEnrolement(x)).prets.length) recreees.push(x);
      else await this.notes.delete(x.id);
    }
    await this.journal.log(u, 'NOTES_SEPAREES', 'note_service', n.id, {
      types: autres,
    });
    return { ok: true, notes: recreees.map((x) => x.id) };
  }

  /**
   * Introduction et texte de conclusion d'une note d'enrôlement, réécrits pour cette note
   * (06/11/2026) ; null : ceux du modèle. « {annee} » est remplacé par l'année scolaire.
   */
  /**
   * En-tête réécrit pour une note « à soumettre au DG » (06/11/2026) : enlever ou ajouter une ligne,
   * changer la référence du numéro. null : l'en-tête habituel.
   */
  async ecrireEntete(
    u: UtilisateurConnecte,
    id: string,
    lignes: string[] | null,
    reference: string | null,
  ) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » se modifie (le DG peut la rouvrir).',
      );
    const propres = (lignes ?? [])
      .map((l) => String(l).trim())
      .map((l) => (/^-{2,}$/.test(l) ? '---' : l))
      .filter(Boolean)
      .slice(0, 30);
    if (lignes && !propres.some((l) => l !== '---'))
      throw new BadRequestException('L’en-tête ne peut pas être vide.');
    const ref = reference?.trim().replace(/^N°\s*_*\/?/i, '') || null;
    await this.notes.update(id, {
      enteteLibre:
        lignes || ref
          ? {
              lignes: lignes
                ? propres
                : enteteParDefaut(ref ?? this.params.get('REFERENCE_NOTE')),
              reference: ref,
            }
          : null,
    });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id, {
      entete: !!(lignes || ref),
    });
    return { ok: true };
  }

  async ecrireTextes(
    u: UtilisateurConnecte,
    id: string,
    introduction: string | null,
    mentions: string[] | null,
  ) {
    const n = await this.charger(id);
    if (n.module !== 'ENROLEMENT' && n.module !== 'MUTATION')
      throw new BadRequestException(
        'Réservé aux notes d’enrôlement et de mutation.',
      );
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » se réécrit (le DG peut la rouvrir).',
      );
    const intro = introduction?.replace(/\s+\n/g, '\n').trim() || null;
    const fin = (mentions ?? []).map((m) => m.trim()).filter(Boolean);
    await this.notes.update(id, {
      textesLibres:
        intro || fin.length
          ? { introduction: intro, mentions: fin.length ? fin : null }
          : null,
    });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id, {
      textes: !!(intro || fin.length),
    });
    return { ok: true };
  }

  /**
   * Personnes d'une note d'enrôlement ou de mutation, dans l'ordre de la note (département, puis
   * nom), avec ce qui sert à la découper : département de la note et valeurs des critères
   * (06/11/2026 : les mutations se découpent comme l'enrôlement).
   */
  private async gensDeLaNote(n: NoteService): Promise<GensNote[]> {
    const deps = await this.deps.find();
    const ordre = new Map(deps.map((d) => [d.id, d.ordre ?? 0] as const));
    const nomDep = new Map(deps.map((d) => [d.id, d.nom] as const));
    const trier = (a: GensNote, b: GensNote) =>
      (ordre.get(a.departementId ?? -1) ?? 0) -
        (ordre.get(b.departementId ?? -1) ?? 0) ||
      a.cleTri.localeCompare(b.cleTri);
    if (n.module === 'MUTATION')
      return (await this.demandesDeLaNoteMutation(n))
        .map((d) => {
          const c = codeCycle(d.cycle);
          return {
            id: d.id,
            nom: d.nomComplet,
            cleTri: normaliser(d.nomComplet),
            departementId: d.departementSolliciteId,
            valeurs: {
              specialite: d.specialite ?? '',
              cycle: c ? LIBELLE_CYCLE[c] : (d.cycle ?? ''),
              origine: nomDep.get(d.departementOrigineId ?? -1) ?? '',
              departement: nomDep.get(d.departementSolliciteId ?? -1) ?? '',
            },
          };
        })
        .sort(trier);
    const { prets } = await this.lignesEnrolement(n);
    return prets
      .map((e) => ({
        id: e.id,
        nom: e.nomComplet,
        cleTri: e.nomNormalise,
        departementId: e.departementRetenuId,
        valeurs: {
          specialite: e.specialite ?? '',
          diplome: diplomeSurLaNote(e),
          promotion: e.promotion ?? '',
          departement: nomDep.get(e.departementRetenuId ?? -1) ?? '',
        },
      }))
      .sort(trier);
  }

  /** Met les personnes données dans un lot de rangement (null : la note principale). */
  private async rangerDansLot(
    n: NoteService,
    ids: string[],
    lot: number | null,
  ) {
    if (!ids.length) return;
    if (n.module === 'MUTATION')
      await this.demandes.update({ id: In(ids) }, { lotRangement: lot });
    else await this.enroles.update({ id: In(ids) }, { lotRangement: lot });
  }

  /** Les critères de découpage d'un module : l'enrôlement par diplôme, la mutation par cycle. */
  private criteresDuModule(n: NoteService) {
    return (
      n.module === 'MUTATION' ? CRITERES_MUTATION : CRITERES_ENROLEMENT
    ) as CritereLot[];
  }

  /** Les valeurs de chaque critère dans une note, avec leur nombre de personnes (fenêtre « Découper »). */
  async criteresDeLaNote(id: string) {
    const n = await this.charger(id);
    this.verifierDecoupable(n);
    const gens = await this.gensDeLaNote(n);
    return this.criteresDuModule(n).map((critere) => {
      const groupes = new Map<string, { valeur: string; n: number }>();
      for (const e of gens) {
        const valeur =
          String(e.valeurs[critere] ?? '').trim() || CRITERES_LOT[critere].vide;
        const cle = normaliser(valeur);
        const g = groupes.get(cle) ?? { valeur, n: 0 };
        g.n++;
        groupes.set(cle, g);
      }
      return {
        critere,
        libelle: CRITERES_LOT[critere].libelle,
        valeurs: [...groupes.values()].sort(
          (a, b) => b.n - a.n || a.valeur.localeCompare(b.valeur),
        ),
      };
    });
  }

  /**
   * Une nouvelle note par valeur choisie (ou une seule pour toutes) : « une note pour l'anglais »,
   * « une note par département »… Les autres restent dans cette note (au moins une personne).
   */
  async decouperParCritere(
    u: UtilisateurConnecte,
    id: string,
    critere: CritereLot,
    valeurs: string[],
    ensemble: boolean,
  ) {
    const n = await this.charger(id);
    this.verifierDecoupable(n);
    if (!this.criteresDuModule(n).includes(critere))
      throw new BadRequestException('Critère inconnu.');
    const gens = await this.gensDeLaNote(n);
    const voulues = [...new Set(valeurs.map((v) => normaliser(v)))];
    if (!voulues.length)
      throw new BadRequestException('Choisissez au moins une valeur.');
    const parts = new Map<string, { valeur: string; gens: GensNote[] }>();
    for (const e of gens) {
      const valeur =
        String(e.valeurs[critere] ?? '').trim() || CRITERES_LOT[critere].vide;
      const cle = ensemble ? '*' : normaliser(valeur);
      if (!voulues.includes(normaliser(valeur))) continue;
      const p = parts.get(cle) ?? { valeur, gens: [] };
      p.gens.push(e);
      parts.set(cle, p);
    }
    const deplaces = [...parts.values()].reduce((t, p) => t + p.gens.length, 0);
    if (!deplaces)
      throw new BadRequestException(
        'Personne dans cette note pour ces valeurs.',
      );
    if (deplaces >= gens.length)
      throw new BadRequestException(
        'Toute la note partirait : laissez au moins une valeur dans cette note.',
      );
    const creees: { id: string; libelle: string; total: number }[] = [];
    for (const p of parts.values()) {
      const libelle = (
        ensemble && voulues.length > 1
          ? `${CRITERES_LOT[critere].court} choisies`
          : p.valeur
      ).slice(0, 120);
      const x = await this.noteDeLot(u, n, libelle);
      await this.rangerDansLot(
        n,
        p.gens.map((e) => e.id),
        x.lotRangement,
      );
      creees.push({ id: x.id, libelle, total: p.gens.length });
    }
    await this.journal.log(u, 'NOTE_DECOUPEE', 'note_service', id, {
      critere,
      notes: creees.length,
    });
    return { ok: true, notes: creees, reste: gens.length - deplaces };
  }

  /** Nouvelle note pour un lot de rangement (mêmes réglages que la note découpée). */
  private async noteDeLot(
    u: UtilisateurConnecte,
    n: NoteService,
    libelleLot: string | null = null,
  ) {
    // Les lots commencent à 2 : la note principale est le lot 1 (numéros uniques dans la campagne
    // d'enrôlement, ou parmi les notes de mutation du même motif)
    const [{ max }] =
      n.module === 'MUTATION'
        ? await this.notes.query<{ max: number | null }[]>(
            `SELECT greatest(
               (SELECT max("lotRangement") FROM note_service WHERE module = 'MUTATION' AND motif = $1),
               (SELECT max("lotRangement") FROM demande_mutation WHERE motif = $1))::int AS max`,
            [n.motif],
          )
        : await this.notes.query<{ max: number | null }[]>(
            `SELECT greatest(
               (SELECT max("lotRangement") FROM note_service WHERE module = 'ENROLEMENT' AND "campagneId" = $1),
               (SELECT max("lotRangement") FROM enrole WHERE "campagneId" = $1))::int AS max`,
            [n.campagneId],
          );
    const lot = Math.max(1, max ?? 1) + 1;
    return this.notes.save({
      module: n.module,
      typeNote: n.typeNote,
      motif: n.module === 'MUTATION' ? n.motif : null,
      groupes: n.groupes ?? [],
      campagneId: n.campagneId,
      anneeScolaire: n.anneeScolaire,
      rang: n.rang,
      introduction: n.introduction,
      colonnesNote: n.colonnesNote,
      textesLibres: n.textesLibres,
      enteteLibre: n.enteteLibre,
      additifDe: n.additifDe,
      ampliationsExclues: n.ampliationsExclues,
      ampliationsAjoutees: n.ampliationsAjoutees,
      lotRangement: lot,
      libelleLot,
      statut: 'BROUILLON',
      creePar: u.nom,
    });
  }

  private verifierDecoupable(n: NoteService) {
    if (
      (n.module !== 'ENROLEMENT' && n.module !== 'MUTATION') ||
      n.rectificatifDe
    )
      throw new BadRequestException(
        'On découpe une note d’enrôlement ou de mutation (pas un rectificatif).',
      );
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » se découpe.',
      );
  }

  /**
   * Découper une note trop chargée (06/11/2026) : des notes de `taille` personnes au plus. Les
   * départements restent entiers tant qu'ils tiennent dans une note. La première part reste dans
   * cette note, chaque autre devient une note « – lot 2 », « – lot 3 »…
   */
  async decouperParNombre(
    u: UtilisateurConnecte,
    id: string,
    taille: number,
    garderDepartements = true,
  ) {
    const n = await this.charger(id);
    this.verifierDecoupable(n);
    if (!Number.isInteger(taille) || taille < 1)
      throw new BadRequestException(
        'Nombre de personnes par note : au moins 1.',
      );
    const gens = await this.gensDeLaNote(n);
    if (gens.length <= taille)
      throw new BadRequestException(
        `La note compte ${gens.length} personne(s) : elle tient déjà dans une note de ${taille}.`,
      );
    const parts: GensNote[][] = [[]];
    const parDep = new Map<number, GensNote[]>();
    for (const e of gens)
      parDep.set(e.departementId ?? -1, [
        ...(parDep.get(e.departementId ?? -1) ?? []),
        e,
      ]);
    const ajouter = (e: GensNote) => {
      if (parts[parts.length - 1].length >= taille) parts.push([]);
      parts[parts.length - 1].push(e);
    };
    for (const groupe of parDep.values()) {
      const cour = parts[parts.length - 1];
      // Département entier dans la note suivante s'il n'y tient plus, mais tiendrait seul
      if (
        garderDepartements &&
        cour.length &&
        cour.length + groupe.length > taille &&
        groupe.length <= taille
      )
        parts.push([]);
      for (const e of groupe) ajouter(e);
    }
    const creees: NoteService[] = [];
    for (const part of parts.slice(1).filter((p) => p.length)) {
      const x = await this.noteDeLot(u, n);
      await this.rangerDansLot(
        n,
        part.map((e) => e.id),
        x.lotRangement,
      );
      creees.push(x);
    }
    await this.journal.log(u, 'NOTE_DECOUPEE', 'note_service', id, {
      taille,
      notes: creees.length + 1,
    });
    return {
      ok: true,
      notes: [parts[0].length, ...parts.slice(1).map((p) => p.length)],
      ids: creees.map((x) => x.id),
    };
  }

  /** Mettre les personnes choisies d'une note dans une nouvelle note (un lot). */
  async decouperALaMain(u: UtilisateurConnecte, id: string, ids: string[]) {
    const n = await this.charger(id);
    this.verifierDecoupable(n);
    const gens = new Set((await this.gensDeLaNote(n)).map((e) => e.id));
    const choisis = [...new Set(ids)].filter((x) => gens.has(x));
    if (!choisis.length)
      throw new BadRequestException(
        'Cochez les personnes à mettre dans la nouvelle note.',
      );
    if (choisis.length === gens.size)
      throw new BadRequestException(
        'Toute la note serait déplacée : laissez au moins une personne dans cette note.',
      );
    const x = await this.noteDeLot(u, n);
    await this.rangerDansLot(n, choisis, x.lotRangement);
    await this.journal.log(u, 'NOTE_DECOUPEE', 'note_service', id, {
      deplaces: choisis.length,
    });
    return { ok: true, id: x.id, deplaces: choisis.length };
  }

  /** Notes de la même « famille » qu'une note : même campagne et type (enrôlement), même motif et groupe (mutation). */
  private memeFamille(n: NoteService) {
    return n.module === 'MUTATION'
      ? {
          module: 'MUTATION' as const,
          motif: n.motif ?? '',
          typeNote: n.typeNote,
        }
      : {
          module: 'ENROLEMENT' as const,
          campagneId: n.campagneId ?? -1,
          typeNote: n.typeNote,
        };
  }

  /**
   * Regrouper : les lots « à soumettre au DG » de ce type reviennent dans la note principale, et
   * leurs notes sont retirées. Les lots déjà soumis ou validés ne bougent pas.
   */
  async regrouperLots(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    this.verifierDecoupable(n);
    const principale =
      n.lotRangement == null
        ? n
        : (
            await this.notes.find({
              where: {
                ...this.memeFamille(n),
                lotRangement: IsNull(),
                rectificatifDe: IsNull(),
                statut: 'BROUILLON',
              },
            })
          )[0];
    if (!principale)
      throw new BadRequestException(
        'La note principale de ce type n’est plus « à soumettre au DG » : supprimez plutôt ce lot (ses personnes y reviennent à la prochaine préparation).',
      );
    const lots = (
      await this.notes.find({
        where: {
          ...this.memeFamille(n),
          statut: 'BROUILLON',
          rectificatifDe: IsNull(),
          lotRangement: Not(IsNull()),
        },
      })
    ).filter((x) => x.id !== principale.id);
    if (!lots.length)
      throw new BadRequestException(
        'Aucun lot « à soumettre au DG » à regrouper.',
      );
    await this.notes.manager.transaction(async (m) => {
      const numeros = In(lots.map((x) => x.lotRangement!));
      if (n.module === 'MUTATION')
        await m.update(
          DemandeMutation,
          { motif: n.motif ?? '', lotRangement: numeros, noteId: IsNull() },
          { lotRangement: null },
        );
      else
        await m.update(
          Enrole,
          {
            campagneId: n.campagneId ?? -1,
            lotRangement: numeros,
            noteId: IsNull(),
          },
          { lotRangement: null },
        );
      await m.delete(NoteService, { id: In(lots.map((x) => x.id)) });
    });
    await this.journal.log(u, 'LOTS_REGROUPES', 'note_service', principale.id, {
      lots: lots.length,
    });
    return { ok: true, id: principale.id, lots: lots.length };
  }

  /** Colonnes du tableau choisies pour une note d'enrôlement (null : celles du type de note). */
  async choisirColonnes(
    u: UtilisateurConnecte,
    id: string,
    cles: string[] | null,
  ) {
    const n = await this.charger(id);
    if (n.module !== 'ENROLEMENT' && n.module !== 'MUTATION')
      throw new BadRequestException(
        'Le choix des colonnes concerne les notes d’enrôlement et de mutation.',
      );
    const possibles =
      n.module === 'MUTATION' ? COLONNES_MUTATION : COLONNES_POSSIBLES;
    if (n.statut === 'SIGNEE')
      throw new BadRequestException(
        'La note est signée : elle ne change plus.',
      );
    const liste = cles?.length ? [...new Set(cles)] : null;
    if (liste?.some((k) => !possibles[k]))
      throw new BadRequestException('Colonne inconnue.');
    await this.notes.update(id, { colonnesNote: liste });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id, {
      colonnes: liste,
    });
    return { ok: true };
  }

  /**
   * Faire de cette note un ADDITIF à une note signée de la même campagne (noms oubliés la même
   * année) ; null : redevenir une note de service.
   */
  async rendreAdditif(u: UtilisateurConnecte, id: string, de: string | null) {
    const n = await this.charger(id);
    if (
      (n.module !== 'ENROLEMENT' && n.module !== 'MUTATION') ||
      n.rectificatifDe
    )
      throw new BadRequestException(
        'Seule une note d’enrôlement ou de mutation peut devenir un additif.',
      );
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » peut devenir un additif.',
      );
    if (de) {
      const o = await this.notes.findOne({ where: { id: de } });
      if (
        !o ||
        o.id === n.id ||
        o.module !== n.module ||
        (n.module === 'ENROLEMENT' && o.campagneId !== n.campagneId) ||
        (n.module === 'MUTATION' && o.motif !== n.motif) ||
        o.statut !== 'SIGNEE' ||
        o.rectificatifDe
      )
        throw new BadRequestException(
          n.module === 'MUTATION'
            ? 'Choisissez une note de mutation signée du même motif.'
            : 'Choisissez une note d’enrôlement signée de la même campagne.',
        );
    }
    await this.notes.update(id, { additifDe: de });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id, {
      additifDe: de,
    });
    return { ok: true };
  }

  /** Préparer un RECTIFICATIF d'une note d'enrôlement signée (une seule ouverte à la fois). */
  async creerRectificatif(u: UtilisateurConnecte, id: string) {
    const o = await this.charger(id);
    if (
      (o.module !== 'ENROLEMENT' && o.module !== 'MUTATION') ||
      o.rectificatifDe ||
      o.statut !== 'SIGNEE'
    )
      throw new BadRequestException(
        'On rectifie une note d’enrôlement ou de mutation signée (numéro et date enregistrés).',
      );
    const ouvert = await this.notes.findOne({
      where: {
        rectificatifDe: id,
        statut: In(['BROUILLON', 'SOUMISE', 'VALIDEE']),
      },
    });
    if (ouvert) return ouvert;
    const rang =
      (await this.notes.count({
        where:
          o.module === 'MUTATION'
            ? { module: 'MUTATION', motif: o.motif ?? '', typeNote: o.typeNote }
            : {
                module: 'ENROLEMENT',
                campagneId: o.campagneId ?? undefined,
                typeNote: o.typeNote,
              },
      })) + 1;
    const r = await this.notes.save({
      module: o.module,
      typeNote: o.typeNote,
      motif: o.module === 'MUTATION' ? o.motif : null,
      groupes: o.module === 'MUTATION' ? (o.groupes ?? []) : [],
      campagneId: o.campagneId,
      anneeScolaire: o.anneeScolaire,
      rang,
      introduction: '',
      statut: 'BROUILLON',
      creePar: u.nom,
      rectificatifDe: o.id,
      rectifications: [],
      colonnesNote: o.colonnesNote,
    });
    await this.journal.log(u, 'RECTIFICATIF_PREPARE', 'note_service', r.id, {
      note: o.numero,
    });
    return r;
  }

  /** Ce qu'il faut pour écrire les corrections : les personnes de la note signée et les remplaçants possibles. */
  async choixRectificatif(id: string) {
    const n = await this.charger(id);
    if (!n.rectificatifDe)
      throw new BadRequestException('Cette note n’est pas un rectificatif.');
    const { note, personnes } = await this.personnesDeLaNote(n.rectificatifDe);
    if (n.module === 'MUTATION') {
      const toutes = await this.demandes.find({
        where: { motif: n.motif ?? '', retiree: false },
      });
      const parId = new Map(toutes.map((d) => [d.id, d] as const));
      const vers = (d: DemandeMutation) => {
        const l = this.ligneMutation(d, 0);
        return {
          id: d.id,
          nom: d.nomComplet,
          matricule: d.matricule,
          ge: String(l.ge ?? ''),
          cycle: String(l.cycle ?? ''),
          specialite: d.specialite,
          ancienPoste: d.lieuService,
          lieuSollicite: d.lieuSollicite,
          departementId: d.departementSolliciteId,
        };
      };
      return {
        note: { id: note.id, numero: note.numero, libelle: note.libelle },
        personnes: [...personnes.entries()]
          .filter(([pid]) => parId.has(pid))
          .map(([pid, p]) => ({
            ...vers(parId.get(pid)!),
            n: p.ligne.n,
            departement: p.titre,
          })),
        // Demandes qui peuvent remplacer : accordées, du même motif, pas encore dans une note
        remplacants: toutes
          .filter(
            (d) =>
              !d.noteId &&
              d.instructionMinistre === 'ACCORDEE' &&
              (!this.mutationSansPoints() || !d.anomalies?.length),
          )
          .sort((a, b) => a.nomComplet.localeCompare(b.nomComplet, 'fr'))
          .map(vers),
      };
    }
    const enroles = await this.enroles.find({
      where: { campagneId: n.campagneId ?? -1 },
    });
    const parId = new Map(enroles.map((e) => [e.id, e] as const));
    const vers = (e: Enrole) => ({
      id: e.id,
      nom: e.nomComplet,
      naissance: e.dateNaissance,
      lieu: e.lieuNaissance,
      promotion: e.promotion,
      specialite: e.specialite,
      diplome: diplomeSurLaNote(e),
      departementId: e.departementRetenuId,
    });
    return {
      note: { id: note.id, numero: note.numero, libelle: note.libelle },
      personnes: [...personnes.entries()]
        .filter(([pid]) => parId.has(pid))
        .map(([pid, p]) => ({
          ...vers(parId.get(pid)!),
          n: p.ligne.n,
          departement: p.titre,
        })),
      // Dossiers qui peuvent remplacer : pas encore dans une note
      remplacants: enroles
        .filter((e) => !e.noteId && ['RETENU', 'CONTROLE'].includes(e.etat))
        .sort((a, b) => a.nomNormalise.localeCompare(b.nomNormalise))
        .map(vers),
    };
  }

  /** Corrections d'un rectificatif (tant qu'il est « à soumettre au DG »). */
  async enregistrerRectifications(
    u: UtilisateurConnecte,
    id: string,
    liste: Rectification[],
  ) {
    const n = await this.charger(id);
    if (!n.rectificatifDe)
      throw new BadRequestException('Cette note n’est pas un rectificatif.');
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seul un rectificatif « à soumettre au DG » se modifie.',
      );
    const { personnes } = await this.personnesDeLaNote(n.rectificatifDe);
    const deps = new Set((await this.deps.find()).map((d) => d.id));
    const vus = new Set<string>();
    const propres: Rectification[] = (liste ?? []).map((r) => {
      if (!r?.enroleId || !personnes.has(r.enroleId))
        throw new BadRequestException(
          'Choisissez une personne de la note signée (« au lieu de »).',
        );
      if (vus.has(r.enroleId))
        throw new BadRequestException(
          `« ${personnes.get(r.enroleId)!.ligne.nom} » est déjà rectifié(e) plus haut.`,
        );
      vus.add(r.enroleId);
      if (!['CORRECTION', 'REMPLACEMENT'].includes(r.type))
        throw new BadRequestException('Type de rectification inconnu.');
      const nom = String(r.lire?.nom ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!nom) throw new BadRequestException('Écrivez le nom à lire.');
      const dep = r.lire?.departementId ? Number(r.lire.departementId) : null;
      if (dep && !deps.has(dep))
        throw new BadRequestException('Département inconnu.');
      const naissance = r.lire?.naissance?.trim() || null;
      if (naissance && !/^\d{4}-\d{2}-\d{2}$/.test(naissance))
        throw new BadRequestException(
          `« ${nom} » : date de naissance illisible.`,
        );
      const texte = (v: unknown) => String(v ?? '').trim() || null;
      const mutation =
        n.module === 'MUTATION'
          ? {
              matricule: texte(r.lire?.matricule),
              ge: texte(r.lire?.ge),
              cycle: texte(r.lire?.cycle),
              ancienPoste: texte(r.lire?.ancienPoste),
              lieuSollicite: texte(r.lire?.lieuSollicite),
            }
          : {};
      return {
        id: r.id && /^[\w-]{1,40}$/.test(r.id) ? r.id : randomUUID(),
        type: r.type,
        enroleId: r.enroleId,
        lire: {
          enroleId:
            r.type === 'REMPLACEMENT' &&
            r.lire?.enroleId &&
            r.lire.enroleId !== r.enroleId
              ? r.lire.enroleId
              : null,
          nom,
          naissance,
          lieu: texte(r.lire?.lieu),
          promotion: texte(r.lire?.promotion),
          specialite: texte(r.lire?.specialite),
          diplome: texte(r.lire?.diplome),
          departementId: dep,
          ...mutation,
        },
      };
    });
    await this.notes.update(id, { rectifications: propres });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id, {
      rectifications: propres.length,
    });
    return { ok: true, rectifications: propres.length };
  }

  /**
   * Rectificatif signé : la base suit (nom, date, département… corrigés ; la personne remplacée
   * n'est plus retenue, celle qui la remplace prend son département).
   */
  private async appliquerRectificatif(u: UtilisateurConnecte, n: NoteService) {
    if (n.module === 'MUTATION') {
      for (const r of n.rectifications ?? []) {
        if (r.type === 'CORRECTION')
          await this.demandes.update(r.enroleId, {
            nomComplet: r.lire.nom,
            matricule:
              r.lire.matricule && r.lire.matricule !== 'X'
                ? r.lire.matricule
                : null,
            specialite: r.lire.specialite,
            lieuService: r.lire.ancienPoste ?? undefined,
            lieuSollicite: r.lire.lieuSollicite ?? undefined,
            ...(r.lire.departementId
              ? { departementSolliciteId: r.lire.departementId }
              : {}),
          });
        else {
          // Remplacée : la demande n'est plus mutée ; celle qui la remplace entre dans le rectificatif
          await this.demandes.update(r.enroleId, {
            retiree: true,
            motifRetrait: `Remplacé(e) par le rectificatif n° ${n.numero ?? '?'}`,
          });
          if (r.lire.enroleId)
            await this.demandes.update(r.lire.enroleId, {
              noteId: n.id,
              ...(r.lire.departementId
                ? { departementSolliciteId: r.lire.departementId }
                : {}),
            });
        }
      }
      await this.journal.log(u, 'RECTIFICATIF_APPLIQUE', 'note_service', n.id, {
        rectifications: (n.rectifications ?? []).length,
      });
      return;
    }
    for (const r of n.rectifications ?? []) {
      if (r.type === 'CORRECTION')
        await this.enroles.update(r.enroleId, {
          nomComplet: r.lire.nom,
          nomNormalise: normaliser(r.lire.nom),
          dateNaissance: r.lire.naissance,
          lieuNaissance: r.lire.lieu,
          promotion: r.lire.promotion,
          specialite: r.lire.specialite,
          ...(r.lire.departementId
            ? { departementRetenuId: r.lire.departementId }
            : {}),
        });
      else {
        await this.enroles.update(r.enroleId, {
          etat: 'NON_RETENU',
          motifDecision: `Remplacé(e) par le rectificatif n° ${n.numero ?? '?'}`,
          decidePar: u.nom,
          decideLe: new Date(),
        });
        if (r.lire.enroleId)
          await this.enroles.update(r.lire.enroleId, {
            etat: 'RETENU',
            noteId: n.id,
            ...(r.lire.departementId
              ? { departementRetenuId: r.lire.departementId }
              : {}),
          });
      }
    }
    await this.journal.log(u, 'RECTIFICATIF_APPLIQUE', 'note_service', n.id, {
      rectifications: (n.rectifications ?? []).length,
    });
  }

  /**
   * Une note par type (préscolaire, primaire, DEMA, DCAF, licence, lycée) pour les volontaires
   * retenus d'une campagne (pas encore dans une note), pour l'année scolaire choisie.
   */
  async preparerEnrolement(
    u: UtilisateurConnecte,
    campagneId: number,
    anneeScolaire: string,
  ) {
    const c = await this.campagnes.findOne({ where: { id: campagneId } });
    if (!c) throw new NotFoundException('Campagne introuvable');
    const an = /^(\d{4})-(\d{4})$/.exec(anneeScolaire ?? '');
    if (!an || Number(an[2]) !== Number(an[1]) + 1)
      throw new BadRequestException(
        'Choisissez l’année scolaire (ex. « 2026-2027 »).',
      );
    // Seuls les retenus qui ont leur département retenu entrent dans une note (sinon : note vide,
    // DG 30/10/2026 « comment ça arrive ? »)
    // Regroupés par note (préscolaire = BET + CFEEN préscolaire ; lycée = masters + licences du lycée)
    const parDiplome = [
      ...new Set(
        (
          await this.enroles.find({
            where: {
              campagneId,
              etat: 'RETENU',
              noteId: IsNull(),
              departementRetenuId: Not(IsNull()),
              lotRangement: IsNull(),
            },
          })
        ).map((e) => noteEnrolementDe(e)),
      ),
    ].map((diplome) => ({ diplome }));
    if (!parDiplome.length) {
      const [{ n }] = await this.enroles.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM enrole WHERE "campagneId" = $1 AND etat = 'RETENU' AND "noteId" IS NULL`,
        [campagneId],
      );
      throw new BadRequestException(
        n
          ? `${n} volontaire(s) retenu(s), mais sans département retenu : choisissez d’abord leur département (et leur établissement), puis préparez les notes.`
          : `Aucun volontaire retenu en attente de note dans la campagne ${c.annee} : la DGRHAS doit d’abord retenir des dossiers.`,
      );
    }
    const creees: NoteService[] = [];
    for (const { diplome } of parDiplome) {
      const ouverte = (
        await this.notes.find({
          where: {
            module: 'ENROLEMENT',
            campagneId,
            statut: In(['BROUILLON', 'SOUMISE']),
            rectificatifDe: IsNull(),
          },
        })
      ).find(
        (x) =>
          x.lotRangement == null && this.typesEnrolement(x).includes(diplome),
      );
      if (ouverte) {
        // La note ouverte se met à jour toute seule ; on lui donne l'année choisie
        if (ouverte.anneeScolaire !== anneeScolaire)
          await this.notes.update(ouverte.id, { anneeScolaire });
        continue;
      }
      const rang =
        (await this.notes.count({
          where: { module: 'ENROLEMENT', campagneId, typeNote: diplome },
        })) + 1;
      creees.push(
        await this.notes.save({
          module: 'ENROLEMENT',
          typeNote: diplome,
          campagneId,
          anneeScolaire,
          rang,
          introduction: (NOTES_ENROLEMENT[diplome] ?? NOTES_ENROLEMENT.AUTRE)
            .introduction,
          statut: 'BROUILLON',
          creePar: u.nom,
        }),
      );
    }
    await this.journal.log(
      u,
      'PREPARATION_NOTES_ENROLEMENT',
      'campagne_enrolement',
      String(campagneId),
      {
        notes: creees.map((n) => n.typeNote),
        anneeScolaire,
      },
    );
    return creees;
  }

  /* ============================ Commun =============================== */

  /**
   * Lots réunis dans une note (sans son lot de départ), une seule fois chacun même après
   * plusieurs réunions, dans l'ordre des lots du fichier (I, II, III…).
   */
  private lotsReunis(
    n: NoteService,
    lot?: LotPublication | null,
    lots?: Map<number, LotPublication>,
  ) {
    const vus = new Set(lot ? [libelleLot(lot)] : []);
    return [...new Set(n.lotsFusionnes ?? [])]
      .filter((id) => id !== n.lotPublicationId)
      .map((id) => lots?.get(id))
      .filter((l): l is LotPublication => !!l)
      .sort(ordreLots)
      .filter((l) => {
        const t = libelleLot(l);
        if (vus.has(t)) return false;
        vus.add(t);
        return true;
      });
  }

  private libelle(
    n: NoteService,
    lot?: LotPublication | null,
    lots?: Map<number, LotPublication>,
  ) {
    // Lots réunis : écrits en bref, « Arrêtés — lots VIII, I et II » (DG, 01/11/2026)
    const reunis = this.lotsReunis(n, lot, lots);
    if (n.module === 'NOMINATION')
      return `Nomination – ${CATEGORIE_NOMINATION.get(n.typeNote)?.formule ?? n.typeNote} – ${n.anneeScolaire}${n.rang > 1 ? ` (suite ${n.rang - 1})` : ''}`;
    if (n.module === 'ENROLEMENT')
      return `${n.additifDe ? 'Additif – ' : n.rectificatifDe ? 'Rectificatif – ' : ''}Enrôlement – ${[n.typeNote, ...(n.groupes ?? [])].map((t) => DIPLOMES_ENROLEMENT[t]?.libelle ?? t).join(' + ')} – ${n.anneeScolaire}${n.lotRangement != null ? ` – lot ${n.lotRangement}${(n.libelleLot ?? n.motif) ? ` (${n.libelleLot ?? n.motif})` : ''}` : ''}${n.rang > 1 && !n.additifDe && !n.rectificatifDe ? ` (suite ${n.rang - 1})` : ''}`;
    if (n.module === 'AFFECTATION')
      return `Affectation – ${NOTES_AFFECTATION[n.typeNote as TypeNoteAffectation]?.libelle ?? n.typeNote} – ${lot ? libelleLots(enTete(lot, reunis)) : 'lot ?'}${n.rang > 1 ? ` (suite ${n.rang - 1})` : ''}`;
    return `${n.additifDe ? 'Additif – ' : n.rectificatifDe ? 'Rectificatif – ' : ''}Mutation – ${MOTIFS[n.motif as MotifMutation]?.libelle} – ${this.groupesMutation(
      n,
    )
      .map((g) => LIBELLE_GROUPE[g])
      .join(
        ' + ',
      )}${n.lotRangement != null ? ` – lot ${n.lotRangement}${n.libelleLot ? ` (${n.libelleLot})` : ''}` : ''}${n.rang > 1 && !n.additifDe && !n.rectificatifDe ? ` (suite ${n.rang - 1})` : ''}`;
  }

  /**
   * Titre de la note (DG, 01/11/2026) : « PROJET DE NOTE DE SERVICE » tant que le DG ne l'a pas
   * validée et que le bureau, le service et la direction ne l'ont pas déclarée conforme ;
   * « NOTE DE SERVICE » ensuite, et toujours une fois signée. Paramètre PROJET_DE_NOTE = NON :
   * toujours « NOTE DE SERVICE », comme avant.
   */
  private titreNote(n: NoteService, titre: string) {
    const base = (titre ?? '').replace(/^PROJET DE /, '');
    if (base !== 'NOTE DE SERVICE') return titre;
    if (this.params.get('PROJET_DE_NOTE').trim().toUpperCase() === 'NON')
      return base;
    const conforme = (['BUREAU', 'SERVICE', 'DIRECTION'] as const).every((v) =>
      (n.conformite ?? []).some((a) => a.niveau === v && a.conforme),
    );
    const definitive =
      n.statut === 'SIGNEE' || (n.statut === 'VALIDEE' && conforme);
    return definitive ? base : `PROJET DE ${base}`;
  }

  /** Cycle d'une note, pour la colonne « Cycle » de la liste (DG, 01/11/2026). */
  private cycle(n: NoteService): string | null {
    if (n.module === 'AFFECTATION')
      return (
        {
          PRESCOLAIRE: 'Préscolaire',
          PRIMAIRE: 'Primaire',
          // Enseignants actifs placés dans les établissements du primaire (DGEB)
          ETS: 'Primaire',
          DEMA: 'Collège',
          DECRET_COLLEGE: 'Collège',
          DECRET_LYCEE: 'Lycée',
          PERS_ADM: 'Administration',
        }[n.typeNote] ?? null
      );
    if (n.module === 'MUTATION')
      return (
        this.groupesMutation(n)
          .map((g) => LIBELLE_GROUPE[g])
          .join(' + ') || null
      );
    if (n.module === 'ENROLEMENT')
      return DIPLOMES_ENROLEMENT[n.typeNote]?.cycle || null;
    const c = CATEGORIE_NOMINATION.get(n.typeNote)?.cycle;
    return c ? LIBELLE_CYCLE[c] : null;
  }

  /** Note réunie : son lot de départ et les lots réunis avec lui ; rien pour une note d'un seul lot. */
  private reunion(
    n: NoteService,
    lot?: LotPublication | null,
    lots?: Map<number, LotPublication>,
    /** Personnes de la note venues de ce lot (note en préparation), sinon null. */
    compte?: (lotId: number) => number | null,
  ) {
    if (n.module !== 'AFFECTATION' || !lot) return null;
    const reunis = this.lotsReunis(n, lot, lots);
    if (!reunis.length) return null;
    return {
      depart: libelleLot(lot),
      reunis: reunis.map((x) => libelleLot(x)),
      resume: libelleLots(reunis),
      // Pour le menu déroulant de la liste : chaque lot, le départ d'abord
      lots: [lot, ...reunis].map((x) => ({
        id: x.id,
        libelle: libelleLot(x),
        depart: x.id === lot.id,
        total: compte ? compte(x.id) : null,
      })),
    };
  }

  async liste(module?: string, lot?: number) {
    const where: Record<string, unknown> = {};
    if (module) where.module = module;
    const l = lot ? await this.lots.findOne({ where: { numero: lot } }) : null;
    const notes = (
      await this.notes.find({ where, order: { creeLe: 'DESC' } })
    ).filter(
      (n) =>
        !lot ||
        n.lotPublicationId === (l?.id ?? -1) ||
        (n.lotsFusionnes ?? []).includes(l?.id ?? -1),
    );
    await Promise.all(notes.map((n) => this.suivreAnnee(n)));
    const lots = new Map((await this.lots.find()).map((l) => [l.id, l]));
    // Notes d'affectation en préparation : les lignes prêtes de tous les lots, calculées une
    // seule fois (et non une fois par note), puis comptées par lot et par type de note
    const pretesParNote = new Map<string, number>();
    // (seulement les lots qui ont une note en préparation)
    const lotsEnPreparation = [
      ...new Set(
        notes
          .filter((n) => !n.contenu && n.module === 'AFFECTATION')
          .flatMap((n) => [n.lotPublicationId, ...(n.lotsFusionnes ?? [])])
          .filter((x): x is number => !!x),
      ),
    ];
    if (lotsEnPreparation.length)
      for (const x of await this.affSvc.listeAffectations({
        statut: 'A_TRAITER',
        lotsIds: lotsEnPreparation,
      }))
        if (!x.derive.bloquants.length) {
          const k = `${x.agent.lotPublicationId}|${x.typeNote}`;
          pretesParNote.set(k, (pretesParNote.get(k) ?? 0) + 1);
        }
    const res: unknown[] = [];
    for (const n of notes) {
      const lot = n.lotPublicationId ? lots.get(n.lotPublicationId) : null;
      // Enrôlement : retenus qui attendent leur département (ils n'entrent pas encore dans la note)
      // Mutation : demandes accordées qui attendent hors de la note (points à vérifier)
      const enAttente =
        !n.contenu && n.module === 'ENROLEMENT'
          ? (await this.lignesEnrolement(n)).bloques.length
          : !n.contenu && n.module === 'MUTATION'
            ? (await this.lignesMutationNote(n)).tenues.length
            : 0;
      const lotNumero = lot?.numero ?? null;
      const total = n.contenu
        ? (n.contenu as ContenuNote).total
        : n.module === 'NOMINATION'
          ? (await this.nomSvc.pourNote(n.anneeScolaire, n.typeNote)).length
          : n.module === 'ENROLEMENT'
            ? n.rectificatifDe
              ? (n.rectifications ?? []).length
              : (await this.lignesEnrolement(n)).prets.length
            : n.module === 'AFFECTATION'
              ? [n.lotPublicationId, ...(n.lotsFusionnes ?? [])].reduce<number>(
                  (s, id) =>
                    s + (pretesParNote.get(`${id}|${n.typeNote}`) ?? 0),
                  0,
                )
              : n.rectificatifDe
                ? (n.rectifications ?? []).length
                : (await this.demandesDeLaNoteMutation(n)).length;
      res.push({
        ...n,
        contenu: undefined,
        lotNumero,
        lotLibelle: lot ? libelleLot(lot) : null,
        libelle: this.libelle(n, lot, lots),
        // À titre d'information : la note de départ et les lots réunis avec elle (DG, 01/11/2026)
        reunion: this.reunion(n, lot, lots, (lotId) =>
          n.contenu ? null : (pretesParNote.get(`${lotId}|${n.typeNote}`) ?? 0),
        ),
        cycle: this.cycle(n),
        total,
        enAttente,
      });
    }
    return res;
  }

  /** Clé d'un département sur la note : son titre sans le numéro romain (« II- … »). */
  private cleSection(titre: string | null | undefined) {
    return normaliser((titre ?? '').replace(/^[IVXLCDM]+\s*-\s*/i, ''));
  }

  /**
   * Numéros d'un ADDITIF (réunion DG 06/11/2026) : dans chaque département, la liste reprend après
   * le dernier numéro de la note signée qu'il complète, et des additifs déjà validés de cette note.
   * Un département absent de la note reprend à 1.
   */
  private async continuerNumeros(
    n: NoteService,
    parentId: string,
    contenu: ContenuNote,
  ) {
    const deja = await this.notes.find({
      where: [{ id: parentId }, { additifDe: parentId, id: Not(n.id) }],
      select: ['id', 'contenu'],
    });
    const derniers = new Map<string, number>();
    for (const x of deja) {
      const c = x.contenu as ContenuNote | null;
      if (!c) continue; // additif pas encore validé : ses numéros ne sont pas pris
      for (const sec of c.sections ?? []) {
        const k = this.cleSection(sec.titre);
        const max = Math.max(
          0,
          ...(sec.lignes ?? []).map((l) => Number(l.n) || 0),
        );
        derniers.set(k, Math.max(derniers.get(k) ?? 0, max));
      }
    }
    for (const sec of contenu.sections ?? []) {
      const debut = derniers.get(this.cleSection(sec.titre)) ?? 0;
      if (debut)
        sec.lignes = sec.lignes.map((l) => ({
          ...l,
          n: (Number(l.n) || 0) + debut,
        }));
    }
  }

  async obtenir(id: string) {
    const trouvee = await this.notes.findOne({ where: { id } });
    if (!trouvee) throw new NotFoundException('Note introuvable');
    const n = await this.suivreAnnee(trouvee);
    const lot = n.lotPublicationId
      ? await this.lots.findOne({ where: { id: n.lotPublicationId } })
      : null;
    const contenu =
      (n.contenu as ContenuNote | null) ??
      (n.module === 'AFFECTATION'
        ? await this.contenuAffectation(n)
        : n.module === 'ENROLEMENT'
          ? n.rectificatifDe
            ? await this.contenuRectificatif(n)
            : await this.contenuEnrolement(n)
          : n.module === 'NOMINATION'
            ? await this.contenuNomination(n)
            : n.rectificatifDe
              ? await this.contenuRectificatif(n)
              : await this.contenuMutation(n));
    // Enrôlement (cadrage du 05/11/2026) : colonnes choisies pour la note ; ADDITIF et RECTIFICATIF
    // se rattachent à la note signée qu'ils complètent ou corrigent
    if (n.module === 'ENROLEMENT' || n.module === 'MUTATION') {
      if (n.module === 'ENROLEMENT')
        contenu.colonnes = this.colonnesEnrolement(n);
      const liee = n.additifDe ?? n.rectificatifDe;
      if (liee) {
        contenu.titre = n.additifDe ? 'ADDITIF' : 'RECTIFICATIF';
        contenu.introduction = await this.introductionLiee(n, liee);
      }
      // Un additif encore en préparation continue les numéros de la note complétée (figés ensuite
      // avec le contenu, à la validation)
      if (n.additifDe && !n.contenu)
        await this.continuerNumeros(n, n.additifDe, contenu);
      // Introduction et conclusion réécrites pour cette note (06/11/2026)
      if (n.textesLibres?.introduction)
        contenu.introduction = n.textesLibres.introduction.replaceAll(
          '{annee}',
          n.anneeScolaire,
        );
      if (n.textesLibres?.mentions?.length)
        contenu.mentions = n.textesLibres.mentions;
    }
    contenu.titre = this.titreNote(n, contenu.titre);
    // Structure : le sigle « DDEPPSA … », jamais le nom complet de la direction départementale,
    // même dans une note figée (DG, 01/11/2026) ; de même, le sigle des autres directions (DGEB…)
    const sigles = await siglesDesDirections(this.notes);
    for (const sec of contenu.sections ?? [])
      for (const l of sec.lignes ?? [])
        if (typeof l.structure === 'string')
          l.structure = structureAbregee(l.structure, sigles);
    // Ampliations : toutes les lignes possibles, ajoutées comprises (pour la fenêtre où on les
    // coche), puis celles gardées, avec les archives recalculées (2 + somme des autres)
    const base = contenu.ampliations ?? [];
    const ampliationsToutes = [
      ...base.filter((a) => a.libelle !== 'Archives'),
      ...(n.ampliationsAjoutees ?? []).map((a) => ({ ...a, ajoutee: true })),
      ...base.filter((a) => a.libelle === 'Archives'),
    ];
    contenu.ampliations = this.ampliationsGardees(
      ampliationsToutes,
      n.ampliationsExclues ?? [],
    );
    // Bas de page et repère : simple mise en page, recalculés même pour une note figée
    if (n.module === 'AFFECTATION') {
      const def = NOTES_AFFECTATION[n.typeNote as TypeNoteAffectation];
      if (def)
        contenu.piedDePage = def.piedDePage.replaceAll(
          '{annee}',
          n.anneeScolaire,
        );
    } else if (n.module === 'ENROLEMENT') {
      // Comme les notes signées : « Affectation des enseignants finalistes des ENS/Master et CAPES »
      // (note réunie : les types joints par « et »)
      const court = this.typesEnrolement(n)
        .map((t) => (NOTES_ENROLEMENT[t] ?? NOTES_ENROLEMENT.AUTRE).court)
        .join(' et ');
      contenu.piedDePage = `Affectation des enseignants finalistes des ${court}`;
      contenu.repere = `Enr./${court}`;
    } else if (n.motif) {
      const motif = n.motif as MotifMutation;
      contenu.piedDePage = `${OBJET_MUTATION[motif]}/${GROUPE_COURT[n.typeNote as GroupeMutation]}/${n.anneeScolaire}`;
      contenu.repere = `Mut./${ABREGE_MOTIF[motif]}`;
    }
    const parId = new Map(
      (n.lotsFusionnes?.length
        ? await this.lots.find({ where: { id: In(n.lotsFusionnes) } })
        : []
      ).map((x) => [x.id, x]),
    );
    // Une fois chacun, dans l'ordre du fichier, sans le lot de départ
    const lotsReunis = this.lotsReunis(n, lot, parId);
    return {
      ...n,
      contenu,
      ampliationsToutes,
      lotNumero: lot?.numero ?? null,
      lotLibelle: lot ? libelleLot(lot) : null,
      lotsReunis: lotsReunis.map((x) => ({
        id: x.id,
        numero: x.numero,
        libelle: libelleLot(x),
      })),
      libelle: this.libelle(n, lot, new Map(lotsReunis.map((x) => [x.id, x]))),
      entete: this.entete(n, contenu),
    };
  }

  /**
   * En-tête de la note : figé à la validation (signataire, référence, lieu), sinon lu dans
   * les paramètres. Le bas de page droit prend l'année de la signature.
   */
  private entete(n: NoteService, contenu: unknown): Entete {
    const fige = (
      contenu as { entete?: Entete & { piedDroiteModele?: string } }
    ).entete;
    // Les notes figées avec l'ancienne mention « MEPPSA 2026 » s'écrivent aussi « MEPPSA/2026 »
    const modele = (
      fige?.piedDroiteModele ?? this.params.get('PIED_PAGE_DROITE')
    ).replace(/^MEPPSA \{an\}$/, 'MEPPSA/{an}');
    const an = (n.dateSignature ?? new Date().toISOString()).slice(0, 4);
    const reference =
      fige?.reference ??
      (n.enteteLibre?.reference?.trim() || this.params.get('REFERENCE_NOTE'));
    const lignes = fige?.lignes ?? n.enteteLibre?.lignes ?? null;
    return {
      reference,
      lignes: lignes ?? enteteParDefaut(reference),
      libre: !!(fige?.libre ?? n.enteteLibre),
      signataireTitre:
        fige?.signataireTitre ?? this.params.get('SIGNATAIRE_TITRE'),
      signataireNom: fige?.signataireNom ?? this.params.get('SIGNATAIRE_NOM'),
      lieu: fige?.lieu ?? this.params.get('LIEU_SIGNATURE'),
      piedDroite: modele.replaceAll('{an}', an),
      piedDroiteModele: modele,
      adresse: fige?.adresse ?? this.params.get('ADRESSE_PIED'),
      // Simple présentation : la police réglée s'applique aussi aux notes déjà figées
      police:
        this.params.get('POLICE_NOTES')?.trim().toLowerCase() === 'sylfaen'
          ? 'Sylfaen'
          : 'Times New Roman',
    };
  }

  private async charger(id: string) {
    const n = await this.notes.findOne({ where: { id } });
    if (!n) throw new NotFoundException('Note introuvable');
    return n;
  }

  async modifierIntroduction(
    u: UtilisateurConnecte,
    id: string,
    introduction: string,
  ) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » peut être modifiée',
      );
    if (!introduction?.trim())
      throw new BadRequestException('Introduction vide');
    await this.notes.update(id, { introduction: introduction.trim() });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id);
    return { ok: true };
  }

  /** Lignes d'ampliation décochées sur l'aperçu (tant que la note n'est pas signée). */
  async modifierAmpliations(
    u: UtilisateurConnecte,
    id: string,
    exclues: string[],
    ajoutees?: { libelle: string; nombre: string }[],
  ) {
    const n = await this.charger(id);
    if (n.statut === 'SIGNEE')
      throw new BadRequestException(
        'La note est signée : ses ampliations ne changent plus',
      );
    // Lignes ajoutées : un destinataire et un nombre d'exemplaires (1 à 99), sans doublon
    let ajout = n.ampliationsAjoutees ?? [];
    if (ajoutees) {
      const calculees = (await this.obtenir(id)).ampliationsToutes
        .filter((a) => !('ajoutee' in a))
        .map((a) => a.libelle.toLowerCase());
      const vus = new Set<string>();
      ajout = [];
      for (const a of ajoutees) {
        const libelle = String(a?.libelle ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        const nombre = Number(String(a?.nombre ?? '').trim());
        if (!libelle)
          throw new BadRequestException('Écrivez le destinataire de la copie');
        if (libelle.length > 60)
          throw new BadRequestException(
            `« ${libelle.slice(0, 20)}… » : 60 caractères au plus`,
          );
        if (!Number.isInteger(nombre) || nombre < 1 || nombre > 99)
          throw new BadRequestException(
            `« ${libelle} » : nombre d'exemplaires entre 1 et 99`,
          );
        const cle = libelle.toLowerCase();
        if (cle === 'archives' || calculees.includes(cle) || vus.has(cle))
          throw new BadRequestException(
            `« ${libelle} » figure déjà dans les ampliations`,
          );
        vus.add(cle);
        ajout.push({ libelle, nombre: String(nombre) });
      }
    }
    const liste = [
      ...new Set(
        exclues.map((x) => x.trim()).filter((x) => x && x !== 'Archives'),
      ),
    ];
    await this.notes.update(id, {
      ampliationsExclues: liste,
      ampliationsAjoutees: ajout,
    });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id);
    return { ok: true };
  }

  async soumettre(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException('La note doit être « à soumettre au DG »');
    const { contenu } = await this.obtenir(id);
    if (!contenu.total)
      throw new BadRequestException('La note ne contient aucun agent');
    await this.notes.update(id, {
      statut: 'SOUMISE',
      soumisePar: u.nom,
      commentaire: null,
    });
    await this.journal.log(u, 'NOTE_SOUMISE_DG', 'note_service', id);
    return { ok: true };
  }

  /**
   * Réunir dans cette note les notes d'autres lots (DG, 26/10/2026) : une seule note au lieu de
   * plusieurs, pour des notes d'affectation du même type, encore « à soumettre au DG ».
   * Les autres notes sont retirées ; leurs personnes passent dans celle-ci.
   */
  async fusionner(u: UtilisateurConnecte, id: string, avec: string[]) {
    const n = await this.charger(id);
    const autres = (avec ?? []).filter((x) => x !== id);
    if (!autres.length)
      throw new BadRequestException('Choisissez au moins une autre note.');
    const liste = await this.notes.find({ where: { id: In(autres) } });
    if (liste.length !== autres.length)
      throw new NotFoundException('Une des notes est introuvable.');
    if (n.module === 'ENROLEMENT') return this.reunirEnrolement(u, n, liste);
    if (n.module === 'MUTATION') return this.reunirMutation(u, n, liste);
    for (const x of [n, ...liste]) {
      if (x.module !== 'AFFECTATION')
        throw new BadRequestException(
          'Seules les notes d’affectation se réunissent.',
        );
      if (x.statut !== 'BROUILLON')
        throw new BadRequestException(
          'Seules les notes « à soumettre au DG » se réunissent (renvoyez d’abord une note soumise).',
        );
      if (x.typeNote !== n.typeNote)
        throw new BadRequestException(
          'Les notes à réunir doivent être du même type (mêmes colonnes et même introduction).',
        );
    }
    const lots = [
      ...new Set(
        liste
          .flatMap((x) => [x.lotPublicationId, ...(x.lotsFusionnes ?? [])])
          .filter((x): x is number => !!x),
      ),
    ].filter((x) => x !== n.lotPublicationId);
    const lotsFusionnes = [...new Set([...(n.lotsFusionnes ?? []), ...lots])];
    await this.notes.manager.transaction(async (m) => {
      await m.update(NoteService, n.id, { lotsFusionnes });
      await m.delete(NoteService, { id: In(autres) });
    });
    await this.journal.log(u, 'NOTES_REUNIES', 'note_service', id, {
      notesRetirees: autres.length,
      lots: lotsFusionnes.length + 1,
    });
    return { ok: true, lots: lotsFusionnes.length + 1 };
  }

  /** Défaire la réunion : la note garde son lot ; chaque autre lot retrouve sa note en la préparant. */
  async separer(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » peut être séparée.',
      );
    if (n.module === 'ENROLEMENT') return this.separerEnrolement(u, n);
    if (n.module === 'MUTATION') return this.separerMutation(u, n);
    if (!n.lotsFusionnes?.length)
      throw new BadRequestException('Cette note ne réunit qu’un seul lot.');
    const lots = (
      await this.lots.find({ where: { id: In(n.lotsFusionnes) } })
    ).filter((l) => l.id !== n.lotPublicationId);
    await this.notes.update(n.id, { lotsFusionnes: [] });
    // Chaque lot sorti retrouve sa note « à soumettre au DG » (même type, mêmes quotas, même
    // introduction) : on peut la réunir de nouveau (DG, 01/11/2026). Un lot sans personne prête
    // n'a pas de note.
    const recreees: NoteService[] = [];
    for (const l of lots.sort(ordreLots)) {
      const { prets } = await this.lignesAffectation(
        [l.id],
        n.typeNote,
        n.groupes ?? [],
      );
      if (!prets.length) continue;
      const rang =
        (await this.notes.count({
          where: {
            module: 'AFFECTATION',
            lotPublicationId: l.id,
            typeNote: n.typeNote,
          },
        })) + 1;
      recreees.push(
        await this.notes.save({
          module: 'AFFECTATION',
          typeNote: n.typeNote,
          lotPublicationId: l.id,
          lotsFusionnes: [],
          groupes: n.groupes ?? [],
          anneeScolaire: n.anneeScolaire,
          rang,
          introduction: n.introduction,
          statut: 'BROUILLON',
          creePar: u.nom,
        }),
      );
    }
    await this.journal.log(u, 'NOTES_SEPAREES', 'note_service', id, {
      lots: lots.map((l) => l.numero),
      notesRecreees: recreees.length,
    });
    return {
      ok: true,
      lots: lots.map((l) => l.numero),
      notes: recreees.map((x) => x.id),
    };
  }

  async renvoyer(u: UtilisateurConnecte, id: string, commentaire: string) {
    const n = await this.charger(id);
    if (n.statut !== 'SOUMISE')
      throw new BadRequestException(
        'Seule une note soumise peut être renvoyée',
      );
    await this.notes.update(id, {
      statut: 'BROUILLON',
      commentaire: commentaire?.trim() || null,
    });
    await this.journal.log(u, 'NOTE_RENVOYEE', 'note_service', id, {
      commentaire,
    });
    return { ok: true };
  }

  /** Validation par le DG : le contenu est figé et les agents sont marqués comme traités. */
  async valider(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'SOUMISE')
      throw new BadRequestException('La note doit avoir été soumise au DG');
    const { contenu, entete, ampliationsToutes } = await this.obtenir(id);
    if (!contenu.total)
      throw new BadRequestException('La note ne contient aucun agent');
    const ids = contenu.sections.flatMap((s) => s.lignes.map((l) => l.id));
    // L'en-tête (signataire, référence, lieu) est figé avec le contenu : changer de
    // ministre plus tard ne modifie pas une note déjà validée ou signée
    // Toutes les ampliations calculées sont gardées : les décochées et les ajoutées restent à
    // part (ampliationsExclues, ampliationsAjoutees)
    const fige = {
      ...contenu,
      ampliations: ampliationsToutes.filter((a) => !('ajoutee' in a)),
      bloques: undefined,
      entete,
    };
    await this.notes.manager.transaction(async (m) => {
      if (n.module === 'AFFECTATION')
        await m.update(
          Affectation,
          { id: In(ids), statut: 'A_TRAITER' },
          { statut: 'AFFECTE', noteId: id },
        );
      else if (n.module === 'ENROLEMENT')
        // Un rectificatif a des lignes écrites à la main (« libre-… ») : seuls les dossiers comptent
        await m.update(
          Enrole,
          {
            id: In(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x))),
            noteId: IsNull(),
          },
          { noteId: id },
        );
      else if (n.module === 'NOMINATION')
        await m.update(
          Nomination,
          { id: In(ids.map(Number)), noteId: IsNull() },
          { noteId: id },
        );
      else
        await m.update(
          DemandeMutation,
          {
            id: In(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x))),
            noteId: IsNull(),
          },
          { noteId: id },
        );
      await m.update(NoteService, id, {
        statut: 'VALIDEE',
        contenu: fige,
        valideePar: u.nom,
        valideeLe: new Date(),
      });
    });
    await this.journal.log(u, 'NOTE_VALIDEE_DG', 'note_service', id, {
      agents: ids.length,
    });
    return { ok: true };
  }

  /**
   * Une note validée reste modifiable tant que le ministre ne l'a pas signée :
   * elle redevient un brouillon, ses agents redeviennent « à traiter ».
   */
  async rouvrir(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut === 'SIGNEE')
      throw new BadRequestException(
        'Cette note est signée par le ministre : elle ne peut plus être modifiée.',
      );
    if (n.statut !== 'VALIDEE')
      throw new BadRequestException(
        'Seule une note validée peut être rouverte.',
      );
    await this.notes.manager.transaction(async (m) => {
      if (n.module === 'AFFECTATION')
        await m.update(
          Affectation,
          { noteId: id, statut: 'AFFECTE' },
          { statut: 'A_TRAITER', noteId: null },
        );
      else if (n.module === 'ENROLEMENT')
        await m.update(Enrole, { noteId: id }, { noteId: null });
      else if (n.module === 'NOMINATION')
        await m.update(Nomination, { noteId: id }, { noteId: null });
      else await m.update(DemandeMutation, { noteId: id }, { noteId: null });
      await m.update(NoteService, id, {
        statut: 'BROUILLON',
        contenu: () => 'NULL',
        valideePar: null,
        valideeLe: null,
        // La note va changer : les avis déjà donnés et l'ordre d'impression ne valent plus
        conformite: [],
        impressionPour: null,
        impressionOrdonneePar: null,
        impressionOrdonneeLe: null,
      });
    });
    await this.journal.log(u, 'NOTE_ROUVERTE', 'note_service', id);
    return { ok: true };
  }

  async signer(
    u: UtilisateurConnecte,
    id: string,
    numero: string,
    dateSignature: string,
  ) {
    const n = await this.charger(id);
    if (!['VALIDEE', 'SIGNEE'].includes(n.statut))
      throw new BadRequestException('La note doit être validée par le DG');
    if (!numero?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dateSignature ?? ''))
      throw new BadRequestException('Numéro et date de signature obligatoires');
    await this.notes.update(id, {
      statut: 'SIGNEE',
      numero: numero.trim(),
      dateSignature,
    });
    await this.journal.log(u, 'NOTE_SIGNEE', 'note_service', id, {
      numero,
      dateSignature,
    });
    // Rectificatif d'enrôlement signé (la première fois) : la base suit les corrections
    if (
      (n.module === 'ENROLEMENT' || n.module === 'MUTATION') &&
      n.rectificatifDe &&
      n.statut === 'VALIDEE'
    )
      await this.appliquerRectificatif(u, { ...n, numero: numero.trim() });
    // Note signée : elle entre dans la fiche du personnel de chaque personne (sans faire attendre)
    if (n.module === 'AFFECTATION')
      void this.personnel.synchroniser().catch(() => undefined);
    return { ok: true };
  }

  /* ---------- Avis de conformité, ordre d'impression, scan de la note signée ---------- */

  /** Niveau (bureau, service, direction) où la personne donne son avis de conformité. */
  private async niveauDe(
    u: UtilisateurConnecte,
    force?: string,
  ): Promise<Niveau | null> {
    if (u.role === 'ADMIN' && force && force in LIBELLE_NIVEAU)
      return force as Niveau;
    if (u.structureId) {
      const s = await this.structures.findOne({ where: { id: u.structureId } });
      const n = s ? NIVEAU_PAR_STRUCTURE[s.type] : undefined;
      if (n) return n;
    }
    return NIVEAU_PAR_ROLE[u.role] ?? null;
  }

  /**
   * Après la validation du DG, le chef de bureau, le chef de service et le directeur lisent la note
   * et donnent chacun leur avis de conformité : une erreur ne doit pas arriver jusqu'au ministre.
   */
  async donnerConformite(
    u: UtilisateurConnecte,
    id: string,
    dto: { conforme: boolean; remarque?: string; niveau?: string },
  ) {
    const n = await this.charger(id);
    if (n.statut === 'SIGNEE')
      throw new BadRequestException(
        'Cette note est déjà signée par le ministre : l’avis de conformité ne se donne plus.',
      );
    if (n.statut !== 'VALIDEE')
      throw new BadRequestException(
        'L’avis de conformité se donne sur une note validée par le DG : celle-ci ne l’est pas encore.',
      );
    const niveau = await this.niveauDe(u, dto.niveau);
    if (!niveau)
      throw new BadRequestException(
        'Seuls le chef de bureau, le chef de service et le directeur donnent l’avis de conformité.',
      );
    const remarque = dto.remarque?.trim() || null;
    if (!dto.conforme && !remarque)
      throw new BadRequestException(
        'Dites ce qui n’est pas conforme (une phrase suffit) : le DG pourra rouvrir la note pour la corriger.',
      );
    const avis: AvisConformite = {
      niveau,
      par: u.nom,
      le: new Date().toISOString(),
      conforme: !!dto.conforme,
      remarque,
    };
    const autres = (n.conformite ?? []).filter((a) => a.niveau !== niveau);
    await this.notes.update(id, {
      conformite: [...autres, avis],
      // Un avis « non conforme » annule l'ordre d'impression déjà donné
      ...(avis.conforme
        ? {}
        : {
            impressionPour: null,
            impressionOrdonneePar: null,
            impressionOrdonneeLe: null,
          }),
    });
    await this.journal.log(u, 'NOTE_CONFORMITE', 'note_service', id, {
      niveau,
      conforme: avis.conforme,
      remarque,
    });
    return { ok: true };
  }

  /** Le DG ordonne l'impression de la version qui part à la signature, quand les trois avis sont « conforme ». */
  async ordonnerImpression(u: UtilisateurConnecte, id: string, pour: string) {
    const n = await this.charger(id);
    if (n.statut !== 'VALIDEE')
      throw new BadRequestException(
        n.statut === 'SIGNEE'
          ? 'Cette note est déjà signée par le ministre.'
          : 'La note doit d’abord être validée.',
      );
    if (!['DIRECTEUR', 'SECRETARIAT'].includes(pour))
      throw new BadRequestException(
        'Choisissez à qui demander d’imprimer : le directeur ou le secrétariat.',
      );
    const manque = (['BUREAU', 'SERVICE', 'DIRECTION'] as Niveau[]).filter(
      (v) => !(n.conformite ?? []).some((a) => a.niveau === v && a.conforme),
    );
    if (manque.length)
      throw new BadRequestException(
        `Il manque l’avis de conformité de : ${manque.map((v) => LIBELLE_NIVEAU[v]).join(', ')}. L’impression ne s’ordonne que lorsque les trois ont déclaré la note conforme.`,
      );
    await this.notes.update(id, {
      impressionPour: pour,
      impressionOrdonneePar: u.nom,
      impressionOrdonneeLe: new Date(),
    });
    await this.journal.log(u, 'NOTE_IMPRESSION_ORDONNEE', 'note_service', id, {
      pour,
    });
    return { ok: true };
  }

  /** Le scan ne se joint qu'à une note signée : contrôlé avant d'envoyer le fichier. */
  async verifierScanPossible(id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'SIGNEE')
      throw new BadRequestException(
        'Enregistrez d’abord le numéro et la date de signature, puis joignez le scan de la note signée.',
      );
  }

  /** Scan PDF de la note signée : il clôture l'opération et part aux archives. */
  async enregistrerScan(
    u: UtilisateurConnecte,
    id: string,
    fichier: string,
    nomOrigine: string,
  ) {
    const n = await this.charger(id);
    if (n.statut !== 'SIGNEE')
      throw new BadRequestException(
        'Enregistrez d’abord le numéro et la date de signature, puis joignez le scan de la note signée.',
      );
    await this.notes.update(id, {
      scanFichier: fichier,
      scanNom: nomOrigine,
      scanLe: new Date(),
      scanPar: u.nom,
    });
    await this.journal.log(u, 'NOTE_SCAN_AJOUTE', 'note_service', id, {
      numero: n.numero,
    });
    // Clôture : le dossier va aux archives et retourne au demandeur (DG, 27/10/2026). C'est le
    // chef d'établissement qui a déposé la demande : sa structure est prévenue, pour remettre la
    // réponse à l'agent. Une seule fois (un nouveau scan ne renvoie pas l'alerte).
    if (n.module === 'MUTATION' && !n.scanLe) await this.retourDemandeurs(n);
    return { ok: true, ancien: n.scanFichier };
  }

  /** Alerte « dossier clos » à la structure de départ de chaque demande de la note. */
  private async retourDemandeurs(n: NoteService) {
    const demandes = await this.demandes.find({
      where: { noteId: n.id },
      select: {
        id: true,
        numeroEnregistrement: true,
        nomComplet: true,
        structureOrigineId: true,
        circuit: true,
      },
    });
    const signee = n.dateSignature
      ? ` le ${String(n.dateSignature).slice(0, 10).split('-').reverse().join('/')}`
      : '';
    for (const d of demandes) {
      const structures = [
        d.structureOrigineId,
        d.circuit?.[0]?.structureId ?? null,
      ].filter((x): x is number => !!x);
      if (!structures.length) continue;
      await this.demandes.manager.save(Alerte, {
        demandeId: d.id,
        type: 'CLOTURE',
        texte: `Demande n° ${d.numeroEnregistrement} (${d.nomComplet}) : dossier clos. La note de service n° ${n.numero ?? '—'} signée${signee} est aux archives. Remettez la réponse à l’agent.`,
        structures: [...new Set(structures)],
      });
    }
  }

  async cheminScan(id: string) {
    const n = await this.charger(id);
    if (!n.scanFichier)
      throw new NotFoundException('Aucun scan pour cette note.');
    return { fichier: n.scanFichier, nom: n.scanNom ?? 'note-signee.pdf' };
  }

  /** Ce qui attend la personne : avis à donner, impressions, signatures à clôturer, dossiers à confier. */
  async aFaire(u: UtilisateurConnecte) {
    const niveau = await this.niveauDe(u);
    const lots = new Map((await this.lots.find()).map((l) => [l.id, l]));
    const lib = (n: NoteService) =>
      this.libelle(
        n,
        n.lotPublicationId ? lots.get(n.lotPublicationId) : null,
        lots,
      );
    const jours = (d: Date | null) => joursDepuis(d);
    const notes: {
      id: string;
      libelle: string;
      module: string;
      action: string;
      detail: string;
      depuis: number | null;
      /** Page à ouvrir quand ce n'est pas une note (agents ajoutés au recensement…). */
      lien?: string;
    }[] = [];
    // Agents ajoutés au recensement (absents de la base) : contrôle, puis décision du DG
    const etapeRecensement =
      u.role === 'DG'
        ? {
            etat: 'CONTROLE',
            action: 'RECENSEMENT_DECISION',
            onglet: 'decider',
          }
        : ['CHEF_SERVICE', 'DIRECTEUR', 'BUREAU_ETUDES', 'ADMIN'].includes(
              u.role,
            )
          ? {
              etat: 'EN_COURS',
              action: 'RECENSEMENT_CONTROLE',
              onglet: 'controler',
            }
          : null;
    if (etapeRecensement) {
      const [r] = await this.notes.query<
        { n: number; plusAncien: string | null }[]
      >(
        `SELECT count(*)::int AS n, min(contentieux->>'ouvertLe') AS "plusAncien" FROM agent_recense WHERE contentieux->>'etat' = $1`,
        [etapeRecensement.etat],
      );
      if (r?.n)
        notes.push({
          id: `recensement-${etapeRecensement.onglet}`,
          libelle: `Recensement : ${r.n} agent(s) ajouté(s), absents de la base`,
          module: 'RECENSEMENT',
          action: etapeRecensement.action,
          detail:
            u.role === 'DG'
              ? 'Contrôlés par le bureau du contrôle : acceptez-les dans la base, ou rejetez-les.'
              : 'Vérifiez chaque fiche (pièces, même personne déjà dans la base ?) et donnez votre avis au DG.',
          depuis: jours(r.plusAncien ? new Date(r.plusAncien) : null),
          lien: `/recensement?onglet=${etapeRecensement.onglet}`,
        });
    }
    const validees = await this.notes.find({ where: { statut: 'VALIDEE' } });
    for (const n of validees) {
      const avis = n.conformite ?? [];
      const base = { id: n.id, libelle: lib(n), module: n.module };
      const depuis = jours(n.valideeLe);
      if (niveau && u.role !== 'DG' && !avis.some((a) => a.niveau === niveau))
        notes.push({
          ...base,
          action: 'CONFORMITE',
          detail:
            'Lisez la note, puis dites si elle est conforme (votre visa y est engagé).',
          depuis,
        });
      if (u.role === 'DG' || u.role === 'ADMIN') {
        const tous = (['BUREAU', 'SERVICE', 'DIRECTION'] as Niveau[]).every(
          (v) => avis.some((a) => a.niveau === v && a.conforme),
        );
        const refus = avis.find((a) => !a.conforme);
        if (refus)
          notes.push({
            ...base,
            action: 'NON_CONFORME',
            detail: `${refus.par} : « ${refus.remarque} ». Rouvrez la note pour la corriger.`,
            depuis,
          });
        else if (tous && !n.impressionPour)
          notes.push({
            ...base,
            action: 'ORDONNER',
            detail:
              'Les trois avis sont conformes : ordonnez l’impression (directeur ou secrétariat).',
            depuis,
          });
        else if (!tous)
          notes.push({
            ...base,
            action: 'EN_ATTENTE',
            detail: `Avis reçus : ${avis.length}/3.`,
            depuis,
          });
      }
      if (n.impressionPour && u.role === n.impressionPour)
        notes.push({
          ...base,
          action: 'IMPRIMER',
          detail: `Le DG vous demande d’imprimer la note pour la signature du ministre (ordre de ${n.impressionOrdonneePar}).`,
          depuis: jours(n.impressionOrdonneeLe),
        });
    }
    if (
      u.role !== 'STRUCTURE' &&
      u.role !== 'DDEPPSA' &&
      u.role !== 'CABINET'
    ) {
      // Notes signées récemment : les anciennes (avant ce circuit) ne réclament pas leur scan
      const asigner = await this.notes
        .createQueryBuilder('n')
        .where("n.statut = 'SIGNEE'")
        .andWhere('n.scanFichier IS NULL')
        .andWhere("n.valideeLe > now() - interval '90 days'")
        .getMany();
      for (const n of asigner)
        notes.push({
          id: n.id,
          libelle: lib(n),
          module: n.module,
          action: 'SCANNER',
          detail: `Note n° ${n.numero} signée : joignez le scan PDF pour clôturer et archiver.`,
          depuis: jours(n.modifieLe),
        });
    }
    const dossiers: {
      id: string;
      numero: number;
      nomComplet: string;
      action: string;
      detail: string;
      depuis: number | null;
    }[] = [];
    const accordes = await this.demandes
      .createQueryBuilder('d')
      .where("(d.decision = 'ACCORDEE' OR d.instructionMinistre = 'ACCORDEE')")
      .andWhere('d.retiree = false')
      .getMany();
    for (const d of accordes) {
      const base = {
        id: d.id,
        numero: d.numeroEnregistrement,
        nomComplet: d.nomComplet,
      };
      // Seulement les décisions récentes, pas encore dans une note : les anciennes ne sont pas à renvoyer
      if (
        u.role === 'DG' &&
        !d.envoyeSecretariatLe &&
        !d.noteId &&
        d.canal !== 'IMPORT' &&
        d.decisionLe &&
        (jours(d.decisionLe) ?? 999) <= 60
      )
        dossiers.push({
          ...base,
          action: 'ENVOYER',
          detail:
            'Dossier accordé, pas encore envoyé au secrétariat : sans cela, la fiche et les pièces jointes ne seront pas imprimées.',
          depuis: jours(d.decisionLe),
        });
      if (
        u.role === 'SECRETARIAT' &&
        d.envoyeSecretariatLe &&
        (jours(d.envoyeSecretariatLe) ?? 0) <= 45
      )
        dossiers.push({
          ...base,
          action: 'IMPRIMER_DOSSIER',
          detail: 'Imprimez la fiche individuelle et les pièces jointes.',
          depuis: jours(d.envoyeSecretariatLe),
        });
    }
    return { notes, dossiers, total: notes.length + dossiers.length };
  }

  async supprimer(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » peut être supprimée',
      );
    // Lot de rangement supprimé : ses volontaires reviennent dans la note principale
    if (n.module === 'ENROLEMENT' && n.lotRangement != null)
      await this.enroles.update(
        {
          campagneId: n.campagneId ?? -1,
          lotRangement: n.lotRangement,
          noteId: IsNull(),
        },
        { lotRangement: null },
      );
    if (n.module === 'MUTATION' && n.lotRangement != null)
      await this.demandes.update(
        {
          motif: n.motif ?? '',
          lotRangement: n.lotRangement,
          noteId: IsNull(),
        },
        { lotRangement: null },
      );
    await this.notes.delete(id);
    await this.journal.log(u, 'NOTE_SUPPRIMEE', 'note_service', id);
    return { ok: true };
  }

  /** La note au format Word : même mise en page que la version imprimée, modifiable. */
  async word(
    id: string,
    avecVisas = true,
    echelle = 1,
  ): Promise<{ nom: string; contenu: Buffer }> {
    const n = await this.obtenir(id);
    return {
      nom: `${n.libelle
        .replace(/[^\p{L}\p{N} ()-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()}.docx`,
      contenu: await noteWord(n, avecVisas, echelle),
    };
  }

  /** La note au format Excel (mêmes informations que la version imprimée). */
  /**
   * RÉCAPITULATIF d'une note (réunion DG du 06/11/2026) : « une note à laquelle on a ajouté des noms,
   * on a rectifié… il faut connaître la liste définitive ». On part de la note de base, on ajoute
   * les personnes de ses additifs, on applique ses rectificatifs (« au lieu de … lire … » ; la
   * personne remplacée sort de la liste, celle qui la remplace y entre). Rien n'est enregistré :
   * c'est une vue, recalculée à chaque fois. Les notes pas encore signées sont signalées.
   */
  async recapitulatif(id: string) {
    let racine = await this.charger(id);
    // Remonter à la note de base (un rectificatif d'additif remonte aussi)
    for (let i = 0; i < 5; i++) {
      const parent = racine.additifDe ?? racine.rectificatifDe;
      if (!parent) break;
      racine = await this.charger(parent);
    }
    if (racine.module !== 'ENROLEMENT' && racine.module !== 'MUTATION')
      throw new BadRequestException(
        'Le récapitulatif concerne les notes d’enrôlement et de mutation.',
      );
    const additifs = await this.notes.find({
      where: { additifDe: racine.id },
      order: { creeLe: 'ASC' },
    });
    const rectificatifs = await this.notes.find({
      where: { rectificatifDe: In([racine.id, ...additifs.map((a) => a.id)]) },
      order: { creeLe: 'ASC' },
    });
    const signee = (x: NoteService) => x.statut === 'SIGNEE';
    const nomDe = (x: NoteService, type: string) =>
      `${type}${x.numero ? ` n° ${x.numero}` : ''}${x.dateSignature ? ` du ${x.dateSignature.split('-').reverse().join('/')}` : ''}${signee(x) ? '' : ' (pas encore signé)'}`;
    const base = await this.obtenir(racine.id);
    const colonnes = base.contenu.colonnes;
    // Les sections, par département (titre sans le numéro romain)
    type Ligne = {
      id: string;
      n: number;
      source: string;
      changements: string[];
      provisoire: boolean;
      [cle: string]: unknown;
    };
    const sections = new Map<string, { titre: string; lignes: Ligne[] }>();
    const sectionDe = (titre: string | null) => {
      const t = (titre ?? '').replace(/^[IVXLCDM]+\s*-\s*/i, '');
      const k = this.cleSection(t);
      if (!sections.has(k)) sections.set(k, { titre: t, lignes: [] });
      return sections.get(k)!;
    };
    const ajouter = async (x: NoteService, type: string) => {
      const o = x.id === racine.id ? base : await this.obtenir(x.id);
      let titre: string | null = null;
      for (const s of o.contenu.sections) {
        if (s.titre) titre = s.titre;
        const sec = sectionDe(titre);
        for (const l of s.lignes)
          sec.lignes.push({
            ...l,
            source: nomDe(x, type),
            changements: [],
            provisoire: !signee(x),
          });
      }
    };
    await ajouter(racine, 'Note');
    for (const a of additifs) await ajouter(a, 'Additif');
    // Rectificatifs : corrections et remplacements
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d] as const),
    );
    const sectionDuDepartement = (depId: number) => {
      const d = deps.get(depId);
      if (!d) return null;
      const nom = normaliser(d.nom);
      for (const [k, s] of sections) if (k.endsWith(nom)) return s;
      return sectionDe(titreDepartement(d));
    };
    const retires: {
      nom: string;
      raison: string;
      provisoire: boolean;
    }[] = [];
    const champsLire: [string, string][] = [
      ['nom', 'nom'],
      ['matricule', 'matricule'],
      ['ge', 'ge'],
      ['cycle', 'cycle'],
      ['specialite', 'specialite'],
      ['ancienPoste', 'ancienPoste'],
      ['lieuSollicite', 'lieuSollicite'],
      ['naissance', 'naissance'],
      ['lieu', 'lieu'],
      ['promotion', 'promotion'],
      ['diplome', 'diplome'],
    ];
    for (const r of rectificatifs) {
      const nomR = nomDe(r, 'Rectificatif');
      for (const x of r.rectifications ?? []) {
        let trouve: { sec: { lignes: Ligne[] }; i: number } | null = null;
        for (const sec of sections.values()) {
          const i = sec.lignes.findIndex((l) => l.id === x.enroleId);
          if (i >= 0) trouve = { sec, i };
        }
        if (!trouve) continue;
        const avant = trouve.sec.lignes[trouve.i];
        const lire = x.lire as unknown as Record<string, unknown>;
        const nouvelle: Ligne = {
          ...avant,
          changements: [...avant.changements],
          provisoire: avant.provisoire || !signee(r),
        };
        for (const [cle, champ] of champsLire)
          if (cle in avant && lire[champ] !== undefined)
            nouvelle[cle] = (lire[champ] as string | null) ?? null;
        if (x.type === 'REMPLACEMENT') {
          // Ce que le rectificatif ne dit pas de la personne qui remplace reste vide (pas la
          // durée ou la justification de celle qui est remplacée)
          const dits = new Set(
            champsLire
              .filter(([, champ]) => lire[champ] !== undefined)
              .map(([cle]) => cle),
          );
          for (const c of colonnes)
            if (c.cle !== 'origine' && !dits.has(c.cle)) nouvelle[c.cle] = null;
          if (x.lire.enroleId) nouvelle.id = x.lire.enroleId;
          nouvelle.source = nomR;
          nouvelle.changements = [`Remplace ${String(avant.nom)}`];
          retires.push({
            nom: String(avant.nom),
            raison: `Remplacé(e) par ${x.lire.nom} (${nomR})`,
            provisoire: !signee(r),
          });
        } else {
          const ecarts = champsLire
            .filter(
              ([cle]) =>
                cle in avant &&
                String(avant[cle] ?? '') !== String(nouvelle[cle] ?? ''),
            )
            .map(
              ([cle]) =>
                `${cle === 'nom' ? 'nom' : (colonnes.find((c) => c.cle === cle)?.libelle.replace('-', '') ?? cle)} : ${String(avant[cle] ?? '—')} → ${String(nouvelle[cle] ?? '—')}`,
            );
          nouvelle.changements.push(
            `Rectifié (${nomR})${ecarts.length ? ` : ${ecarts.join(' ; ')}` : ''}`,
          );
        }
        // Un autre département : la ligne change de tableau
        const cible =
          x.lire.departementId != null
            ? sectionDuDepartement(x.lire.departementId)
            : null;
        if (cible && cible !== trouve.sec) {
          trouve.sec.lignes.splice(trouve.i, 1);
          cible.lignes.push(nouvelle);
          if (x.type !== 'REMPLACEMENT')
            nouvelle.changements.push(`Département changé (${nomR})`);
        } else trouve.sec.lignes[trouve.i] = nouvelle;
      }
    }
    // Numéros définitifs : de 1 à n dans chaque département
    const finales = [...sections.values()]
      .filter((s) => s.lignes.length)
      .map((s, i) => ({
        titre: s.titre ? `${entierVersRomain(i + 1)}- ${s.titre}` : null,
        lignes: s.lignes.map((l, j) => ({ ...l, n: j + 1 })),
      }));
    const total = finales.reduce((t, s) => t + s.lignes.length, 0);
    const notesFamille = [
      {
        id: racine.id,
        type: 'NOTE',
        nom: nomDe(racine, 'Note'),
        signee: signee(racine),
        effectif: base.contenu.total,
      },
      ...(await Promise.all(
        additifs.map(async (a) => ({
          id: a.id,
          type: 'ADDITIF',
          nom: nomDe(a, 'Additif'),
          signee: signee(a),
          effectif: (await this.obtenir(a.id)).contenu.total,
        })),
      )),
      ...rectificatifs.map((r) => ({
        id: r.id,
        type: 'RECTIFICATIF',
        nom: nomDe(r, 'Rectificatif'),
        signee: signee(r),
        effectif: (r.rectifications ?? []).length,
      })),
    ];
    return {
      racine: {
        id: racine.id,
        libelle: base.libelle,
        module: racine.module,
        numero: racine.numero,
        dateSignature: racine.dateSignature,
        statut: racine.statut,
      },
      notes: notesFamille,
      colonnes,
      sections: finales,
      retires,
      total,
      // Une note vide pas encore signée (additif sans personne) ne change rien à la liste
      provisoire: notesFamille.some((x) => !x.signee && x.effectif > 0),
    };
  }

  /** Le récapitulatif en Excel : la liste définitive, avec la provenance et les changements. */
  async recapitulatifExcel(id: string) {
    const r = await this.recapitulatif(id);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Récapitulatif', {
      pageSetup: {
        paperSize: 9,
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    const cles = ['n', ...r.colonnes.map((c) => c.cle)];
    ws.addRow([`RÉCAPITULATIF — ${r.racine.libelle}`]).font = {
      bold: true,
      size: 13,
    };
    ws.addRow([
      r.notes.map((x) => x.nom).join(' ; ') +
        (r.provisoire
          ? ' — liste provisoire : une note de la famille n’est pas encore signée.'
          : ''),
    ]);
    ws.addRow([]);
    const entete = ws.addRow([
      'N°',
      ...r.colonnes.map((c) => c.libelle.replace('-', '')),
      'Vient de',
      'Changements',
    ]);
    entete.font = { bold: true };
    for (const s of r.sections) {
      if (s.titre) ws.addRow([s.titre]).font = { bold: true };
      for (const l of s.lignes)
        ws.addRow([
          ...cles.map((k) => l[k] ?? ''),
          l.source,
          l.changements.join(' ; '),
        ]);
    }
    if (r.retires.length) {
      ws.addRow([]);
      ws.addRow(['Ne figurent plus sur la liste']).font = { bold: true };
      for (const x of r.retires) ws.addRow(['', x.nom, x.raison]);
    }
    ws.addRow([]);
    ws.addRow([`Total : ${r.total}`]).font = { bold: true };
    ws.columns = [...cles, 'source', 'changements'].map((k) => ({
      width:
        k === 'n'
          ? 5
          : k === 'nom'
            ? 34
            : k === 'changements'
              ? 48
              : k === 'source'
                ? 30
                : 16,
    }));
    return {
      nom: `Récapitulatif - ${r.racine.libelle}.xlsx`.replace(
        /[\\/:*?"<>|]/g,
        '-',
      ),
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }

  async excel(id: string): Promise<{ nom: string; contenu: Buffer }> {
    const n = await this.obtenir(id);
    const c = n.contenu;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Note de service', {
      pageSetup: {
        paperSize: 9,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    const colonnes = c.classification
      ? [
          'N°',
          'Noms et prénoms',
          ...(c.colonnes.some((x) => x.cle === 'grade') ? ['Grade'] : []),
          'Cat',
          'Ech',
          'Echl',
          ...c.colonnes
            .filter((x) => !['nom', 'grade'].includes(x.cle))
            .map((x) => x.libelle),
        ]
      : ['N°', ...c.colonnes.map((x) => x.libelle.replace('-', ''))];
    const cles = c.classification
      ? [
          'n',
          'nom',
          ...(c.colonnes.some((x) => x.cle === 'grade') ? ['grade'] : []),
          'cat',
          'ech',
          'echl',
          ...c.colonnes
            .filter((x) => !['nom', 'grade'].includes(x.cle))
            .map((x) => x.cle),
        ]
      : ['n', ...c.colonnes.map((x) => x.cle)];
    // Chaque colonne à la largeur de son contenu (bornée) : rien ne déborde sur la voisine (DG, 29/10/2026)
    const longues = [
      'reference',
      'ancienPoste',
      'nouveauPoste',
      'structure',
      'etablissement',
      'specialite',
      'lieu',
    ];
    const largeurs = cles.map((k, i) => {
      const max = k === 'nom' ? 38 : longues.includes(k) ? 30 : 16;
      const min = k === 'n' ? 4 : k === 'nom' ? 24 : 6;
      const contenu = Math.max(
        ...colonnes[i].split(/\s+/).map((m) => m.length + 1),
        ...c.sections.flatMap((x) =>
          x.lignes.map((l) => String(l[k] ?? '').length + 1),
        ),
      );
      return Math.min(max, Math.max(min, contenu));
    });
    ws.columns = largeurs.map((width) => ({ width }));
    const texte = (v: string, gras = false, taille = 10) => {
      const r = ws.addRow([v]);
      ws.mergeCells(r.number, 1, r.number, cles.length);
      r.getCell(1).font = { bold: gras, size: taille };
      r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
      return r;
    };
    texte(
      "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION — CABINET — DGRHAS — DRSC",
      true,
      9,
    );
    texte(`N° ${n.numero ?? '________'}/${n.entete.reference}`, true);
    texte('');
    const t = texte(c.titre, true, 14);
    t.getCell(1).alignment = { horizontal: 'center' };
    const intro = texte(c.introduction);
    intro.height = 60;
    const bord: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
    for (const sec of c.sections) {
      texte('');
      if (sec.titre) texte(sec.titre, true);
      if (sec.sousTitre) texte(`      ${sec.sousTitre}`, true);
      const e = ws.addRow(colonnes);
      e.eachCell((cell) => {
        cell.font = { bold: true, size: 9 };
        cell.border = bord;
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
        };
      });
      for (const l of sec.lignes) {
        const r = ws.addRow(cles.map((k) => l[k] ?? null));
        // La hauteur suit la cellule qui passe le plus à la ligne
        r.height = Math.max(
          15,
          12.5 *
            Math.max(
              1,
              ...cles.map((k, i) =>
                Math.ceil(
                  String(l[k] ?? '').length / Math.max(1, largeurs[i] - 1),
                ),
              ),
            ),
        );
        r.eachCell({ includeEmpty: true }, (cell, i) => {
          if (i > cles.length) return;
          cell.font = { size: 9 };
          cell.border = bord;
          cell.alignment = {
            vertical: 'middle',
            wrapText: true,
            horizontal: ['nom', 'ancienPoste'].includes(cles[i - 1])
              ? 'left'
              : 'center',
          };
        });
      }
    }
    texte('');
    for (const m of c.mentions) texte(m);
    texte('');
    texte(`Fait à ${n.entete.lieu}, le ${n.dateSignature ?? ''}`);
    texte(n.entete.signataireTitre);
    texte(n.entete.signataireNom, true);
    texte('');
    texte('Ampliations :', true);
    // Ampliations : le libellé sur toute la largeur sauf la dernière colonne (le nombre) : rien ne déborde
    for (const a of c.ampliations) {
      const r = ws.addRow([a.libelle]);
      r.getCell(cles.length).value = a.nombre;
      if (cles.length > 2)
        ws.mergeCells(r.number, 1, r.number, cles.length - 1);
      r.font = { size: 9 };
      r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(cles.length).alignment = { horizontal: 'center' };
    }
    return {
      nom: `${n.libelle
        .replace(/[^\p{L}\p{N} ()-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()}.xlsx`,
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }

  /* ============ Note de mutation signée → base du personnel (06/11/2026) ============ */

  /** Note de mutation signée (le report vers la base du personnel n'a de sens qu'alors). */
  private async noteMutationSignee(id: string) {
    const n = await this.charger(id);
    if (n.module !== 'MUTATION')
      throw new BadRequestException('Réservé aux notes de mutation.');
    if (n.statut !== 'SIGNEE')
      throw new BadRequestException(
        'La note doit être signée (numéro et date enregistrés) avant d’aller dans la base du personnel.',
      );
    return n;
  }

  /** Demandes d'une note signée (le contenu figé fait foi). */
  private async demandesSignees(n: NoteService) {
    const ids = ((n.contenu as ContenuNote | null)?.sections ?? [])
      .flatMap((s) => s.lignes.map((l) => l.id))
      .filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    const viaNote = await this.demandes.find({ where: { noteId: n.id } });
    return [...new Set([...ids, ...viaNote.map((d) => d.id)])];
  }

  /**
   * « Importer dans la base du personnel » : où en est chaque personne de la note. Le système
   * cherche d'abord sa fiche (matricule, nom et département) ; on tranche les doutes, on crée les
   * fiches manquantes, puis on reporte la mutation sur les fiches.
   */
  async personnelDeLaNote(id: string) {
    const n = await this.noteMutationSignee(id);
    const ids = await this.demandesSignees(n);
    // Chercher les fiches de ceux qui n'en ont pas encore (aucune fiche n'est modifiée ici)
    await this.rattachementSvc.rattacher('MUTATION', ids);
    const demandes = await this.demandes.find({
      where: { id: In(ids.concat(['00000000-0000-0000-0000-000000000000'])) },
    });
    const doutes = new Map(
      (await this.rattachementSvc.aTrancher('MUTATION', ids)).map(
        (x) => [x.id, x] as const,
      ),
    );
    const fiches = new Map(
      (
        await this.notes.query<
          {
            id: number;
            numeroFiche: string | null;
            nomComplet: string;
            lieu: string | null;
            aValider: boolean;
          }[]
        >(
          `SELECT id, "numeroFiche", "nomComplet", donnees->>'LIEU_SERVICE' AS lieu, (liaison ? 'aValider') AS "aValider"
             FROM agent_recense WHERE id = ANY($1)`,
          [demandes.map((d) => d.agentId).filter((x): x is number => !!x)],
        )
      ).map((f) => [f.id, f] as const),
    );
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d.nom] as const),
    );
    const personnes = demandes
      .map((d) => {
        const fiche = d.agentId ? (fiches.get(d.agentId) ?? null) : null;
        const doute = doutes.get(d.id);
        return {
          id: d.id,
          nom: d.nomComplet,
          matricule: d.matricule,
          origine: deps.get(d.departementOrigineId ?? -1) ?? null,
          destination:
            [deps.get(d.departementSolliciteId ?? -1), d.lieuSollicite]
              .filter(Boolean)
              .join(' · ') || null,
          etat: fiche
            ? fiche.aValider
              ? 'CREEE'
              : 'LIEE'
            : d.rattachement === 'SANS_FICHE'
              ? 'SANS_FICHE'
              : (doute?.etat ?? 'INTROUVABLE'),
          fiche: fiche
            ? {
                id: fiche.id,
                numero: fiche.numeroFiche,
                nom: fiche.nomComplet,
                lieu: fiche.lieu,
              }
            : null,
          candidats: doute?.candidats ?? [],
        };
      })
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    return {
      note: { id: n.id, numero: n.numero, libelle: this.libelle(n) },
      reporteLe: n.reportePersonnelLe,
      reportePar: n.reportePersonnelPar,
      personnes,
    };
  }

  /** Décision sur une personne de la note : c'est cette fiche, créer sa fiche, ou laisser sans fiche. */
  async decisionPersonnel(
    u: UtilisateurConnecte,
    id: string,
    demandeId: string,
    action: 'LIER' | 'CREER' | 'SANS_FICHE',
    agentId?: number,
  ) {
    const n = await this.noteMutationSignee(id);
    if (!(await this.demandesSignees(n)).includes(demandeId))
      throw new BadRequestException('Cette personne n’est pas dans la note.');
    return this.rattachementSvc.decider(
      u,
      'MUTATION',
      demandeId,
      action,
      agentId,
    );
  }

  /** Créer d'un coup les fiches des personnes introuvables de la note (signalées « à valider »). */
  async creerFichesNote(u: UtilisateurConnecte, id: string) {
    const n = await this.noteMutationSignee(id);
    return this.rattachementSvc.creerToutes(
      u,
      'MUTATION',
      await this.demandesSignees(n),
    );
  }

  /**
   * Reporter la note dans la base du personnel : chaque fiche rattachée prend le nouveau lieu de
   * service, le nouveau département et une ligne dans ses affectations successives.
   */
  async reporterPersonnel(u: UtilisateurConnecte, id: string) {
    const n = await this.noteMutationSignee(id);
    const ids = await this.demandesSignees(n);
    const demandes = await this.demandes.find({
      where: { id: In(ids.concat(['00000000-0000-0000-0000-000000000000'])) },
    });
    const avecFiche = demandes.filter((d) => d.agentId && !d.retiree).length;
    if (!avecFiche)
      throw new BadRequestException(
        'Aucune personne de la note n’est rattachée à une fiche : rattachez-les d’abord (ou créez leurs fiches).',
      );
    await this.notes.update(id, {
      reportePersonnelLe: new Date(),
      reportePersonnelPar: u.nom,
    });
    await this.personnel.synchroniser();
    await this.journal.log(
      u,
      'MUTATIONS_REPORTEES_PERSONNEL',
      'note_service',
      id,
      {
        fiches: avecFiche,
        sansFiche: demandes.length - avecFiche,
      },
    );
    return {
      ok: true,
      fiches: avecFiche,
      sansFiche: demandes.length - avecFiche,
    };
  }
}
