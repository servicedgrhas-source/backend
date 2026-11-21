/**
 * Nom des écoles (DG, 21/11/2026) : le type de l'école vient de son cycle, jamais de ce qui est
 * écrit. Le nom enregistré est toujours « préfixe du cycle + nom propre » : CEP (Centre d'éducation
 * préscolaire), EP (École primaire), CEG (Collège d'enseignement général), LEG (Lycée
 * d'enseignement général), CA (Centre d'alphabétisation). « Lycée Minangou Laurent », « ECOLE
 * PRIMAIRE minangou laurent » ou « EP Minangou Laurent » : le nom propre est « Minangou Laurent ».
 */

export const PREFIXES_CYCLE: Record<string, string> = {
  PRESCOLAIRE: 'CEP',
  PRIMAIRE: 'EP',
  COLLEGE: 'CEG',
  LYCEE: 'LEG',
  ALPHABETISATION: 'CA',
};

const D = `d['’]?\\s*`;
const E = '[eéèêEÉÈÊ]';
const A = '[aàâAÀÂ]';
/** Les écritures du type de l'école, en tête du nom (avec ou sans accents, majuscules ou non). */
const TYPES = [
  // Centre d'éducation préscolaire, Centre préscolaire, Préscolaire, CEP, C.E.P
  // (et ses fautes de frappe : « présolaire », « précolaire », « prscolaire »)
  `centre\\s+${D}${E}ducation\\s+pr\\w{0,3}colaire`,
  `centre\\s+${D}${E}ducation`,
  `centre\\s+pr${E}scolaire`,
  `pr${E}scolaire`,
  `c\\.?\\s?${E}\\.?\\s?p\\b\\.?`,
  // École primaire publique, École primaire, École, EPP, EP, E.P
  `${E}cole\\s+\\W?primaire\\s+publique`,
  `${E}cole\\s+\\W?primaire`,
  `${E}cole`,
  `primaire`,
  // EPP collé (« EPP », « E.P.P. ») : « EP P. Ndzoko » garde l'initiale « P. »
  `${E}\\.?p\\.?p\\b\\.?`,
  `${E}\\.?\\s?p\\b\\.?`,
  // Collège d'enseignement général, Collège, CEG
  `coll${E}ge\\s+(de\\s+l['’]?\\s*|${D})${E}nseignement\\s+g${E}n${E}r${A}l`,
  `coll${E}ge\\s+g${E}n${E}r${A}l`,
  `coll${E}ge`,
  `c\\.?\\s?${E}\\.?\\s?g\\b\\.?`,
  // Lycée d'enseignement général, Lycée, LEG
  `lyc${E}e\\s+(de\\s+l['’]?\\s*|${D})${E}nseignement\\s+g${E}n${E}r${A}l`,
  `lyc${E}e\\s+g${E}n${E}r${A}l`,
  `lyc${E}e`,
  `l\\.?\\s?${E}\\.?\\s?g\\b\\.?`,
  // Centre d'alphabétisation (et de rescolarisation), Alpha, CA
  `centre\\s+${D}${A}lph${A}b${E}tis${A}tion(\\s+et\\s+(de\\s+)?r${E}scol${A}ris${A}tion)?`,
  `centre\\s+${D}${A}lph${A}b\\.?`,
  `${A}lph${A}b${E}tis${A}tion`,
  `c\\.?\\s?${A}\\b\\.?`,
  // « Centre de Souanké », « CENTRE 31 JUILLET » : le type ; « Centre-Ville » reste un nom
  `centre(?=\\s+(de|du|d['’]|\\d))`,
].join('|');
const EN_TETE = new RegExp(
  `^\\s*(${TYPES})(?=[\\s.,:\\-–'’]|$)[\\s.,:\\-–]*`,
  'i',
);

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
 * Le nom propre de l'école, sans le type écrit devant. Les dates abîmées par Excel
 * (« 1964-02-08 00:00:00 ») redeviennent « 8 Février 1964 ».
 */
export function sansTypeEcole(nom: string | null | undefined): string {
  let n = (nom ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const m = EN_TETE.exec(n);
    // On garde le nom si le retrait ne laisse rien (« École », « CEP » tout seuls)
    if (!m || !n.slice(m[0].length).trim()) break;
    n = n.slice(m[0].length).trim();
  }
  n = n.replace(
    /\b(\d{4})-(\d{2})-(\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?)?\b/g,
    (_t, a: string, mo: string, j: string) =>
      Number(mo) >= 1 && Number(mo) <= 12
        ? `${Number(j) === 1 ? '1er' : Number(j)} ${MOIS[Number(mo) - 1]} ${a}`
        : _t,
  );
  return n;
}

/** Le nom d'une école tel qu'il est enregistré et montré partout : « EP Minangou Laurent ». */
export function nomEcole(
  cycle: string | null | undefined,
  nom: string | null | undefined,
): string {
  const propre = sansTypeEcole(nom);
  const prefixe = cycle ? PREFIXES_CYCLE[cycle] : undefined;
  return prefixe && propre ? `${prefixe} ${propre}` : (nom ?? '').trim();
}

/** Nom normé d'une structure : seules les écoles (établissements) avec un cycle changent. */
export function nomStructureNorme(s: {
  type?: string | null;
  cycle?: string | null;
  nom?: string | null;
}): string {
  return s.type === 'ETABLISSEMENT' ? nomEcole(s.cycle, s.nom) : (s.nom ?? '');
}
