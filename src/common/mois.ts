/** Mois au format « AAAA-MM » (bourse mensuelle). */
export const MOIS_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function moisDe(date: string | null | undefined): string | null {
  return date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null;
}

export function ajouterMois(mois: string, n: number): string {
  const [a, m] = mois.split('-').map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** Nombre de mois de `debut` à `fin` (même mois : 0). */
export function ecartMois(debut: string, fin: string): number {
  const [a1, m1] = debut.split('-').map(Number);
  const [a2, m2] = fin.split('-').map(Number);
  return a2 * 12 + m2 - (a1 * 12 + m1);
}

const NOMS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

/** « 2026-10 » → « octobre 2026 » */
export function moisEnClair(mois: string): string {
  const [a, m] = mois.split('-').map(Number);
  return `${NOMS[m - 1]} ${a}`;
}
