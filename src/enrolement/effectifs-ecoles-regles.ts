import { dateEnClair } from '../common/etablissement-nom';
import { sansAccents } from '../common/texte';

/**
 * Reconnaître une école d'après son nom écrit à la main (Banque mondiale, 16/11/2026) : la même école
 * est écrite de dix façons (« CENTRE D'EDUCATION PRESCOLAIRE DE NANGA », « C.E.P de Nanga »,
 * « Prescolaire Nanga »…). On en tire le cycle (d'après le début du nom) et une clé : le nom sans le
 * libellé du cycle, sans accents ni ponctuation, les articles du début ôtés, les nombres écrits de la
 * même façon. Deux écritures qui donnent la même clé dans la même DEPPSA sont la même école.
 */

export type CycleEcole =
  'PRESCOLAIRE' | 'PRIMAIRE' | 'COLLEGE' | 'LYCEE' | 'ALPHABETISATION';

export const CYCLES_ECOLE: Record<CycleEcole, string> = {
  PRESCOLAIRE: 'Préscolaire',
  PRIMAIRE: 'Primaire',
  COLLEGE: 'Collège',
  LYCEE: 'Lycée',
  ALPHABETISATION: 'Alphabétisation',
};

/** Le libellé du cycle écrit au début du nom (texte déjà en majuscules, sans ponctuation). */
const DEBUTS: [CycleEcole, RegExp][] = [
  [
    'ALPHABETISATION',
    /^(?:CENTRE (?:D )?ALPHABETISATION(?: ET (?:DE )?RESCOLARISATION)?|CENTRE (?:DE )?RESCOLARISATION(?: ET (?:D )?ALPHABETISATION)?|CENTRE ALPHA|CAR)(?= |$)/,
  ],
  [
    'PRESCOLAIRE',
    /^(?:C[OE]NTRE (?:D )?(?:EDUCATION|ENCADREMENT) PRE ?SCOLAIRE|CENTRE PRE ?SCOLAIRE|CENTRE (?:D )?EVEIL(?: COMMUNAUTAIRE)?|C E PRE ?SCOLAIRE|ECOLE MATERNELLE|JARDIN (?:D )?ENFANTS?|PRE ?SCOLAIRE|CENTRE (?:D )?EDUCATION|C E P|CEP)(?= |$)/,
  ],
  [
    'COLLEGE',
    /^(?:COLLEGE (?:D )?ENSEIGNEMENT GENERAL|C E G|CEG|COLLEGE)(?= |$)/,
  ],
  [
    'LYCEE',
    /^(?:LYCEE (?:D )?ENSEIGNEMENT GENERAL|LYCEE (?:GENERAL )?(?:ET )?TECHNIQUE|LYCEE)(?= |$)/,
  ],
  ['PRIMAIRE', /^(?:ECOLE PRIMAIRE|E P|EP|ECOLE)(?= |$)/],
];

/** Lieux qui ne sont pas des écoles : inspections, directions, cabinets… */
const HORS_ECOLE =
  /^(?:I?RECTION|DIRECTION|INS?P?EC?T?IONS?|CABINET|SERVICE|BUREAU|(?:D ?)?D ?E ?P ?P ?S ?A|MINISTERE|SECRETARIAT|CELLULE|CONSEIL|INSTITUT|INRAP|DGRHAS|DGEB|DGES|CIRCONSCRIPTION|COORDINATION|MAIRIE|(?:SOUS )?PREFECTURE|COM+UNAUTE URBAINE|CSI|HOPITAL|CHU|CENTRE DE SANTE|DES SOINS)(?= |$)/;

const ROMAINS: Record<string, string> = {
  II: '2',
  III: '3',
  IV: '4',
  V: '5',
  VI: '6',
  VII: '7',
  VIII: '8',
  IX: '9',
  X: '10',
};

const MOTS: Record<string, string> = {
  CTRE: 'CENTRE',
  ST: 'SAINT',
  STE: 'SAINTE',
};

/** Majuscules, sans accents, la ponctuation remplacée par des espaces. */
function aPlat(nom: string) {
  return (
    sansAccents(dateEnClair(nom))
      .toUpperCase()
      .replace(/N°\s*/g, ' ')
      .replace(/[^A-Z0-9]+/g, ' ')
      // Les fautes courantes dans le libellé du cycle (« PRECOLAIRE », « CETRE D'ECADION »)
      .replace(/\bPRE ?S?COL(?:AI|IA)O?RE/g, 'PRESCOLAIRE')
      .replace(/\b(?:CETRE|CENTE|CNTRE|CENRE)\b/g, 'CENTRE')
      .replace(
        /\b(?:ECADION|DUCATION|EDUCATIO|EDCUATION|EDUACTION)\b/g,
        'EDUCATION',
      )
      .replace(/PRE ?SCOLAIRE(?!S )(?=[A-Z])/g, 'PRESCOLAIRE ')
      .replace(/([A-Z]{2,})(\d)/g, '$1 $2')
      .replace(/(\d)([A-Z]{3,})/g, '$1 $2')
      // Une lettre de groupe collée au nombre : « 1968B » = « 1968 B »
      .replace(/(\d{3,})([A-Z])\b/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Le cycle d'après le début du nom, ou null. */
export function cycleDuNom(nom: string | null | undefined): CycleEcole | null {
  const t = aPlat(nom ?? '');
  for (const [c, re] of DEBUTS) if (re.test(t)) return c;
  return null;
}

/** Inspection, direction, cabinet… : un lieu de service qui n'est pas une école. */
export function estHorsEcole(nom: string | null | undefined) {
  return HORS_ECOLE.test(aPlat(nom ?? ''));
}

/**
 * Le nom sans le libellé du cycle, ôté jusqu'à deux fois (« CEP PRESCOLAIRE DE KINTELE » →
 * « DE KINTELE ») ; texte déjà à plat.
 */
function sansLibelle(plat: string) {
  let t = plat;
  for (let n = 0; n < 2; n++) {
    const d = DEBUTS.find(([, re]) => re.test(t));
    if (!d) break;
    const reste = t.replace(d[1], '').trim();
    if (!reste) break;
    t = reste;
  }
  return t;
}

/**
 * La clé d'une école : le nom sans le libellé du cycle, ni les articles du début ; les nombres sans
 * zéro devant, les chiffres romains en chiffres (« DOLISIE II » = « DOLISIE 2 »). Vide : pas de nom.
 */
export function cleEcole(nom: string | null | undefined) {
  const mots = sansLibelle(aPlat(nom ?? ''))
    .split(' ')
    .filter(Boolean);
  while (
    mots.length > 1 &&
    ['DE', 'DU', 'D', 'DES', 'LA', 'LE', 'L'].includes(mots[0])
  )
    mots.shift();
  return mots
    .map((m, i) =>
      /^\d+$/.test(m)
        ? String(Number(m))
        : ROMAINS[m] && i > 0
          ? ROMAINS[m]
          : m === 'I' && i > 0 && i === mots.length - 1
            ? '1'
            : (MOTS[m] ?? m),
    )
    .join(' ');
}

const ABREVIATIONS: Record<CycleEcole, string> = {
  PRESCOLAIRE: 'CEP',
  PRIMAIRE: 'EP',
  COLLEGE: 'CEG',
  LYCEE: 'Lycée',
  ALPHABETISATION: 'Centre d’alphabétisation',
};

/**
 * Le nom d'une école tel qu'affiché : l'abréviation du cycle, puis le nom écrit sans le libellé du
 * cycle ni les articles du début, avec ses accents (« CENTRE D'EDUCATION PRESCOLAIRE DE Kintélé »
 * → « CEP Kintélé »). Sans cycle reconnu : le nom tel qu'écrit.
 */
export function nomAffiche(nom: string, cycle: CycleEcole | null) {
  const n = dateEnClair(nom).replace(/\s+/g, ' ').trim();
  if (!cycle) return n;
  const a = ABREVIATIONS[cycle];
  const plat = aPlat(n);
  const mots = sansLibelle(plat).split(' ').filter(Boolean);
  while (
    mots.length > 1 &&
    ['DE', 'DU', 'D', 'DES', 'LA', 'LE', 'L'].includes(mots[0])
  )
    mots.shift();
  const reste = mots.join(' ');
  if (!reste) return n;
  // Ce reste dans le nom d'origine (accents et casse d'origine), sinon le reste à plat
  for (const j of n.matchAll(/[\p{L}\p{N}]+/gu)) {
    const txt = n.slice(j.index).trim();
    if (aPlat(txt) === reste)
      return `${a} ${txt.charAt(0).toUpperCase()}${txt.slice(1)}`;
  }
  return `${a} ${reste}`;
}

/** Le cycle d'une catégorie de bourse (« COM_PRESCOLAIRE », « PRIMAIRE »…), ou null. */
export function cycleDeCategorie(
  categorie: string | null | undefined,
): CycleEcole | null {
  const c = (categorie ?? '').replace(/^COM_/, '');
  if (c === 'POST_ALPHA' || c === 'ALPHABETISATION') return 'ALPHABETISATION';
  return c in CYCLES_ECOLE ? (c as CycleEcole) : null;
}

/** Distance d'édition entre deux textes (lettres ajoutées, ôtées ou changées). */
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prec = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cour = [i];
    for (let j = 1; j <= b.length; j++)
      cour[j] = Math.min(
        prec[j] + 1,
        cour[j - 1] + 1,
        prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prec = cour;
  }
  return prec[b.length];
}

/**
 * Deux clés d'école qui ne diffèrent que d'une faute de frappe (« MOUYONDZI » / « MOYONDZI ») : une
 * lettre de plus, de moins ou changée, les mêmes nombres, au moins 6 lettres. « MOUNGALI 2 » et
 * « MOUNGALI 3 » restent deux écoles.
 */
export function faute(a: string, b: string) {
  if (a === b || a.length < 6 || b.length < 6) return false;
  const nombres = (x: string) => (x.match(/\d+/g) ?? []).join(' ');
  return nombres(a) === nombres(b) && distance(a, b) === 1;
}

const MOIS_EN_LETTRES = new Set([
  'JANVIER',
  'FEVRIER',
  'MARS',
  'AVRIL',
  'MAI',
  'JUIN',
  'JUILLET',
  'AOUT',
  'SEPTEMBRE',
  'OCTOBRE',
  'NOVEMBRE',
  'DECEMBRE',
]);

const GENERIQUES = new Set([
  'PRESCOLAIRE',
  'CENTRE',
  'ECOLE',
  'ECOLES',
  'PRIMAIRE',
  'PRIMAIRES',
  'EDUCATION',
  'COMMUNE',
  'PUBLIQUE',
  'PRIVE',
  'PRIVEE',
]);

/** Les paires de lettres d'un texte (sans espaces), pour comparer deux noms. */
export function paires(cle: string) {
  const t = cle.replace(/ /g, '');
  const p = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const x = t.slice(i, i + 2);
    p.set(x, (p.get(x) ?? 0) + 1);
  }
  return p;
}

/**
 * Ressemblance de deux clés d'école, de 0 à 1 (Banque mondiale, 16/11/2026) : la part des paires de
 * lettres communes, ou 0,85 quand les mots du nom le plus court sont tous dans l'autre (« MASSAMBA
 * DEBAT » / « ALPHONSE MASSAMBA DEBAT »). Jamais rapprochées : des nombres différents (« MOUNGALI 2
 * » / « MOUNGALI 3 ») ou des lettres de groupe différentes (« LIBERTE A » / « LIBERTE B »).
 */
export function ressemblance(
  a: string,
  b: string,
  pa: Map<string, number> = paires(a),
  pb: Map<string, number> = paires(b),
) {
  if (a === b) return 1;
  const nombres = (x: string) => (x.match(/\d+/g) ?? []).join(' ');
  if (nombres(a) !== nombres(b)) return 0;
  const ma = a.split(' ').filter(Boolean);
  const mb = b.split(' ').filter(Boolean);
  const lettres = (m: string[]) =>
    m
      .filter((x) => /^[A-Z]$/.test(x))
      .sort()
      .join('');
  const la = lettres(ma);
  const lb = lettres(mb);
  if (la && lb && la !== lb) return 0;
  // Des dates différentes (« 31 AOUT 1968 » / « 31 JUILLET 1968 ») : deux écoles
  const mois = (m: string[]) =>
    m
      .filter((x) => MOIS_EN_LETTRES.has(x))
      .sort()
      .join(' ');
  if (mois(ma) !== mois(mb) && mois(ma) && mois(mb)) return 0;
  let communes = 0;
  let total = 0;
  for (const [x, n] of pa) {
    communes += Math.min(n, pb.get(x) ?? 0);
    total += n;
  }
  for (const n of pb.values()) total += n;
  let s = total ? (2 * communes) / total : 0;
  // Les mots qui ne désignent pas une école en particulier ne comptent pas pour « contenu dans »
  const longs = (m: string[]) =>
    m.filter((x) => x.length > 1 && !GENERIQUES.has(x));
  const [court, long] =
    longs(ma).length <= longs(mb).length
      ? [longs(ma), longs(mb)]
      : [longs(mb), longs(ma)];
  const trouves = court.filter((m) =>
    long.some((x) => x === m || faute(x, m)),
  ).length;
  if (court.join('').length >= 5 && trouves === court.length)
    s = Math.max(s, 0.85);
  // Un seul mot différent sur trois ou plus (« ALPHANCE MASSAMBA DEBAT » / « ALPHONSE … »)
  else if (court.length >= 3 && trouves === court.length - 1)
    s = Math.max(s, 0.8);
  return Math.round(s * 100) / 100;
}
