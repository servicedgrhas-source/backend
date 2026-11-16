import { normaliser } from '../common/texte';

/**
 * Origine d'un enrôlé (qui l'a recommandé), DG 16/11/2026 : décisive, mais pour la DGRHAS seulement.
 * Les fichiers l'écrivent de dix façons (« S/C DRSC », « S/D DRSC », « SC/ DRSC », « DRSC »…) : on
 * garde toujours l'écriture du fichier, et on en tire une clé de regroupement. Pas d'origine écrite :
 * pas d'origine (on n'invente rien).
 */

/** « Sous couvert de », « sous le couvert », « sur demande de »… écrits au début. */
const DEBUT =
  /^(?:(?:S|SC|SD|SL|SB|DOS)(?: (?:C|D|L|B))?|SOUS (?:LE )?COUVERT(?: DE| DU| DES)?|SUR (?:DEMANDE|RECOMMANDATION)(?: DE| DU)?|PAR|DE LA PART DE) +/;

/** Mots écrits de plusieurs façons. */
const MOTS: Record<string, string> = {
  CABINET: 'CAB',
  DDEPSA: 'DDEPPSA',
  DEPPSA: 'DDEPPSA',
  DDEPPSAS: 'DDEPPSA',
  PNR: 'POINTE NOIRE',
  PN: 'POINTE NOIRE',
  ATT: 'ATTACHE',
  MR: '',
  MME: '',
  MLLE: '',
  M: '',
};

/**
 * La clé de regroupement d'une origine écrite : majuscules sans accents ni ponctuation, sans
 * « S/C », « SC/ », « S/D »… au début, les mots courants écrits d'une seule façon. Vide : pas d'origine.
 */
export function cleOrigine(brute: string | null | undefined): string {
  let t = normaliser(brute ?? '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  for (let i = 0; i < 3 && DEBUT.test(t); i++) t = t.replace(DEBUT, '').trim();
  return t
    .split(' ')
    .map((m) => (m in MOTS ? MOTS[m] : m))
    .filter(Boolean)
    .join(' ');
}

/** Le nom à afficher d'un groupe : l'écriture la plus fréquente, sans « S/C » au début. */
export function libelleOrigine(ecritures: Map<string, number>): string {
  const [plusFrequente] = [...ecritures.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].length - b[0].length,
  )[0] ?? [''];
  const sans = plusFrequente
    .replace(
      /^\s*(?:S\s*[/.]\s*[CDLB](?![A-Za-zÀ-ÿ])\.?|S[CDLB]\s*[/.]|DOS\s*\/|sous\s+(?:le\s+)?couvert(?:\s+(?:de|du|des))?)\s*/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return sans || plusFrequente;
}
