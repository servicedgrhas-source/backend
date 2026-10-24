import { distance } from './ressemblance';
import { cleCompacte, normaliser, sansPrefixeNumero } from './texte';

/* ------------------------------------------------------------------ */
/* Départements scolaires (15, ordre alphabétique des notes de service) */
/* ------------------------------------------------------------------ */

export interface DepartementRef {
  code: string;
  nom: string;
  /** Article utilisé dans « DEPARTEMENT SCOLAIRE DE LA BOUENZA ». */
  article: string;
}

export const DEPARTEMENTS: DepartementRef[] = [
  { code: 'BOUENZA', nom: 'Bouenza', article: 'DE LA' },
  { code: 'BRAZZAVILLE', nom: 'Brazzaville', article: 'DE' },
  { code: 'CONGO_OUBANGUI', nom: 'Congo-Oubangui', article: 'DU' },
  { code: 'CUVETTE', nom: 'Cuvette', article: 'DE LA' },
  { code: 'CUVETTE_OUEST', nom: 'Cuvette-Ouest', article: 'DE LA' },
  { code: 'DJOUE_LEFINI', nom: 'Djoué-Léfini', article: 'DU' },
  { code: 'KOUILOU', nom: 'Kouilou', article: 'DU' },
  { code: 'LEKOUMOU', nom: 'Lékoumou', article: 'DE LA' },
  { code: 'LIKOUALA', nom: 'Likouala', article: 'DE LA' },
  { code: 'NIARI', nom: 'Niari', article: 'DU' },
  { code: 'NKENI_ALIMA', nom: 'Nkéni-Alima', article: 'DU' },
  { code: 'PLATEAUX', nom: 'Plateaux', article: 'DES' },
  { code: 'POINTE_NOIRE', nom: 'Pointe-Noire', article: 'DE' },
  { code: 'POOL', nom: 'Pool', article: 'DU' },
  { code: 'SANGHA', nom: 'Sangha', article: 'DE LA' },
];

/** Variantes d'écriture rencontrées dans les fichiers (clé compacte -> code). */
const ALIAS_DEPARTEMENTS: [RegExp, string][] = [
  [/^CUVETTEOUEST|^CUVOUEST/, 'CUVETTE_OUEST'],
  [/^CONGOOUB/, 'CONGO_OUBANGUI'],
  [/^(DJOUE|NKENILEFINI)/, 'DJOUE_LEFINI'],
  [/^NKENI/, 'NKENI_ALIMA'],
  [/^(CUVETTE|CUEVTTE|CUVVETTE|CUVET)/, 'CUVETTE'],
  [/^(BRAZZAVILLE|BRAEZZAVILLE|BZV|BRAZA)/, 'BRAZZAVILLE'],
  [/^(POINTENOIRE|PNOIRE|PNR)/, 'POINTE_NOIRE'],
  [/^(KOUILOU|KOUIOU|KOUILO|KUOILOU)/, 'KOUILOU'],
  [/^(LEKOUMOU|LEKOUMO)/, 'LEKOUMOU'],
  [/^LIKOUALA/, 'LIKOUALA'],
  [/^(NIARI|NIARIE)/, 'NIARI'],
  [/^PLATEAU/, 'PLATEAUX'],
  [/^POOL/, 'POOL'],
  [/^SANGHA/, 'SANGHA'],
  [/^BOUENZA/, 'BOUENZA'],
];

/** "IX. Plateaux", "Cuvette (Makoua)", "kouilou" -> code département, ou null. */
export function codeDepartement(brut: unknown): string | null {
  const s = sansPrefixeNumero(brut);
  if (!s) return null;
  const k = cleCompacte(s);
  for (const [re, code] of ALIAS_DEPARTEMENTS) if (re.test(k)) return code;
  // Faute de frappe (« Dloue-Lefini », « Kuoilou », « Brazzavile », « Pointa-Noire ») :
  // nom du département à deux lettres près, en tête du texte
  let meilleur: { code: string; d: number } | null = null;
  for (const dep of DEPARTEMENTS) {
    const nom = cleCompacte(dep.nom);
    if (nom.length < 4) continue;
    const d = distance(k.slice(0, nom.length), nom);
    if (d <= (nom.length >= 8 ? 2 : 1) && (!meilleur || d < meilleur.d))
      meilleur = { code: dep.code, d };
  }
  return meilleur?.code ?? null;
}

/** "DEPARTEMENT SCOLAIRE DE LA BOUENZA" */
export function titreDepartement(d: { nom: string; article: string }): string {
  return `DEPARTEMENT SCOLAIRE ${d.article} ${normaliser(d.nom)}`;
}

/* ------------------------------------------------------------------ */
/* Cycles et types de notes d'affectation                              */
/* ------------------------------------------------------------------ */

export const CYCLES = [
  'PRESCOLAIRE',
  'PRIMAIRE',
  'COLLEGE',
  'LYCEE',
  'ADMINISTRATION',
] as const;
export type Cycle = (typeof CYCLES)[number];

export const LIBELLE_CYCLE: Record<Cycle, string> = {
  PRESCOLAIRE: 'Préscolaire',
  PRIMAIRE: 'Primaire',
  COLLEGE: 'Collège',
  LYCEE: 'Lycée',
  ADMINISTRATION: 'Administration',
};

export function codeCycle(brut: unknown): Cycle | null {
  const k = cleCompacte(sansPrefixeNumero(brut));
  if (!k) return null;
  if (k.startsWith('PRESCO')) return 'PRESCOLAIRE';
  if (k.startsWith('PRIMAIRECOLL')) return 'COLLEGE';
  if (k.startsWith('PRIM')) return 'PRIMAIRE';
  if (k.startsWith('COLL')) return 'COLLEGE';
  if (k.startsWith('LYC')) return 'LYCEE';
  if (k.startsWith('ADMIN')) return 'ADMINISTRATION';
  return null;
}

export const TYPES_NOTE_AFFECTATION = [
  'PRESCOLAIRE',
  'PRIMAIRE',
  'DEMA',
  'ETS',
  'PERS_ADM',
  'DECRET_COLLEGE',
  'DECRET_LYCEE',
] as const;
export type TypeNoteAffectation = (typeof TYPES_NOTE_AFFECTATION)[number];

export interface DefinitionNoteAffectation {
  libelle: string;
  /** Texte d'introduction de la note (formulation des notes signées). */
  introduction: string;
  /** Tableau découpé par département scolaire. */
  parDepartement: boolean;
  /** Colonne après la référence du texte. */
  colonnes: ('CYCLE' | 'SPECIALITE' | 'ETABLISSEMENT' | 'OBS' | 'STRUCTURE')[];
  libelleRef: string;
  piedDePage: string;
  /** Direction générale destinataire dans les ampliations. */
  directionGenerale: string;
  fraisVoyage: boolean;
}

const INTRO_DEBUT =
  'nouvellement intégrés ou engagés dans la Fonction Publique et mis à la disposition du Ministère de l’Enseignement Préscolaire, Primaire, Secondaire et de l’Alphabétisation, reçoivent les affectations suivantes,';

export const NOTES_AFFECTATION: Record<
  TypeNoteAffectation,
  DefinitionNoteAffectation
> = {
  PRESCOLAIRE: {
    libelle: 'Préscolaire',
    introduction: `Les enseignantes du préscolaire dont les noms et prénoms suivent, nouvellement intégrées ou engagées dans la Fonction Publique et mises à la disposition du Ministère de l’Enseignement Préscolaire, Primaire, Secondaire et de l’Alphabétisation, reçoivent les affectations suivantes, en qualité d’enseignantes actives, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`,
    parDepartement: true,
    colonnes: ['CYCLE'],
    libelleRef: 'Réf. Arrêté',
    piedDePage: 'Affectation/Préscolaire/{annee}',
    directionGenerale: 'DGEB',
    fraisVoyage: false,
  },
  PRIMAIRE: {
    libelle: 'Primaire',
    introduction: `Les enseignants du primaire dont les noms et prénoms suivent, ${INTRO_DEBUT} en qualité d’enseignants actifs, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`,
    parDepartement: true,
    colonnes: ['CYCLE'],
    libelleRef: 'Réf. Arrêté',
    piedDePage: 'Affectation/Primaire/{annee}',
    directionGenerale: 'DGEB',
    fraisVoyage: false,
  },
  DEMA: {
    libelle: 'Collège (DEMA)',
    introduction: `Les enseignants du collège dont les noms et prénoms suivent, ${INTRO_DEBUT} en qualité d’enseignants actifs, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`,
    parDepartement: true,
    colonnes: ['SPECIALITE', 'CYCLE'],
    libelleRef: 'Réf. Arrêté',
    piedDePage: 'Affectation/Collège/DEMA/{annee}',
    directionGenerale: 'DGES',
    fraisVoyage: false,
  },
  ETS: {
    libelle: 'Enseignants actifs – Établissements',
    introduction: `Les enseignants dont les noms et prénoms suivent, ${INTRO_DEBUT} en qualité d’enseignants actifs, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`,
    parDepartement: true,
    colonnes: ['ETABLISSEMENT', 'OBS'],
    libelleRef: 'Réf. Arrêté',
    piedDePage: 'Affectation/Primaire-Ets/{annee}',
    directionGenerale: 'DGEB',
    fraisVoyage: false,
  },
  PERS_ADM: {
    libelle: 'Personnel administratif',
    introduction: `Les agents dont les noms et prénoms suivent, ${INTRO_DEBUT} en qualité de personnel administratif, au titre de l’année scolaire {annee}, conformément au tableau ci-après :`,
    parDepartement: false,
    colonnes: ['STRUCTURE'],
    libelleRef: 'Réf. Arrêté',
    piedDePage: 'Affectation/Administration/{annee}',
    directionGenerale: 'DGEB',
    fraisVoyage: false,
  },
  DECRET_COLLEGE: {
    libelle: 'Collège (Décrets)',
    introduction: `Les enseignants du collège dont les noms et prénoms suivent, ${INTRO_DEBUT} en qualité d’enseignants actifs, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`,
    parDepartement: true,
    colonnes: ['SPECIALITE', 'CYCLE'],
    libelleRef: 'Réf. Décret',
    piedDePage: 'Affectation/Collège/{annee}',
    directionGenerale: 'DGES',
    fraisVoyage: false,
  },
  DECRET_LYCEE: {
    libelle: 'Lycée (Décrets)',
    introduction: `Les enseignants du lycée dont les noms et prénoms suivent, ${INTRO_DEBUT} en qualité d’enseignants actifs, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`,
    parDepartement: true,
    colonnes: ['SPECIALITE', 'CYCLE'],
    libelleRef: 'Réf. Décret',
    piedDePage: 'Affectation/Lycée/{annee}',
    directionGenerale: 'DGES',
    fraisVoyage: false,
  },
};

/* ------------------------------------------------------------------ */
/* Règles diplôme -> cycle / note / grade / classification             */
/* ------------------------------------------------------------------ */

export interface RegleDiplomeRef {
  code: string;
  libelle: string;
  cycle: Cycle;
  typeNote: TypeNoteAffectation;
  /** Abréviation du grade dans la note (ex. "Inst"). Le suffixe ".C" s'ajoute pour les contractuels. */
  grade: string | null;
  gradeLibelle: string | null;
  categorie: string | null;
  echelle: number | null;
  echelon: number | null;
}

/** Grades de départ (modifiables ensuite dans l'écran « Règles et grades »). */
export const GRADES_DEFAUT: {
  code: string;
  abreviation: string;
  libelle: string;
  categorie: string;
  echelle: number;
  echelon: number;
  /** Indice au recrutement (salaire brut = indice × point indiciaire). */
  indice: number;
}[] = [
  // Tableau remis par le DG le 17/10/2026 (échelon 1 pour tous au recrutement)
  {
    code: 'INST',
    abreviation: 'Inst.',
    libelle: 'Instituteur',
    categorie: 'II',
    echelle: 1,
    echelon: 1,
    indice: 488,
  },
  {
    code: 'INST_A',
    abreviation: 'Inst.A.',
    libelle: 'Instituteur adjoint',
    categorie: 'II',
    echelle: 2,
    echelon: 1,
    indice: 464,
  },
  {
    code: 'PTACET',
    abreviation: 'PTACET',
    libelle: 'Professeur technique adjoint des CET',
    categorie: 'II',
    echelle: 1,
    echelon: 1,
    indice: 488,
  },
  {
    code: 'PCEG',
    abreviation: 'PCEG',
    libelle: 'Professeur des CEG',
    categorie: 'I',
    echelle: 2,
    echelon: 1,
    indice: 594,
  },
  {
    code: 'PCL',
    abreviation: 'PCL',
    libelle: 'Professeur des lycées',
    categorie: 'I',
    echelle: 1,
    echelon: 1,
    // Indice lu sur le décret d'engagement (professeur certifié des lycées, 1er échelon)
    indice: 730,
  },
  {
    code: 'COM_SAF',
    abreviation: 'Com. des SAF',
    libelle: 'Commis des services administratifs et financiers',
    categorie: 'III',
    echelle: 1,
    echelon: 1,
    indice: 350,
  },
  {
    code: 'CHAUFFEUR',
    abreviation: 'Chauffeur',
    libelle: 'Chauffeur',
    categorie: 'III',
    echelle: 3,
    echelon: 1,
    indice: 340,
  },
  {
    code: 'ECON',
    abreviation: 'Econ.',
    libelle: 'Économe',
    categorie: 'II',
    echelle: 1,
    echelon: 1,
    indice: 488,
  },
];

/** Diplômes de départ : code, libellé, cycle, note de service, grade. */
const DIPLOMES_DEFAUT: [string, string, Cycle, TypeNoteAffectation, string][] =
  [
    ['BEPC', 'BEPC', 'PRESCOLAIRE', 'PRESCOLAIRE', 'INST_A'],
    ['BET', 'BET', 'PRESCOLAIRE', 'PRESCOLAIRE', 'INST_A'],
    ['BTF', 'BTF', 'PRESCOLAIRE', 'PRESCOLAIRE', 'INST_A'],
    ['CFEEN_PRESCO', 'CFEEN préscolaire', 'PRESCOLAIRE', 'PRESCOLAIRE', 'INST'],
    ['BEP', 'BEP', 'PRIMAIRE', 'PRIMAIRE', 'INST'],
    ['CAPT', 'CAPT', 'PRIMAIRE', 'PRIMAIRE', 'INST'],
    ['BAC', 'BAC', 'PRIMAIRE', 'PRIMAIRE', 'INST'],
    ['CFEEN', 'CFEEN primaire', 'PRIMAIRE', 'PRIMAIRE', 'INST'],
    ['DECS', 'DECS (carrière de santé)', 'PRIMAIRE', 'PRIMAIRE', 'INST'],
    ['DIPLOME_ETAT', "Diplôme d'État", 'PRIMAIRE', 'PRIMAIRE', 'INST'],
    ['DEMA', 'DEMA', 'COLLEGE', 'DEMA', 'PTACET'],
    ['BTS', 'BTS', 'COLLEGE', 'DECRET_COLLEGE', 'PCEG'],
    ['DUT', 'DUT', 'COLLEGE', 'DECRET_COLLEGE', 'PCEG'],
    ['DEUG', 'DEUG', 'COLLEGE', 'DECRET_COLLEGE', 'PCEG'],
    ['LICENCE', 'Licence', 'COLLEGE', 'DECRET_COLLEGE', 'PCEG'],
    ['CAPCEG', 'CAPCEG', 'COLLEGE', 'DECRET_COLLEGE', 'PCEG'],
    ['MASTER', 'Master', 'LYCEE', 'DECRET_LYCEE', 'PCL'],
    ['MAITRISE', 'Maîtrise', 'LYCEE', 'DECRET_LYCEE', 'PCL'],
    ['CAPES', 'CAPES', 'LYCEE', 'DECRET_LYCEE', 'PCL'],
    ['CEPE', 'CEPE', 'ADMINISTRATION', 'PERS_ADM', 'COM_SAF'],
    ['PERMIS', 'Permis de conduire', 'ADMINISTRATION', 'PERS_ADM', 'CHAUFFEUR'],
    ['DCAF', 'DCAF', 'ADMINISTRATION', 'PERS_ADM', 'ECON'],
  ];

/** Grade de départ de chaque diplôme. */
export const GRADE_DU_DIPLOME_DEFAUT: Record<string, string> =
  Object.fromEntries(DIPLOMES_DEFAUT.map(([code, , , , g]) => [code, g]));

/**
 * Règles de départ (vérifiées sur les notes du lot 3, puis corrigées par le DG
 * le 17/10/2026). Elles sont enregistrées en base et modifiables ensuite.
 */
export const REGLES_DIPLOMES: RegleDiplomeRef[] = DIPLOMES_DEFAUT.map(
  ([code, libelle, cycle, typeNote, gradeCode]) => {
    const g = GRADES_DEFAUT.find((x) => x.code === gradeCode)!;
    return {
      code,
      libelle,
      cycle,
      typeNote,
      grade: g.abreviation,
      gradeLibelle: g.libelle,
      categorie: g.categorie,
      echelle: g.echelle,
      echelon: g.echelon,
    };
  },
);

/**
 * Façons dont chaque diplôme est écrit dans les fichiers Excel.
 * Une écriture reconnaît aussi tout ce qui COMMENCE par elle
 * (« BAC » reconnaît « BAC A4 », « BAC G2 »…) ; la plus longue l'emporte.
 */
export const ECRITURES_DEFAUT: Record<string, string[]> = {
  BEPC: ['BEPC'],
  BET: ['BET', 'BET-Préscolaire'],
  BTF: ['BTF'],
  CFEEN_PRESCO: ['CFEEN-Préscolaire', 'CFEEN Préscolaire', 'CFEEN Presco'],
  BEP: ['BEP'],
  CAPT: ['CAPT'],
  BAC: ['BAC'],
  CFEEN: ['CFEEN', 'CFEN', 'CFEEN Primaire'],
  DECS: ['DECS', 'DCAS'],
  DIPLOME_ETAT: ["Dip. d'État", "Diplôme d'État"],
  DEMA: ['DEMA'],
  BTS: ['BTS'],
  DUT: ['DUT'],
  DEUG: ['DEUG'],
  LICENCE: ['Licence'],
  CAPCEG: ['CAPCEG'],
  MASTER: ['Master'],
  MAITRISE: ['Maîtrise'],
  CAPES: ['CAPES'],
  CEPE: ['CEPE', 'CEP'],
  PERMIS: ['Permis'],
  DCAF: ['DCAF'],
};

/** Libellé brut du diplôme -> code de la règle, d'après les écritures connues. */
export function reconnaitreDiplome(
  brut: unknown,
  regles: { code: string; ecritures: string[] }[],
): string | null {
  const k = cleCompacte(brut);
  if (!k) return null;
  let meilleur: { code: string; longueur: number } | null = null;
  for (const r of regles)
    for (const e of r.ecritures) {
      const ce = cleCompacte(e);
      if (
        ce &&
        k.startsWith(ce) &&
        (!meilleur || ce.length > meilleur.longueur)
      )
        meilleur = { code: r.code, longueur: ce.length };
    }
  return meilleur?.code ?? null;
}

/** Reconnaissance avec les règles de départ (utilisée par les tests). */
export function codeDiplome(brut: unknown): string | null {
  return reconnaitreDiplome(
    brut,
    Object.entries(ECRITURES_DEFAUT).map(([code, ecritures]) => ({
      code,
      ecritures,
    })),
  );
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export const MOTIFS_MUTATION = [
  'RAPPROCHEMENT_CONJOINT',
  'RAISONS_SOCIALES',
  'RAISONS_SANTE',
  'PERMUTATION',
  'ANCIENNETE',
] as const;
export type MotifMutation = (typeof MOTIFS_MUTATION)[number];

export interface DefinitionMotif {
  libelle: string;
  /** Formule insérée dans l'introduction : « sont mutés {formule} ». */
  formule: string;
  piedDePage: string;
  justificatif: string;
}

export const MOTIFS: Record<MotifMutation, DefinitionMotif> = {
  RAPPROCHEMENT_CONJOINT: {
    libelle: 'Rapprochement de conjoints',
    formule: 'dans le cadre du rapprochement de conjoints',
    piedDePage: 'Note de mutation pour rapprochement de conjoints',
    justificatif: 'Acte de mariage',
  },
  RAISONS_SOCIALES: {
    libelle: 'Raisons sociales',
    formule: 'pour des raisons sociales',
    piedDePage: 'Note de mutation pour raisons sociales',
    justificatif: 'Justificatif social',
  },
  RAISONS_SANTE: {
    libelle: 'Raisons de santé',
    formule: 'pour des raisons de santé',
    piedDePage: 'Note de mutation pour raisons de santé',
    justificatif: 'Certificat médical',
  },
  PERMUTATION: {
    libelle: 'Permutation',
    formule: 'dans le cadre des permutations',
    piedDePage: 'Note de permutation',
    justificatif: 'Accord des deux agents',
  },
  ANCIENNETE: {
    libelle: 'Ancienneté',
    formule: "pour des raisons d'ancienneté",
    piedDePage: 'Note de mutation pour ancienneté',
    justificatif: 'Note de prise de service',
  },
};

export function codeMotif(brut: unknown): MotifMutation | null {
  const k = cleCompacte(sansPrefixeNumero(brut));
  if (k.startsWith('RAPPROCHEMENT')) return 'RAPPROCHEMENT_CONJOINT';
  if (k.startsWith('RAISONSOC') || k.startsWith('RAISONSSOC'))
    return 'RAISONS_SOCIALES';
  if (
    k.startsWith('RAISONSDESANTE') ||
    k.startsWith('RAISONDESANTE') ||
    k.startsWith('SANTE')
  )
    return 'RAISONS_SANTE';
  if (k.startsWith('PERMUT')) return 'PERMUTATION';
  if (k.startsWith('ANCIEN')) return 'ANCIENNETE';
  return null;
}

/** Groupes de notes de mutation (une note par motif et par groupe). */
export const GROUPES_MUTATION = [
  'PRESCO_PRIMAIRE',
  'COLLEGE_LYCEE_ADMIN',
] as const;
export type GroupeMutation = (typeof GROUPES_MUTATION)[number];

export const LIBELLE_GROUPE: Record<GroupeMutation, string> = {
  PRESCO_PRIMAIRE: 'Préscolaire et primaire',
  COLLEGE_LYCEE_ADMIN: 'Collège, lycée et administration',
};

export function groupeDuCycle(c: Cycle | null): GroupeMutation {
  return c === 'PRESCOLAIRE' || c === 'PRIMAIRE'
    ? 'PRESCO_PRIMAIRE'
    : 'COLLEGE_LYCEE_ADMIN';
}

/** Seuil légal pour une mutation pour ancienneté (en années). */
export const SEUIL_ANCIENNETE_ANS = 5;

/** Spécialités de la fiche statistique des mutations. */
export const SPECIALITES_STAT: Record<'COLLEGE' | 'LYCEE', string[]> = {
  COLLEGE: [
    'FRANCAIS',
    'ANGLAIS',
    'HISTOIRE-GEO',
    'MATHS',
    'PHYS-CHIMIE',
    'SVT',
    'DESSIN',
    'MUSIQUE',
    'EPS',
  ],
  LYCEE: [
    'FRANCAIS',
    'ANGLAIS',
    'HISTOIRE-GEO',
    'MATHS',
    'PHYS-CHIMIE',
    'SVT',
    'PHILO',
    'ESPAGNOL',
    'RUSSE',
    'CHINOIS',
    'ALLEMAND',
    'LATIN',
    'EPS',
  ],
};

export function specialiteStat(brut: unknown): string {
  const k = cleCompacte(brut);
  if (k.startsWith('FRAN')) return 'FRANCAIS';
  if (k.startsWith('ANGL')) return 'ANGLAIS';
  if (k === 'HG' || k.startsWith('HIST')) return 'HISTOIRE-GEO';
  if (k.startsWith('MATH')) return 'MATHS';
  if (k === 'PC' || k.startsWith('PHYS')) return 'PHYS-CHIMIE';
  if (k === 'SVT') return 'SVT';
  if (k.startsWith('ART') || k.startsWith('DESSIN')) return 'DESSIN';
  if (k.startsWith('MUSIQ')) return 'MUSIQUE';
  if (k === 'EPS') return 'EPS';
  if (k.startsWith('PHILO')) return 'PHILO';
  if (k.startsWith('ESPAG')) return 'ESPAGNOL';
  if (k.startsWith('RUSS')) return 'RUSSE';
  if (k.startsWith('CHIN')) return 'CHINOIS';
  if (k.startsWith('ALLEM')) return 'ALLEMAND';
  if (k.startsWith('LATIN')) return 'LATIN';
  return 'AUTRES';
}

/* ------------------------------------------------------------------ */
/* Grades des mutations : "Inst1", "Inst A 1", "PCL9", "Commis des SAF1" */
/* ------------------------------------------------------------------ */

const GRADES_CONNUS: Record<string, string> = {
  INST: 'Inst',
  INSTA: 'Inst.A',
  INSTC: 'Inst.C',
  INSTAC: 'Inst.A.C',
  INSTCA: 'Inst.A.C',
  NST: 'Inst',
  PCL: 'PCL',
  PCLC: 'PCL.C',
  PL: 'PL',
  PCEG: 'PCEG',
  PCEGC: 'PCEG.C',
  PCES: 'PCES',
  PTA: 'PTA',
  PTAC: 'PTA.C',
  PTACET: 'PTACET',
  PTACETC: 'PTACET.C',
  SPA: 'SPA',
  SA: 'SA',
  SAC: 'SA.C',
  ECO: 'Econ',
  ECON: 'Econ',
  ECONC: 'Econ.C',
  COMMIS: 'Commis',
  COMMISDESSAF: 'Com. des SAF',
  COMDESSAF: 'Com. des SAF',
  CHAUFFEUR: 'Chauffeur',
};

/** Sépare le grade et l'échelon d'un libellé libre. */
export function lireGradeEchelon(brut: unknown): {
  grade: string | null;
  echelon: number | null;
} {
  const s = normaliser(brut).replace(/^1NST/, 'INST');
  if (!s) return { grade: null, echelon: null };
  const m = s.match(/^(.*?)[\s.,]*(\d{1,2})$/);
  const base = m ? m[1] : s;
  const echelon = m ? Number(m[2]) : null;
  const k = base.replace(/[^A-Z]/g, '').replace(/I$/, '');
  const grade =
    GRADES_CONNUS[k] ??
    GRADES_CONNUS[base.replace(/[^A-Z]/g, '')] ??
    (base.trim() || null);
  return { grade, echelon };
}
