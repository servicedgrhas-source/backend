/**
 * Recherche « intelligente » (DG, 22/11/2026 : « il ne faut pas taper exactement le même nom ») :
 * on tape comme on entend, le système comprend et propose. Tolère les accents, l'ordre des mots,
 * les fautes de frappe, les sons équivalents (OU/W, PH/F, C/K/Q, Y/I, lettres doublées, H muet),
 * les mots manquants, le début d'un mot (« vindou »), les mots collés (« moussaeta ») et, pour les
 * écoles, le type écrit ou non (EP, CEG, lycée…) et les chiffres romains (II-B = 2B = 2 B).
 * Copie de frontend/lib/recherche-souple.ts (les écoles sur l’appareil) : garder les deux pareils.
 */

const ROMAINS: Record<string, string> = {
  I: '1',
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
const NOMBRES: Record<string, string> = {
  UN: '1',
  DEUX: '2',
  TROIS: '3',
  QUATRE: '4',
  CINQ: '5',
  SIX: '6',
  SEPT: '7',
  HUIT: '8',
  NEUF: '9',
  DIX: '10',
};
/** Mots qui disent le type d'école ou qui ne distinguent rien : ignorés pour comparer. */
const VIDES_ECOLE = new Set([
  'ECOLE',
  'PRIMAIRE',
  'PUBLIQUE',
  'EP',
  'EPP',
  'CEG',
  'COLLEGE',
  'LYCEE',
  'LEG',
  'CEP',
  'CA',
  'CENTRE',
  'PRESCOLAIRE',
  'ALPHABETISATION',
  'ALPHA',
  'ENSEIGNEMENT',
  'GENERAL',
  'EDUCATION',
  'DE',
  'DU',
  'DES',
  'D',
  'LA',
  'LE',
  'L',
  'ET',
]);

/** Les types d'école (en son), pour les reconnaître même mal écrits. */
const SONS_VIDES_BRUTS = [
  'ECOLE',
  'PRIMAIRE',
  'PUBLIQUE',
  'COLLEGE',
  'LYCEE',
  'CENTRE',
  'PRESCOLAIRE',
  'ALPHABETISATION',
  'ENSEIGNEMENT',
  'GENERAL',
  'EDUCATION',
];
let SONS_VIDES: string[] = [];

/** Les mots d'un texte, à plat (majuscules sans accents, chiffres romains et nombres en chiffres). */
export function mots(texte: string, ecole = false): string[] {
  const plat = texte
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/(\d)([A-Z])\b/g, '$1 $2')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  const l = plat
    .split(' ')
    .filter(Boolean)
    .map((m) => ROMAINS[m] ?? NOMBRES[m] ?? m);
  const r = ecole ? l.filter((m) => !VIDES_ECOLE.has(m)) : l;
  return r.length ? r : l;
}

/** Le son d'un mot : les écritures qui se prononcent pareil donnent la même clé. */
export function son(m: string): string {
  if (/^\d+$/.test(m)) return m;
  let s = m
    .replace(/PH/g, 'F')
    .replace(/OU/g, 'U')
    .replace(/W/g, 'U')
    .replace(/Y/g, 'I')
    .replace(/CK|QU|Q/g, 'K')
    .replace(/C(?=[EI])/g, 'S')
    .replace(/C/g, 'K')
    .replace(/H/g, '')
    .replace(/(.)\1+/g, '$1');
  if (s.length > 4) s = s.replace(/[ESTX]$/, '');
  return s || m;
}

SONS_VIDES = SONS_VIDES_BRUTS.map((m) => son(m));

/** Distance d'édition (lettres ajoutées, ôtées ou changées), arrêtée au-delà de `max`. */
// Deux lignes réutilisées (aucune mémoire allouée par comparaison : des dizaines de milliers par recherche)
const LIGNE_A = new Int32Array(64);
const LIGNE_B = new Int32Array(64);
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (b.length > 62 || a.length > 62) return max + 1;
  let prec = LIGNE_A;
  let cour = LIGNE_B;
  for (let j = 0; j <= b.length; j++) prec[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cour[0] = i;
    let mini = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prec[j] + 1,
        cour[j - 1] + 1,
        prec[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1),
      );
      cour[j] = v;
      if (v < mini) mini = v;
    }
    if (mini > max) return max + 1;
    const t = prec;
    prec = cour;
    cour = t;
  }
  return prec[b.length];
}

/** Ressemblance d'un mot tapé avec un mot de la fiche (0 à 1). */
function ressemblanceMot(q: string, t: string): number {
  if (q === t) return 1;
  if (/^\d+$/.test(q) || /^\d+$/.test(t)) return 0;
  if (q.length >= 2 && t.startsWith(q)) return 0.92;
  const tolere = q.length <= 3 ? 0 : q.length <= 5 ? 1 : q.length <= 8 ? 2 : 3;
  if (!tolere) return 0;
  const d = distance(
    q,
    t.length > q.length + 2 ? t.slice(0, q.length + 1) : t,
    tolere,
  );
  return d <= tolere ? 0.88 - (0.18 * d) / tolere : 0;
}

/** Un texte préparé pour la recherche (ses sons, et ses mots collés deux à deux). */
export interface Prepare {
  sons: string[];
  colles: string[];
  /** Les deux ensemble (préparés une fois, pas à chaque comparaison). */
  tous: string[];
}
export function preparer(texte: string, ecole = false): Prepare {
  let s = mots(texte, ecole).map(son);
  // Un type d'école mal écrit (« alfabetisation », « lycé », « ecol ») est ignoré lui aussi
  if (ecole && s.length > 1) {
    const reste = s.filter(
      (m) =>
        // Le même son (« lycé », « ecol ») ; ou un mot long à une ou deux lettres près
        // (« alfabetisation »). Jamais un nom court qui sonne comme « école » (« AKOLO »)
        !SONS_VIDES.some(
          (v) =>
            v === m ||
            (m.length >= 7 &&
              distance(m, v, m.length >= 10 ? 2 : 1) <=
                (m.length >= 10 ? 2 : 1)),
        ),
    );
    if (reste.length) s = reste;
  }
  const colles = s.slice(0, -1).map((x, i) => x + s[i + 1]);
  return { sons: s, colles, tous: [...s, ...colles] };
}

/**
 * Note de 0 à 1 : chaque mot tapé cherche son meilleur mot dans la fiche (dans n'importe quel
 * ordre) ; un mot tapé introuvable fait chuter la note, sauf s'il y en a beaucoup.
 */
export function noter(requete: Prepare, cible: Prepare): number {
  if (!requete.sons.length || !cible.sons.length) return 0;
  const tous = cible.tous;
  let total = 0;
  let rates = 0;
  for (const q of requete.sons) {
    let best = 0;
    for (const t of tous) {
      const r = ressemblanceMot(q, t);
      if (r > best) best = r;
      if (best === 1) break;
    }
    if (!best) rates++;
    total += best;
  }
  const n = requete.sons.length;
  if (rates && (n < 3 || rates > 1)) return 0;
  // À note égale, la fiche qui a le moins de mots en plus passe devant (« NGOMA Alice » avant « NGOMA Alice Marie »)
  const enPlus = Math.max(0, cible.sons.length - n);
  return (total / n) * (rates ? 0.75 : 1) - 0.01 * Math.min(enPlus, 5);
}

/** Les meilleures fiches pour ce qui est tapé (au plus `max`), de la plus ressemblante à la moins. */
export function chercher<T>(
  texte: string,
  liste: { item: T; prepare: Prepare }[],
  max = 20,
  ecole = false,
  seuil = 0.6,
): { item: T; note: number }[] {
  const q = preparer(texte, ecole);
  if (!q.sons.length) return [];
  const r: { item: T; note: number }[] = [];
  for (const x of liste) {
    const note = noter(q, x.prepare);
    if (note >= seuil) r.push({ item: x.item, note });
  }
  return r.sort((a, b) => b.note - a.note).slice(0, max);
}
