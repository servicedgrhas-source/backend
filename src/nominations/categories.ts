import { enTexte, normaliser } from '../common/texte';

/**
 * Nominations des cadres de gestion des établissements et des inspections (réunion DGRHAS du
 * 26/10/2026, modèles « Notes de service nominations 2026-2027 »). Chaque catégorie donne une note
 * de service : « Les cadres de l’enseignement dont les noms et prénoms suivent sont nommés
 * {formule}, au titre de l’année scolaire …, conformément aux tableaux ci-après : ».
 */

/** Colonnes de la note : établissements (G/E), inspections (grade, cat., échelle, échelon)… */
export type Gabarit =
  'ETAB' | 'ETAB_VAGUE' | 'INSP' | 'INSP_SPEC' | 'CP' | 'ITIN';

export interface CategorieNomination {
  code: string;
  /** Fonction, au singulier (« Directeur de CEG »). */
  libelle: string;
  /** Groupe affiché dans les listes. */
  groupe:
    | 'Préscolaire'
    | 'Primaire'
    | 'Collège'
    | 'Lycée'
    | 'Alphabétisation'
    | 'Inspections'
    | 'Inspecteurs itinérants'
    | 'Directions départementales';
  cycle:
    | 'PRESCOLAIRE'
    | 'PRIMAIRE'
    | 'COLLEGE'
    | 'LYCEE'
    | 'ALPHABETISATION'
    | 'ADMINISTRATION';
  /** « Directeurs des collèges d’enseignement général » : la fin de la phrase d'introduction. */
  formule: string;
  gabarit: Gabarit;
  /** Direction générale en ampliation (DGES-DC, DGEB, DGAENF-DC). */
  directionGenerale: string;
  /** Rang dans la hiérarchie de l'établissement (surveillant → directeur des études → chef). */
  rang: number;
}

const C = (
  code: string,
  libelle: string,
  groupe: CategorieNomination['groupe'],
  cycle: CategorieNomination['cycle'],
  formule: string,
  gabarit: Gabarit,
  directionGenerale: string,
  rang = 0,
): CategorieNomination => ({
  code,
  libelle,
  groupe,
  cycle,
  formule,
  gabarit,
  directionGenerale,
  rang,
});

export const CATEGORIES_NOMINATION: CategorieNomination[] = [
  // Établissements
  C(
    'PRESCO_DIRECTEUR',
    'Directeur (directrice) de centre d’éducation préscolaire',
    'Préscolaire',
    'PRESCOLAIRE',
    'Directeurs/Directrices des Centres d’Education Préscolaire',
    'ETAB',
    'DGEB',
    3,
  ),
  C(
    'PRESCO_ECONOME',
    'Économe de centre d’éducation préscolaire',
    'Préscolaire',
    'PRESCOLAIRE',
    'Economes des Centres d’Education Préscolaire',
    'ETAB',
    'DGEB',
    1,
  ),
  C(
    'PRIMAIRE_DIRECTEUR',
    'Directeur d’école primaire',
    'Primaire',
    'PRIMAIRE',
    'Directeurs d’Ecole Primaire',
    'ETAB',
    'DGEB',
    3,
  ),
  C(
    'PRIMAIRE_ECONOME',
    'Économe d’école primaire',
    'Primaire',
    'PRIMAIRE',
    'Economes d’école primaire',
    'ETAB',
    'DGEB',
    1,
  ),
  C(
    'COLLEGE_DIRECTEUR',
    'Directeur de CEG',
    'Collège',
    'COLLEGE',
    'Directeurs des collèges d’enseignement général',
    'ETAB',
    'DGES-DC',
    3,
  ),
  C(
    'COLLEGE_DE',
    'Directeur des études de CEG',
    'Collège',
    'COLLEGE',
    'Directeurs des études des collèges d’enseignement général',
    'ETAB_VAGUE',
    'DGES-DC',
    2,
  ),
  C(
    'COLLEGE_SG',
    'Surveillant général de CEG',
    'Collège',
    'COLLEGE',
    'Surveillants généraux des collèges d’enseignement général',
    'ETAB_VAGUE',
    'DGES-DC',
    1,
  ),
  C(
    'COLLEGE_ECONOME',
    'Économe de CEG',
    'Collège',
    'COLLEGE',
    'Economes des collèges d’enseignement général',
    'ETAB',
    'DGES-DC',
    1,
  ),
  C(
    'LYCEE_PROVISEUR',
    'Proviseur de lycée',
    'Lycée',
    'LYCEE',
    'Proviseurs des Lycées d’Enseignement Général',
    'ETAB',
    'DGES-DC',
    3,
  ),
  C(
    'LYCEE_DE',
    'Directeur des études de lycée',
    'Lycée',
    'LYCEE',
    'Directeurs des Etudes des Lycées d’Enseignement Général',
    'ETAB_VAGUE',
    'DGES-DC',
    2,
  ),
  C(
    'LYCEE_SG',
    'Surveillant général de lycée',
    'Lycée',
    'LYCEE',
    'Surveillants Généraux des Lycées d’Enseignement Général',
    'ETAB_VAGUE',
    'DGES-DC',
    1,
  ),
  C(
    'LYCEE_INTENDANT',
    'Intendant de lycée',
    'Lycée',
    'LYCEE',
    'Intendants des Lycées d’Enseignement Général',
    'ETAB',
    'DGES-DC',
    1,
  ),
  C(
    'ALPHA_DIRECTEUR',
    'Directeur de centre d’alphabétisation et de rescolarisation',
    'Alphabétisation',
    'ALPHABETISATION',
    'Directeurs des Centres d’Alphabétisation et de Rescolarisation',
    'ETAB',
    'DGAENF-DC',
    3,
  ),
  C(
    'ALPHA_CTAR',
    'Conseiller technique d’alphabétisation et de rescolarisation',
    'Alphabétisation',
    'ALPHABETISATION',
    'Conseillers Techniques d’Alphabétisation et de Rescolarisation',
    'ETAB',
    'DGAENF-DC',
  ),
  C(
    'ALPHA_CDAR',
    'Coordonnateur départemental d’alphabétisation et de rescolarisation',
    'Alphabétisation',
    'ALPHABETISATION',
    'Coordonnateurs départementaux d’alphabétisation et de rescolarisation',
    'ETAB',
    'DGAENF-DC',
  ),
  // Inspections départementales
  C(
    'PRESCO_ICCS',
    'Inspecteur chef de circonscription du préscolaire',
    'Inspections',
    'PRESCOLAIRE',
    'Inspecteurs Chefs de Circonscription Préscolaire',
    'INSP',
    'DGEB',
  ),
  C(
    'PRESCO_ICAP',
    'Inspecteur chargé des activités pédagogiques (ICAP) du préscolaire',
    'Inspections',
    'PRESCOLAIRE',
    'Inspecteurs Chargés des Activités Pédagogiques (ICAP) du Préscolaire',
    'INSP',
    'DGEB',
  ),
  C(
    'PRESCO_CP',
    'Conseiller pédagogique du préscolaire',
    'Inspections',
    'PRESCOLAIRE',
    'Conseillers Pédagogiques du Préscolaire',
    'INSP',
    'DGEB',
  ),
  C(
    'PRESCO_ECONOME_INSP',
    'Économe d’inspection du préscolaire',
    'Inspections',
    'PRESCOLAIRE',
    'Economes des Inspections du Préscolaire',
    'INSP',
    'DGEB',
  ),
  C(
    'PRIMAIRE_ICCS',
    'Inspecteur chef de circonscription scolaire (ICCS) du primaire',
    'Inspections',
    'PRIMAIRE',
    'Inspecteurs chefs de circonscription scolaire (ICCS) du Primaire',
    'INSP',
    'DGEB',
  ),
  C(
    'PRIMAIRE_ICAP',
    'Inspecteur chargé des activités pédagogiques (ICAP) du primaire',
    'Inspections',
    'PRIMAIRE',
    'Inspecteurs chargés des activités pédagogiques (ICAP) du Primaire',
    'INSP',
    'DGEB',
  ),
  C(
    'PRIMAIRE_CP',
    'Conseiller pédagogique du primaire',
    'Inspections',
    'PRIMAIRE',
    'Conseillers pédagogiques du Primaire',
    'CP',
    'DGEB',
  ),
  C(
    'PRIMAIRE_ECONOME_INSP',
    'Économe d’inspection du primaire',
    'Inspections',
    'PRIMAIRE',
    'Economes des inspections de l’enseignement primaire',
    'INSP',
    'DGEB',
  ),
  C(
    'COLLEGE_ICOORD',
    'Inspecteur coordonnateur des CEG',
    'Inspections',
    'COLLEGE',
    'Inspecteurs coordonnateurs des collèges d’enseignement général',
    'INSP',
    'DGES-DC',
  ),
  C(
    'COLLEGE_ICAP',
    'Inspecteur chargé des activités pédagogiques (ICAP) des CEG',
    'Inspections',
    'COLLEGE',
    'Inspecteurs chargés des activités pédagogiques (ICAP) des collèges d’enseignement général',
    'INSP_SPEC',
    'DGES-DC',
  ),
  C(
    'COLLEGE_IDCAP',
    'Inspecteur délégué chargé des activités pédagogiques (IDCAP) des CEG',
    'Inspections',
    'COLLEGE',
    'Inspecteurs délégués chargés des activités pédagogiques (IDCAP) des collèges d’enseignement général',
    'INSP_SPEC',
    'DGES-DC',
  ),
  C(
    'COLLEGE_ECONOME_INSP',
    'Économe d’inspection des CEG',
    'Inspections',
    'COLLEGE',
    'Economes des inspections des collèges d’enseignement général',
    'INSP',
    'DGES-DC',
  ),
  C(
    'LYCEE_ICOORD',
    'Inspecteur coordonnateur des lycées',
    'Inspections',
    'LYCEE',
    'Inspecteurs coordonnateurs des lycées d’enseignement général',
    'INSP_SPEC',
    'DGES-DC',
  ),
  C(
    'LYCEE_IDELEGUE',
    'Inspecteur délégué des lycées',
    'Inspections',
    'LYCEE',
    'Inspecteurs délégués des lycées d’enseignement général',
    'INSP_SPEC',
    'DGES-DC',
  ),
  C(
    'LYCEE_ECONOME_INSP',
    'Économe d’inspection des lycées',
    'Inspections',
    'LYCEE',
    'Economes des inspections des lycées d’enseignement général',
    'INSP',
    'DGES-DC',
  ),
  // Inspecteurs itinérants (rattachés aux structures centrales)
  C(
    'ITIN_INRAP',
    'Inspecteur itinérant à l’INRAP',
    'Inspecteurs itinérants',
    'ADMINISTRATION',
    'Inspecteurs Itinérants à l’Institut National de Recherche et d’Action Pédagogiques (INRAP)',
    'ITIN',
    'DGES-DC',
  ),
  C(
    'ITIN_IAFP',
    'Inspecteur itinérant à l’IAFP',
    'Inspecteurs itinérants',
    'ADMINISTRATION',
    'Inspecteurs Itinérants à l’Inspection administrative, financière et du patrimoine (IAFP)',
    'ITIN',
    'DGES-DC',
  ),
  C(
    'ITIN_IPA',
    'Inspecteur itinérant à l’IPA',
    'Inspecteurs itinérants',
    'ADMINISTRATION',
    'Inspecteurs itinérants à l’Inspection pédagogique et andragogique (IPA)',
    'ITIN',
    'DGES-DC',
  ),
  C(
    'ITIN_DFC',
    'Inspecteur itinérant à la DFC',
    'Inspecteurs itinérants',
    'ADMINISTRATION',
    'Inspecteurs Itinérants à la Direction de la Formation Continue (DFC)',
    'ITIN',
    'DGES-DC',
  ),
  // Directions départementales
  C(
    'DDEPPSA_CHEF_SERVICE',
    'Chef de service de direction départementale',
    'Directions départementales',
    'ADMINISTRATION',
    'Chefs de service des Directions Départementales de l’Enseignement Préscolaire, Primaire, Secondaire et de l’Alphabétisation',
    'ETAB',
    'DGES-DC',
    3,
  ),
];

export const CATEGORIE = new Map(CATEGORIES_NOMINATION.map((c) => [c.code, c]));

/**
 * Catégorie d'après le cycle et la fonction écrits dans les bases (« 4-Collège » + « 2-D.E. »,
 * « 5-Lycée » + « Inspecteur Délg », « 2-Primaire » + « C.P. Primaire »…) ; null si inconnue.
 */
export function categorieDe(
  cycleBrut: unknown,
  fonctionBrut: unknown,
): string | null {
  const c = normaliser(cycleBrut);
  const f = normaliser(fonctionBrut).replace(/^[0-9I]+\s*[-.]\s*/, '');
  const cycle = /PRESCO/.test(c)
    ? 'PRESCO'
    : /PRIMAIRE/.test(c)
      ? 'PRIMAIRE'
      : /COLL/.test(c)
        ? 'COLLEGE'
        : /LYC/.test(c)
          ? 'LYCEE'
          : /ALPHA/.test(c)
            ? 'ALPHA'
            : /ADMIN|DDEPPSA/.test(c)
              ? 'ADMIN'
              : null;
  if (/INRAP/.test(f)) return 'ITIN_INRAP';
  if (/IAFP/.test(f)) return 'ITIN_IAFP';
  if (/\bIPA\b/.test(f)) return 'ITIN_IPA';
  if (/\bDFC\b/.test(f)) return 'ITIN_DFC';
  if (cycle === 'ADMIN' || /^C\.?\s?S\b|^CS\b|^S\.P\.A\.A|^SAENF/.test(f))
    return 'DDEPPSA_CHEF_SERVICE';
  const econome = /ECONOM/.test(f);
  const econInsp = econome && /INSP/.test(f);
  const cp =
    /^C\.?\s?P\b|CONSEILLER\.?\s?P|CONSEILLER PED|^CP\b|CPCEP|^CONSEILLERE?$/.test(
      f,
    );
  if (cycle === 'ALPHA') {
    if (/CDAR/.test(f)) return 'ALPHA_CDAR';
    if (/CTAR|CTAEF|TECH|^CLLER/.test(f)) return 'ALPHA_CTAR';
    if (econome || /DIRECT|RESCO/.test(f)) return 'ALPHA_DIRECTEUR';
    return null;
  }
  if (cycle === 'PRESCO') {
    if (econInsp) return 'PRESCO_ECONOME_INSP';
    if (econome) return 'PRESCO_ECONOME';
    if (cp) return 'PRESCO_CP';
    if (/ICAP/.test(f)) return 'PRESCO_ICAP';
    if (/ICC|ICEP|INSPECT|^I\.?\s?P\b/.test(f)) return 'PRESCO_ICCS';
    if (/DIRECT/.test(f)) return 'PRESCO_DIRECTEUR';
    return null;
  }
  if (cycle === 'PRIMAIRE') {
    if (econInsp) return 'PRIMAIRE_ECONOME_INSP';
    if (econome) return 'PRIMAIRE_ECONOME';
    if (cp) return 'PRIMAIRE_CP';
    if (/ICAP/.test(f)) return 'PRIMAIRE_ICAP';
    if (/ICCS|ICSS|INSPECT/.test(f)) return 'PRIMAIRE_ICCS';
    if (/DIRECT/.test(f)) return 'PRIMAIRE_DIRECTEUR';
    return null;
  }
  if (cycle === 'COLLEGE') {
    if (econInsp) return 'COLLEGE_ECONOME_INSP';
    if (econome) return 'COLLEGE_ECONOME';
    if (/IDCAP|IDCEG|DELEGU/.test(f)) return 'COLLEGE_IDCAP';
    if (/ICAP/.test(f)) return 'COLLEGE_ICAP';
    if (/COORD|ICEG/.test(f)) return 'COLLEGE_ICOORD';
    if (/SURG|SURVEILL/.test(f)) return 'COLLEGE_SG';
    if (/^D\.?\s?E\b|ETUDES/.test(f)) return 'COLLEGE_DE';
    if (/DIRECT/.test(f)) return 'COLLEGE_DIRECTEUR';
    return null;
  }
  if (cycle === 'LYCEE') {
    if (econInsp) return 'LYCEE_ECONOME_INSP';
    if (/INTENDANT/.test(f) || econome) return 'LYCEE_INTENDANT';
    if (/COORD/.test(f)) return 'LYCEE_ICOORD';
    if (/ICAP|IDCAP|DELEG|DELG|IDLZ|ILZ|INSPECT/.test(f))
      return 'LYCEE_IDELEGUE';
    if (/SURG|SURVEILL/.test(f)) return 'LYCEE_SG';
    if (/^D\.?\s?E\b|ETUDES/.test(f)) return 'LYCEE_DE';
    if (/PROVISEUR|DIRECT/.test(f)) return 'LYCEE_PROVISEUR';
    return null;
  }
  return null;
}

/** Ce que l'on fait de la personne (DGRHAS, 26/10/2026) ; « Relevé » ne paraît pas dans la note. */
export const OBSERVATIONS = {
  RECONDUIT: {
    libelle: 'Reconduit',
    feminin: 'Reconduite',
    proposer: 'À reconduire',
  },
  PROMU: { libelle: 'Promu', feminin: 'Promue', proposer: 'À promouvoir' },
  MUTE: { libelle: 'Muté', feminin: 'Mutée', proposer: 'À muter' },
  PERMUTE: { libelle: 'Permuté', feminin: 'Permutée', proposer: 'À permuter' },
  RELEVE: { libelle: 'Relevé', feminin: 'Relevée', proposer: 'À relever' },
} as const;
export type Observation = keyof typeof OBSERVATIONS;

/** « Reconduite », « A Promouvoir », « muté » → code ; « à pourvoir » : null (poste vacant). */
export function observationDe(
  brut: unknown,
): { obs: Observation; proposee: boolean } | null {
  const t = normaliser(brut);
  if (!t || /POURVOIR/.test(t)) return null;
  const proposee = /^A\s/.test(t);
  if (/RECONDU/.test(t)) return { obs: 'RECONDUIT', proposee };
  if (/PROMU|PROMOUV/.test(t)) return { obs: 'PROMU', proposee };
  if (/PERMUT/.test(t)) return { obs: 'PERMUTE', proposee };
  if (/MUTE|MUTER/.test(t)) return { obs: 'MUTE', proposee };
  if (/RELEV|RETIR|RADI|SUPPRIM/.test(t)) return { obs: 'RELEVE', proposee };
  if (/REGULARIS/.test(t)) return { obs: 'RECONDUIT', proposee };
  return null;
}

/** « Inst.5 », « PCEG. 4e », « PCL 1 » → grade et échelon. */
export function gradeEchelon(brut: unknown): {
  grade: string | null;
  echelon: string | null;
} {
  const t = enTexte(brut).replace(/\s+/g, ' ').trim();
  if (!t) return { grade: null, echelon: null };
  const m = /^(.*?)[\s.]*(\d{1,2})\s*(?:e|er|ème)?$/i.exec(t);
  return m
    ? { grade: m[1].replace(/[.\s]+$/, '') || null, echelon: m[2] }
    : { grade: t, echelon: null };
}

/* ------------------------------ Écritures de la base des nominations (DGRHAS, 29/10/2026) ------------------------------ */

/**
 * Grade abrégé, comme dans la base des nominations et les notes (« Inst. 1 », « Inst. C. 1 »,
 * « PCEG 3 », « PCL 4 ») : réunion du 29/10/2026, « il faut que ça apparaisse en abrégé, sinon
 * c'est trop long ». Un contractuel dont la fiche ne dit que « Contractuel catég. C échelle 8 »
 * prend sa qualification (« Instituteur » → « Inst. C. »). Un grade déjà abrégé reste tel quel.
 */
export function gradeAbrege(
  grade: string | null | undefined,
  o: { statut?: string | null; qualification?: string | null } = {},
): string | null {
  const brut = enTexte(grade).replace(/\s+/g, ' ').trim();
  const contractuel =
    o.statut === 'CONTRACTUEL' || /CONTRACTUEL|\bCATEG/.test(normaliser(brut));
  // « Contractuel catég. C échelle 8 » : la qualification de la fiche dit le métier
  const metier = /CONTRACTUEL|\bCATEG/.test(normaliser(brut))
    ? enTexte(o.qualification)
    : brut;
  const t = normaliser(metier).replace(/[’']/g, ' ');
  if (!t) return brut ? (contractuel ? 'Contr.' : brut) : null;
  const ABREGES: [RegExp, string][] = [
    [/INSTITUTEUR ADJOINT|^INST\.? ?A\b/, 'Inst. A.'],
    [/INSTITUTEUR PRINCIPAL|^INST\.? ?P\b/, 'Inst. P.'],
    [/INSTITUTEUR|^INST\b/, 'Inst.'],
    [/PROFESSEUR TECHNIQUE ADJOINT|^PTA\b/, 'PTA'],
    [/PROFESSEUR TECHNIQUE|^PT\b/, 'PT'],
    [/PROFESSEUR (ADJOINT|ADJ) D ?E\.?P\.?S/, 'PA EPS'],
    [/PROF(ESSEUR)? CERTIFIE D ?E\.?P\.?S/, 'PC EPS'],
    [/MAITRE D ?E\.?P\.?S|^MEPS\b/, 'MEPS'],
    [/PROFESSEUR (CERTIFIE )?(DE |DES )?LYCEE|^PCL\b/, 'PCL'],
    [/PROFESSEUR (DE |DES )?C\.?E\.?G|^PCEG\b/, 'PCEG'],
    [/INSPECTEUR/, 'Insp.'],
    [/ECONOME|^ECON\b/, 'Econ.'],
    [/ATTACHE/, 'Att.'],
    [/SECRETAIRE PRINCIPAL/, 'SP'],
    [/SECRETAIRE/, 'Secr.'],
    [/CONSEILLER PEDAGOGIQUE/, 'CP'],
  ];
  // Déjà abrégé (« Inst. C. », « PCL ») : on garde l'écriture de la base
  const deja =
    /^[A-Z][A-Za-z]{0,5}\.?( [A-Z]\.)*$|^(PCL|PCEG|PTA|PCS|PL|MEPS)\b/.test(
      metier.trim(),
    );
  let a =
    (deja ? metier.trim() : ABREGES.find(([r]) => r.test(t))?.[1]) ??
    (metier.length <= 12 ? metier.trim() : metier.trim().slice(0, 12));
  if (contractuel && !/\bC\.$|\bC\.\s|Contr/.test(a))
    a = `${a.replace(/\.$/, '.')} C.`.replace(/\s+/g, ' ');
  return a;
}

/** Échelon comme dans la base : « 1 », « 4 », « HC 2 » (sans « er » ni « e »). */
export const echelonBase = (e: string | null | undefined) => {
  const t = enTexte(e).trim();
  const n = /^(\d{1,2})\s*(?:er|e|ème|eme)?$/i.exec(t);
  return n ? n[1] : t || null;
};

/** Le cycle comme dans la base (« 2-Primaire », « 4-Collège ») ; administration : « Administration ». */
export const cycleBase = (c: CategorieNomination | undefined) =>
  !c
    ? ''
    : {
        PRESCOLAIRE: '1-Préscolaire',
        PRIMAIRE: '2-Primaire',
        ALPHABETISATION: '3-Alphab.',
        COLLEGE: '4-Collège',
        LYCEE: '5-Lycée',
        ADMINISTRATION: 'Administration',
      }[c.cycle];

/** La fonction comme dans la base (« 1-Directeur », « 1-Directrice », « 2-D.E. », « 3-SURGE », « 4-Econome »). */
export function fonctionBase(
  c: CategorieNomination | undefined,
  genre?: string | null,
) {
  if (!c) return '';
  const k = c.code;
  const f = genre === 'F';
  if (/_ECONOME_INSP$/.test(k)) return '4-Econome Insp';
  if (/_ECONOME$/.test(k)) return '4-Econome';
  if (k === 'LYCEE_INTENDANT') return '4-Intendant Lycée';
  if (k === 'LYCEE_PROVISEUR') return '1-Proviseur';
  if (/_DIRECTEUR$/.test(k)) return f ? '1-Directrice' : '1-Directeur';
  if (/_DE$/.test(k)) return '2-D.E.';
  if (/_SG$/.test(k)) return '3-SURGE';
  if (/_ICCS$/.test(k)) return '1-ICCS';
  if (/_ICAP$/.test(k)) return '2-ICAP';
  if (/_IDCAP$/.test(k)) return '2-IDCAP';
  if (/_ICOORD$/.test(k)) return '1-Insp. Coord.';
  if (k === 'LYCEE_IDELEGUE') return '2-Insp. Délégué';
  if (/_CP$/.test(k)) return 'CP';
  if (k === 'ALPHA_CTAR') return 'CTAR';
  if (k === 'ALPHA_CDAR') return 'CDAR';
  if (/^ITIN_/.test(k)) return 'Insp. Itinérant';
  if (k === 'DDEPPSA_CHEF_SERVICE') return 'Chef de service';
  return c.libelle;
}

/**
 * Abrégé de la fonction pour le repère en bas de la note (réunion du 29/10/2026 : « 29/10/2026/Nomm.
 * Provis. », pour savoir d'un coup d'œil qui la note nomme).
 */
export function repereNomination(code: string) {
  const R: Record<string, string> = {
    PRESCO_DIRECTEUR: 'Dir. CEP',
    PRESCO_ECONOME: 'Econ. CEP',
    PRIMAIRE_DIRECTEUR: 'Dir. EP',
    PRIMAIRE_ECONOME: 'Econ. EP',
    COLLEGE_DIRECTEUR: 'Dir. CEG',
    COLLEGE_DE: 'DE CEG',
    COLLEGE_SG: 'SG CEG',
    COLLEGE_ECONOME: 'Econ. CEG',
    LYCEE_PROVISEUR: 'Provis.',
    LYCEE_DE: 'DE Lycée',
    LYCEE_SG: 'SG Lycée',
    LYCEE_INTENDANT: 'Intend. Lycée',
    ALPHA_DIRECTEUR: 'Dir. CAR',
    ALPHA_CTAR: 'CTAR',
    ALPHA_CDAR: 'CDAR',
    PRESCO_ICCS: 'ICCS Presco',
    PRESCO_ICAP: 'ICAP Presco',
    PRESCO_CP: 'CP Presco',
    PRESCO_ECONOME_INSP: 'Econ. Insp. Presco',
    PRIMAIRE_ICCS: 'ICCS',
    PRIMAIRE_ICAP: 'ICAP',
    PRIMAIRE_CP: 'CP',
    PRIMAIRE_ECONOME_INSP: 'Econ. Insp.',
    COLLEGE_ICOORD: 'Insp. Coord. CEG',
    COLLEGE_ICAP: 'ICAP CEG',
    COLLEGE_IDCAP: 'IDCAP CEG',
    COLLEGE_ECONOME_INSP: 'Econ. Insp. CEG',
    LYCEE_ICOORD: 'Insp. Coord. Lycées',
    LYCEE_IDELEGUE: 'Insp. Dél. Lycées',
    LYCEE_ECONOME_INSP: 'Econ. Insp. Lycées',
    ITIN_INRAP: 'Insp. Itin. INRAP',
    ITIN_IAFP: 'Insp. Itin. IAFP',
    ITIN_IPA: 'Insp. Itin. IPA',
    ITIN_DFC: 'Insp. Itin. DFC',
    DDEPPSA_CHEF_SERVICE: 'CS DD',
  };
  return `Nomm. ${R[code] ?? code}`;
}
