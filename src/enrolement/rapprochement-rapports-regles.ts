/**
 * Règles du rapprochement des rapports de fin d'année des DDEPPSA (Banque mondiale, 17/11/2026) :
 * reconnaître les colonnes d'un état nominatif, lire ses valeurs, comparer un nom écrit dans le
 * rapport avec ceux de la base. Sans base de données : testables seules.
 */

import { normaliser } from '../common/texte';

/** Les colonnes reconnues d'un état nominatif (titres des rapports des DDEPPSA). */
export type ColonneRapport =
  | 'numero'
  | 'nom'
  | 'genre'
  | 'naissance'
  | 'nationalite'
  | 'grade'
  | 'statut'
  | 'fonction'
  | 'ecole'
  | 'situation'
  | 'codeService'
  | 'indice'
  | 'matricule'
  | 'diplomeAcad'
  | 'diplomeProf'
  | 'recrutement'
  | 'promotion'
  | 'arrivee'
  | 'departement'
  | 'cycle'
  | 'secteur'
  | 'rubrique'
  | 'page';

/** Titre de colonne → colonne (titre déjà à plat : majuscules, sans accents). */
const TITRES: [ColonneRapport, RegExp][] = [
  ['nom', /\bNOMS?\b.*PRENOM|^NOMS?$|^NOM ET/],
  ['numero', /^N ?[°O]?$|^NO$|^N °$|^NUMERO$|^N°$/],
  ['genre', /GENRE|SEXE/],
  ['naissance', /NAIS/],
  ['nationalite', /^NAT/],
  ['grade', /^G ?\/ ?E$|GRADE|ECHELON/],
  ['statut', /^STAT/],
  ['fonction', /FONCT/],
  ['ecole', /ECOLE|ETABLISSEMENT|LIEU|STRUCTURE/],
  ['situation', /SITU/],
  ['codeService', /CODE/],
  ['indice', /^IND/],
  ['matricule', /MATRICULE|^MLE/],
  ['diplomeAcad', /ACAD/],
  ['diplomeProf', /^PROF/],
  ['recrutement', /RECR/],
  ['promotion', /PROMO/],
  ['departement', /DEPARTEMENT|DDEPPSA|DEPPSA/],
  ['arrivee', /ARR|PRISE DE SERVICE|DEPART/],
  ['cycle', /^CYCLE/],
  ['secteur', /^SECTEUR/],
  ['rubrique', /RUBRIQUE|PERSONNEL/],
  ['page', /^PAGE/],
];

/** Le titre d'une cellule à plat (« Mle solde » → « MLE SOLDE »). */
export const aPlat = (t: unknown) =>
  normaliser(t)
    .replace(/[^A-Z0-9°/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** La colonne désignée par un titre, ou null. */
export function colonneDe(titre: unknown): ColonneRapport | null {
  const t = aPlat(titre);
  if (!t) return null;
  for (const [c, re] of TITRES) if (re.test(t)) return c;
  return null;
}

/** Une case vide du rapport (« / », « - », « : »). */
export const vide = (v: string | null | undefined) =>
  !v || /^[\s/:.\-–—]*$/.test(v);

/** Le statut écrit dans le rapport (« Fonct », « Com », « Final »…) → statut de la base. */
export function statutDe(brut: string | null | undefined): string | null {
  const t = aPlat(brut ?? '');
  if (!t) return null;
  if (/^FONCT|^FONC|^FP$|^F$/.test(t)) return 'FONCTIONNAIRE';
  if (/^CONT|^COTR|^CTR|^CT$/.test(t)) return 'CONTRACTUEL';
  // « Finaliste » et « bénévole » : les volontaires (bourse) — audio et DG, 17/11/2026
  if (/^FINAL|^VOL|^BEN|^BOURS/.test(t)) return 'VOLONTAIRE';
  if (/^COM/.test(t)) return 'COMMUNAUTAIRE';
  return null;
}

/** Secteur, cycle ou rubrique d'après un titre de partie (« A2 - Secteur privé »…). */
export function partieDe(texte: string) {
  const t = aPlat(texte);
  return {
    secteur: /PRIVE/.test(t)
      ? 'PRIVE'
      : /CONVENTION/.test(t)
        ? 'CONVENTIONNE'
        : /PUBLIC/.test(t)
          ? 'PUBLIC'
          : null,
    cycle: /PRESCOLAIRE|PRE SCOLAIRE/.test(t)
      ? 'PRESCOLAIRE'
      : /PRIMAIRE/.test(t)
        ? 'PRIMAIRE'
        : /COLLEGE|CEG/.test(t)
          ? 'COLLEGE'
          : /LYCEE/.test(t)
            ? 'LYCEE'
            : null,
    rubrique: /ADMINISTRATIF/.test(t)
      ? 'ADMINISTRATIF'
      : /ENSEIGNANT/.test(t)
        ? 'ENSEIGNANT'
        : null,
  };
}

/** Année ou date de naissance : « 1987 », « 06/02/1987 », une date Excel. */
export function naissanceDe(v: string | null | undefined): {
  annee: number | null;
  date: string | null;
} {
  const t = (v ?? '').trim();
  // Une date impossible du rapport (« 20/20/1978 », « 31/02/1990 », « 00/01/1900 ») n'est pas
  // gardée (elle bloquait tout l'import) ; son année l'est si elle est plausible
  const plausible = (a: number) => a >= 1930 && a <= new Date().getFullYear();
  const reelle = (a: number, m: number, j: number) => {
    const x = new Date(Date.UTC(a, m - 1, j));
    return (
      x.getUTCFullYear() === a &&
      x.getUTCMonth() === m - 1 &&
      x.getUTCDate() === j
    );
  };
  const d = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const amj = d
    ? [+d[3], +d[2], +d[1]]
    : iso
      ? [+iso[1], +iso[2], +iso[3]]
      : null;
  if (amj) {
    const [an, mo, jo] = amj;
    return {
      annee: plausible(an) ? an : null,
      date:
        plausible(an) && reelle(an, mo, jo)
          ? `${an}-${String(mo).padStart(2, '0')}-${String(jo).padStart(2, '0')}`
          : null,
    };
  }
  const a = /^(19|20)\d{2}$/.exec(t);
  return { annee: a ? +t : null, date: null };
}

/** Le matricule réduit à ses chiffres et lettres (« 233 792 R » → « 233792R »). */
export const codeMatricule = (m: unknown) =>
  normaliser(m).replace(/[^0-9A-Z]/g, '');

/** Les mots d'un nom, à plat (les mots d'une lettre gardés : initiales). */
export const motsDuNom = (nom: string) =>
  normaliser(nom)
    .replace(/[^A-Z ]+/g, ' ')
    .split(' ')
    .filter(Boolean);

function ecart(a: string, b: string) {
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

/** Ressemblance de deux mots, de 0 à 1 (paires de lettres ; une faute sur un mot long : 0,9). */
export function motSemblable(a: string, b: string) {
  if (a === b) return 1;
  const n = Math.min(a.length, b.length);
  if (n >= 4 && ecart(a, b) === 1) return 0.9;
  // « NTSOKO » / « TSOKO » : une lettre de plus au début
  if (
    n >= 4 &&
    (a.endsWith(b) || b.endsWith(a)) &&
    Math.abs(a.length - b.length) === 1
  )
    return 0.9;
  const p = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++)
      m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const pa = p(a);
  const pb = p(b);
  let c = 0;
  let t = 0;
  for (const [k, v] of pa) {
    c += Math.min(v, pb.get(k) ?? 0);
    t += v;
  }
  for (const v of pb.values()) t += v;
  return t ? (2 * c) / t : 0;
}

/**
 * Le nom du rapport comparé à un nom de la base, dans n'importe quel ordre : la moyenne, pour
 * chaque mot du rapport, de sa meilleure ressemblance avec un mot de la base (une initiale vaut
 * un mot qui commence par cette lettre). `complet` : chaque mot du rapport retrouvé (identique,
 * à une faute près, ou initiale) — la base peut avoir des prénoms en plus.
 */
export function compareNoms(rapport: string[], base: string[]) {
  if (!rapport.length || !base.length) return { score: 0, complet: false };
  let somme = 0;
  let trouves = 0;
  for (const m of rapport) {
    let mieux = 0;
    for (const x of base) {
      const s =
        m.length === 1 || x.length === 1
          ? m[0] === x[0]
            ? 0.8
            : 0
          : motSemblable(m, x);
      if (s > mieux) mieux = s;
    }
    somme += mieux;
    if (mieux >= 0.8) trouves++;
  }
  return {
    score: Math.round((somme / rapport.length) * 100) / 100,
    complet: trouves === rapport.length,
  };
}

/**
 * Les autres informations du bottin (rapport de la DDEPPSA) que la Banque mondiale n'utilise pas
 * mais qui servent à nos bases (DG, 18/11/2026 : « ces infos ne doivent pas dormir ») : rubrique de
 * la fiche → libellé. Elles ne vont dans une fiche que par le contrôle des modifications.
 */
export const INFOS_BOTTIN: Record<string, string> = {
  GENRE: 'Genre',
  LIEU_NAISSANCE: 'Lieu de naissance',
  NATIONALITE: 'Nationalité',
  SITUATION_MATRIMONIALE: 'Situation matrimoniale',
  NOMBRE_ENFANTS: 'Nombre d’enfants',
  TELEPHONE_1: 'Téléphone',
  FONCTION: 'Fonction',
  CATEGORIE: 'Catégorie',
  ECHELON: 'Échelon',
  INDICE_SOLDE: 'Indice solde',
  DIPLOME_PRO: 'Diplôme professionnel',
  AUTRES_DIPLOMES: 'Diplôme académique',
  DATE_RECRUTEMENT: 'Date de recrutement',
};

/** Rubriques réservées aux agents de l'État (fonctionnaires, contractuels). */
export const INFOS_AGENTS_ETAT = ['CATEGORIE', 'ECHELON', 'INDICE_SOLDE'];

/**
 * Les autres informations d'une ligne du rapport, prêtes pour une fiche : lues dans les colonnes
 * telles qu'écrites (« Genre », « Nat », « Situat matri » C.04 = célibataire, 4 enfants, « G/E »
 * I 1er = échelon 1, « Prof », « Acad », « Téléphone »…). Ce qui est douteux est laissé de côté :
 * une année seule de recrutement (la fiche exige une date complète), le grade abrégé de « G/E ».
 */
export function infosDuRapport(
  donnees: Record<string, unknown> | null | undefined,
  fonction?: string | null,
): Record<string, string> {
  const cases = Object.entries(donnees ?? {})
    .map(
      ([k, v]) =>
        [
          aPlat(k),
          (typeof v === 'string'
            ? v
            : v === null || v === undefined
              ? ''
              : JSON.stringify(v)
          )
            .replace(/\s+/g, ' ')
            .trim(),
        ] as const,
    )
    .filter(([, v]) => !vide(v) && !/\?/.test(v));
  const lire = (re: RegExp) => cases.find(([t]) => re.test(t))?.[1] ?? '';
  const r: Record<string, string> = {};
  // Genre
  const g = aPlat(lire(/^(GENRE|SEXE|G)$/));
  if (/^(F|FEMININ|FEMME)$/.test(g)) r.GENRE = 'F';
  else if (/^(M|H|MASCULIN|HOMME)$/.test(g)) r.GENRE = 'M';
  // Lieu de naissance
  const lieu = lire(/LIEU.*NAIS/);
  if (lieu && /[A-Za-z]{2}/.test(lieu)) r.LIEU_NAISSANCE = lieu.slice(0, 120);
  // Nationalité : « Cg », « Cong », « C » = congolaise
  const nat = aPlat(lire(/^NAT/));
  if (/^(C|CG|CGSE|CONG|CONGO|CONGOLAIS|CONGOLAISE)$/.test(nat))
    r.NATIONALITE = 'Congolaise';
  else if (nat.length >= 5 && !/^CONT/.test(nat)) r.NATIONALITE = lire(/^NAT/);
  // Situation matrimoniale et enfants : « C.04 », « M2 », « Célibataire »
  const MATRI: Record<string, string> = {
    C: 'CELIBATAIRE',
    M: 'MARIE',
    D: 'DIVORCE',
    V: 'VEUF',
  };
  for (const [, brut] of cases
    .filter(([t]) => /^SITU/.test(t))
    .sort(([a], [b]) => Number(/MATRI/.test(b)) - Number(/MATRI/.test(a)))) {
    const s = aPlat(brut);
    const m =
      /^(CELIB|MARI|DIVOR|VEU)/.exec(s) ??
      /^([CMDV])(?: ?0?(\d{1,2}))?$/.exec(s);
    if (!m) continue;
    const k = m[1].startsWith('CELIB')
      ? 'C'
      : m[1].startsWith('MARI')
        ? 'M'
        : m[1].startsWith('DIVOR')
          ? 'D'
          : m[1].startsWith('VEU')
            ? 'V'
            : m[1];
    r.SITUATION_MATRIMONIALE ??= MATRI[k];
    if (m[2] !== undefined && r.NOMBRE_ENFANTS === undefined)
      r.NOMBRE_ENFANTS = String(Number(m[2]));
  }
  const enfants = lire(/ENFANT/);
  if (/^\d{1,2}$/.test(enfants)) r.NOMBRE_ENFANTS = String(Number(enfants));
  // Téléphone
  const tel = lire(/^(TEL|TELEPHONE|CONTACT|N DE TEL|N° DE TEL)/);
  if (tel.replace(/\D/g, '').length >= 8) r.TELEPHONE_1 = tel;
  // Fonction (abréviations du rapport)
  const f = (fonction ?? lire(/^FONCT/)).trim();
  const fa = aPlat(f);
  if (fa && !/^(ACTIVE?|FINAL|COMM?|VOL|BEN)\b/.test(fa)) {
    r.FONCTION = /^ENS/.test(fa)
      ? /ANTE$/.test(fa)
        ? 'Enseignante'
        : 'Enseignant'
      : /^SECR/.test(fa)
        ? 'Secrétaire'
        : /^GESTION/.test(fa)
          ? 'Gestionnaire'
          : /^EDUC/.test(fa)
            ? 'Éducatrice'
            : f.replace(/\.$/, '');
  }
  // Catégorie (1 → I), échelon (colonne, ou le nombre de « G/E » : I 1er, Inst 7)
  const cat = aPlat(lire(/^CAT/));
  if (/^[123]$/.test(cat)) r.CATEGORIE = ['I', 'II', 'III'][Number(cat) - 1];
  else if (/^(I|II|III)$/.test(cat)) r.CATEGORIE = cat;
  const ech = /^(\d{1,2})(ER|E|EME)?$/.exec(aPlat(lire(/^ECHELON$|^ECH$/)));
  const ge = /(?:^|[^0-9])(\d{1,2}) ?(?:ER|E|EME)?$/.exec(
    aPlat(lire(/^G ?\/ ?E$/)),
  );
  if (ech) r.ECHELON = String(Number(ech[1]));
  else if (ge) r.ECHELON = String(Number(ge[1]));
  const ind = lire(/^IND/).replace(/\s/g, '');
  if (/^\d{2,4}$/.test(ind)) r.INDICE_SOLDE = ind;
  // Diplômes
  const prof = lire(/^PROF/);
  if (/[A-Za-z]{2}/.test(prof))
    r.DIPLOME_PRO = prof.replace(/\s*[-/]\s*/g, ' ').trim();
  const acad = aPlat(lire(/ACAD/));
  const d =
    /^(CEPE|BEPC|PEPC|BEMG|BET|BEMT|BAC|LIC|LICENCE|DEUG|BTS|MAITRISE|MASTER)(?: (.+))?$/.exec(
      acad,
    );
  if (d) {
    const code =
      {
        PEPC: 'BEPC',
        BEMG: 'BEPC',
        BEMT: 'BET',
        LIC: 'LICENCE',
        DEUG: 'LICENCE',
      }[d[1]] ?? d[1];
    if (d[1] !== 'DEUG') r.AUTRES_DIPLOMES = `${code} | ${d[2] ?? ''} | |`;
  }
  // Recrutement : seulement une date complète
  const recr = naissanceDe(lire(/RECR/)).date;
  if (recr) r.DATE_RECRUTEMENT = recr;
  return r;
}
