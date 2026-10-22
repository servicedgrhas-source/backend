/** Utilitaires de normalisation des données issues des fichiers Excel DGRHAS. */

export function sansAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Valeur scalaire en texte (les objets inattendus donnent une chaîne vide). */
export function enTexte(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
    return String(v);
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : versIso(v);
  return '';
}

/** Majuscules, sans accents, espaces multiples réduits. */
export function normaliser(s: unknown): string {
  return sansAccents(enTexte(s))
    .toUpperCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clé compacte : uniquement lettres et chiffres. */
export function cleCompacte(s: unknown): string {
  return normaliser(s).replace(/[^A-Z0-9]/g, '');
}

export function nettoyer(s: unknown): string | null {
  const t = enTexte(s).replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

const MOIS = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
];

/** "2025-12-31" -> "31 Décembre 2025" (style des notes de service). */
export function dateEnLettres(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [a, m, j] = iso.slice(0, 10).split('-').map(Number);
  if (!a || !m || !j) return null;
  return `${j === 1 ? '1er' : j} ${MOIS[m - 1]} ${a}`;
}

/** Date JS -> "AAAA-MM-JJ" (en ignorant le fuseau, les dates Excel sont en UTC). */
export function versIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoValide(a: number, m: number, j: number): string | null {
  if (a < 1900 || a > 2100 || m < 1 || m > 12 || j < 1 || j > 31) return null;
  const d = new Date(Date.UTC(a, m - 1, j));
  if (d.getUTCMonth() !== m - 1) return null;
  return versIso(d);
}

/**
 * Interprète une date venant d'Excel : objet Date, numéro de série Excel,
 * ou texte ("09 10 1984", "04/03/1984", "10.07.1980", "2103/1986"...).
 * Retourne null si la date est illisible.
 */
export function lireDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : versIso(v);
  if (typeof v === 'number') {
    if (v > 1000 && v < 80000) {
      return versIso(new Date(Math.round((v - 25569) * 86400000)));
    }
    return null;
  }
  const s = enTexte(v).trim().replace(/[°]/g, '/');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoValide(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\s*[/.\s-]\s*(\d{1,2})\s*[/.\s-]\s*(\d{4})$/);
  if (m) return isoValide(+m[3], +m[2], +m[1]);
  // "2103/1986" ou "0810/1994" : jour et mois collés
  m = s.match(/^(\d{2})(\d{2})\s*[/.\s-]\s*(\d{4})$/);
  if (m) return isoValide(+m[3], +m[2], +m[1]);
  // "01/071992" : mois et année collés
  m = s.match(/^(\d{1,2})\s*[/.\s-]\s*(\d{2})(\d{4})$/);
  if (m) return isoValide(+m[3], +m[2], +m[1]);
  return null;
}

/** Âge révolu à une date de référence (dates ISO). */
export function ageRevolu(naissance: string, reference: string): number {
  const [an, mn, jn] = naissance.split('-').map(Number);
  const [ar, mr, jr] = reference.split('-').map(Number);
  let age = ar - an;
  if (mr < mn || (mr === mn && jr < jn)) age--;
  return age;
}

const ROMAINS: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20,
};

export function romainVersEntier(s: unknown): number | null {
  const t = normaliser(s);
  if (/^\d+$/.test(t)) return Number(t);
  return ROMAINS[t] ?? null;
}

export function entierVersRomain(n: number): string {
  const e = Object.entries(ROMAINS).find(([, v]) => v === n);
  return e ? e[0] : String(n);
}

/** Retire un préfixe de numérotation "IX. " ou "2. " ("IX. Plateaux" -> "Plateaux"). */
export function sansPrefixeNumero(s: unknown): string | null {
  const t = nettoyer(s);
  if (!t) return null;
  return t.replace(/^([IVXLC]+|\d+)\s*[.)-]\s*/i, '').trim() || null;
}
