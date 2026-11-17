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
  // « Finaliste » : les volontaires (bourse), audio du 17/11/2026. Un bénévole n'est PAS un
  // volontaire : pas de statut (à choisir à l'ajout)
  if (/^BEN/.test(t)) return null;
  if (/^FINAL|^VOL|^BOURS/.test(t)) return 'VOLONTAIRE';
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
  const d = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (d)
    return {
      annee: +d[3],
      date: `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`,
    };
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return { annee: +iso[1], date: iso[0] };
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
  if (n >= 4 && (a.endsWith(b) || b.endsWith(a)) && Math.abs(a.length - b.length) === 1)
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
