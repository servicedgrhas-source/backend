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

/**
 * Catégorie de la Fonction Publique écrite à la main (« I », « Cat. II », « catégorie 3 », « HC »)
 * → code du référentiel : I, II, III ou HORS_CATEGORIE. Null si on ne la reconnaît pas.
 */
export function codeCategorie(brut: unknown): string | null {
  const k = cleCompacte(brut).replace(/^CAT(EGORIE)?/, '');
  if (!k) return null;
  if (k.startsWith('HORS') || k === 'HC') return 'HORS_CATEGORIE';
  const codes: Record<string, string> = {
    I: 'I',
    '1': 'I',
    II: 'II',
    '2': 'II',
    III: 'III',
    '3': 'III',
  };
  return codes[k] ?? null;
}

/**
 * Structure telle qu'elle s'écrit sur une note de service (DG, 01/11/2026) : jamais le nom complet
 * d'une direction départementale (« Direction départementale de l'enseignement préscolaire,
 * primaire, secondaire et de l'alphabétisation (Brazzaville) »), mais son sigle « DDEPPSA Brazzaville ».
 */
export function structureCourte(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const plat = sansAccents(t).toLowerCase();
  if (
    !/^direction departementale de l.?\s*enseignement prescolaire\b/.test(plat)
  )
    return t;
  // Le département : entre parenthèses (« … (Brazzaville) »), sinon après « alphabétisation de/du »
  const lieu =
    /\(([^)]+)\)\s*$/.exec(t)?.[1] ??
    /alphab[ée]tisation\s+(?:de\s+la\s+|de\s+|du\s+|d[’']\s*)?(.+)$/i.exec(
      t,
    )?.[1];
  return lieu?.trim() ? `DDEPPSA ${lieu.trim()}` : 'DDEPPSA';
}

/**
 * Clé d'un nom de direction, pour le reconnaître quelle que soit l'écriture : sans accents, sans
 * ponctuation, sans « l' » / « d' » (« de I'Enseignement » = « de l'enseignement ») ni sigle
 * final entre parenthèses.
 */
export function cleStructure(s: string): string {
  return cleCompacte(
    s.replace(/\s*\([^)]*\)\s*$/, '').replace(/\b[a-z]\s*['’]\s*/gi, ''),
  );
}

/**
 * Structure écrite sur une note (DG, 01/11/2026) : le sigle des directions (« DGEB » et non
 * « Direction Générale de l'Education de Base »), « DDEPPSA … » pour les directions
 * départementales ; un autre texte reste tel quel.
 */
export function structureAbregee(
  s: string | null | undefined,
  sigles: Map<string, string>,
): string | null {
  const court = structureCourte(s);
  if (!court || court.startsWith('DDEPPSA')) return court;
  return sigles.get(cleStructure(court)) ?? court;
}

/** Types de structures dont le nom complet s'abrège en sigle sur les notes. */
export const TYPES_DIRECTIONS = [
  'DIRECTION_CENTRALE',
  'DIRECTION_GENERALE',
  'DIRECTION_DGRHAS',
  'DGRHAS',
  'INSPECTION_GENERALE',
];

/**
 * Nom complet → sigle des directions de l'organigramme. Un nom porté par plusieurs directions
 * (« Direction des Affaires Administratives et Financières » : DGEB, DGES, IGEPSA) n'est pas
 * abrégé, faute de savoir laquelle.
 */
export async function siglesDesDirections(requete: {
  query: <T>(sql: string, params?: unknown[]) => Promise<T>;
}): Promise<Map<string, string>> {
  const lignes = await requete.query<{ nom: string; sigle: string }[]>(
    `SELECT nom, sigle FROM structure
      WHERE type = ANY($1) AND coalesce(sigle, '') <> '' AND coalesce(nom, '') <> ''`,
    [TYPES_DIRECTIONS],
  );
  const parCle = new Map<string, Set<string>>();
  for (const l of lignes) {
    const k = cleStructure(l.nom);
    if (!parCle.has(k)) parCle.set(k, new Set());
    parCle.get(k)!.add(l.sigle.trim());
  }
  return new Map(
    [...parCle].filter(([, s]) => s.size === 1).map(([k, s]) => [k, [...s][0]]),
  );
}
