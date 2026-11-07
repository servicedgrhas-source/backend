/**
 * Établissements scolaires rangés et nommés comme le veut le DG (réunion du 06/11/2026) : d'abord les
 * centres d'éducation préscolaire, puis les écoles primaires, les collèges, les lycées ; dans chaque
 * cycle, l'ordre alphabétique. Devant le nom, l'abréviation du cycle (« EP Moungali 3 », « CEG
 * Boko-Songho ») au lieu du libellé complet ; les abréviations se règlent dans les paramètres.
 * L'alphabétisation et les établissements sans cycle restent tels quels.
 */

export const RANG_CYCLE: Record<string, number> = {
  PRESCOLAIRE: 1,
  PRIMAIRE: 2,
  COLLEGE: 3,
  LYCEE: 4,
};

/** Paramètre de l'abréviation d'un cycle, et sa valeur d'origine. */
export const ABREVIATIONS_CYCLE: Record<string, [string, string]> = {
  PRESCOLAIRE: ['ABREV_PRESCOLAIRE', 'CEP'],
  PRIMAIRE: ['ABREV_PRIMAIRE', 'EP'],
  COLLEGE: ['ABREV_COLLEGE', 'CEG'],
  LYCEE: ['ABREV_LYCEE', 'Lycée'],
};

/** Le libellé complet (ou déjà abrégé) écrit au début du nom, par cycle : il est remplacé. */
const DEBUTS: Record<string, RegExp> = {
  PRESCOLAIRE:
    /^(?:centre\s+d['’\s]?[ée]ducation\s+pr[ée]scolaire|pr[ée]scolaire(?=\s)|[ée]cole\s+maternelle|c\.?\s?e\.?\s?p\.?(?=[\s.])|cep(?=\s))\s*(?:de\s+la\s+|de\s+l['’]|du\s+|des\s+|de\s+|d['’])?/i,
  PRIMAIRE:
    /^(?:[ée]cole\s+primaire|e\.?\s?p\.?(?=[\s.])|ep(?=\s))\s*(?:de\s+la\s+|de\s+l['’]|du\s+|des\s+|de\s+|d['’])?/i,
  COLLEGE:
    /^(?:coll[èe]ge\s+d['’\s]?enseignement\s+g[ée]n[ée]ral|c\.?\s?e\.?\s?g\.?(?=[\s.])|ceg(?=\s)|coll[èe]ge)\s*(?:de\s+la\s+|de\s+l['’]|du\s+|des\s+|de\s+|d['’])?/i,
};

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

/**
 * Un nom d'école devenu une date dans Excel (« 15 août 1963 » → « 1963-08-15 00:00:00 ») retrouve
 * son écriture : « 15 Août 1963 ». Seulement à l'affichage ; le nom enregistré ne change pas.
 */
export function dateEnClair(nom: string) {
  return nom.replace(
    /(\d{4})-(\d{2})-(\d{2})(?:[ T]00:00:00(?:\.0+)?)?/g,
    (x, a: string, m: string, j: string) =>
      Number(m) >= 1 && Number(m) <= 12
        ? `${Number(j)}${j === '01' ? 'er' : ''} ${MOIS[Number(m) - 1]} ${a}`
        : x,
  );
}

/** « École primaire de Moungali 3 » → « EP Moungali 3 » ; « Lycée Savorgnan » reste ; sans cycle : tel quel. */
export function nomAbrege(
  nom: string,
  cycle: string | null | undefined,
  abreviation: (cycle: string) => string | null,
): string {
  const n = dateEnClair(nom ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const c = cycle ?? '';
  const a = RANG_CYCLE[c] ? abreviation(c) : null;
  if (!a || !n) return n;
  if (c === 'LYCEE') return /^lyc[ée]e\b/i.test(n) ? n : `${a} ${n}`;
  const debut = DEBUTS[c];
  const reste = debut ? n.replace(debut, '').trim() : n;
  // Un nom qui n'est que l'abréviation (« EP ») : on le garde
  if (!reste) return n;
  return `${a} ${reste.charAt(0).toUpperCase()}${reste.slice(1)}`;
}

/** Tri : cycle (préscolaire, primaire, collège, lycée, puis les autres), puis l'ordre alphabétique. */
export function parCycleEtNom(
  a: { nom: string; cycle?: string | null },
  b: { nom: string; cycle?: string | null },
) {
  return (
    (RANG_CYCLE[a.cycle ?? ''] ?? 9) - (RANG_CYCLE[b.cycle ?? ''] ?? 9) ||
    a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' })
  );
}
