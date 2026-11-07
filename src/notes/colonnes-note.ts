/**
 * Tableau d'une note de service toujours en A4 portrait (DG, 07/11/2026 : « jamais en paysage »).
 * Quand les colonnes ne tiennent pas, dans cet ordre :
 *  1. chaque colonne ne garde que la place qu'elle utilise (noms et prénoms compris) ;
 *  2. le texte passe à la ligne entre les mots (jamais au milieu d'un mot) ;
 *  3. la police diminue, jusqu'à 70 %.
 * Le même calcul est fait pour le Word (frontend/lib/colonnes-note.ts, copie identique) : garder les deux identiques.
 */

/** Largeur utile d'une page A4 portrait (mm) : 210 moins deux marges de 16 mm. */
export const LARGEUR_UTILE_PORTRAIT = 210 - 2 * 16;
/** Tailles de police essayées pour la largeur (1 : normale). */
export const ECHELLES_LARGEUR = [
  1, 0.97, 0.94, 0.91, 0.88, 0.85, 0.82, 0.8, 0.76, 0.73, 0.7,
];
/** Marges intérieures d'une case et bordures (mm), avec un peu de jeu pour les écarts d'estimation. */
const MARGE_CASE = 3;
/** Le gras réel du Times est un peu plus large que l'estimation (mesuré : +9 % au lieu de +6 %). */
const GRAS_REEL = 1.03;
/** Le nom ne descend jamais sous cette largeur (mm, à taille normale). */
const NOM_MINIMUM = 22;
/** Largeur du nom quand les autres colonnes tiennent sur une ligne (mm, à taille normale, comme avant). */
const NOM_CONFORT = 30;

export interface ColonneAAjuster {
  cle: string;
  /** Libellé de l'en-tête (en gras). */
  entete: string;
  /** Textes des cases de la colonne. */
  textes: string[];
  /** Largeur habituelle (mm, à taille normale). Le nom n'en a pas : il prend la place qui reste. */
  habituelle?: number;
  /** Jamais à la ligne (N°, grade, matricule…). */
  sansCoupure?: boolean;
}

export type Mesure = (texte: string, corps: number, gras?: boolean) => number;

/** Mots d'un texte : on passe à la ligne aux espaces et après un trait d'union. */
function morceaux(t: string) {
  return t.split(/\s+/).flatMap((mot) => mot.match(/[^-]+-?|-/g) ?? []);
}

/**
 * Largeur de chaque colonne (mm) et taille de police la plus grande qui fait tenir le tableau en
 * portrait. `corps` : taille du texte du tableau à 100 % (pt).
 */
export function ajusterColonnes(
  colonnes: ColonneAAjuster[],
  mesure: Mesure,
  corps = 10,
  utile = LARGEUR_UTILE_PORTRAIT,
) {
  const essai = (e: number) => {
    const c = corps * e;
    return colonnes.map((col) => {
      const motTexte = Math.max(
        0,
        ...col.textes.flatMap((t) => morceaux(t).map((m) => mesure(m, c))),
      );
      const motEntete = Math.max(
        0,
        ...morceaux(col.entete).map((m) => mesure(m, c, true) * GRAS_REEL),
      );
      const entier = Math.max(0, ...col.textes.map((t) => mesure(t, c)));
      const min =
        Math.max(col.sansCoupure ? entier : motTexte, motEntete) + MARGE_CASE;
      if (col.habituelle === undefined)
        // Noms et prénoms : sur une ligne si la place le permet, jamais trop étroit
        return {
          cle: col.cle,
          nom: true,
          min: Math.max(min, NOM_MINIMUM * e),
          pref: Math.max(min, NOM_MINIMUM * e, entier + MARGE_CASE),
        };
      // Jamais plus large que ce que le texte utilise vraiment
      return {
        cle: col.cle,
        nom: false,
        min,
        pref: Math.max(min, Math.min(col.habituelle * e, entier + MARGE_CASE)),
      };
    });
  };
  const somme = (l: number[]) => l.reduce((s, x) => s + x, 0);
  const resultat = (
    l: { cle: string; nom: boolean }[],
    largeurs: number[],
    echelle: number,
  ) => {
    // La place qui reste va aux noms et prénoms (ou, sans eux, à la dernière colonne)
    // (arrondi au dixième de millimètre vers le bas : le tableau ne dépasse jamais la page)
    const arrondies = largeurs.map((x) => Math.floor(x * 10) / 10);
    const reste = Math.floor((utile - somme(arrondies)) * 10) / 10;
    const i = Math.max(
      0,
      l.findIndex((x) => x.nom),
    );
    if (reste > 0) arrondies[i] = Math.round((arrondies[i] + reste) * 10) / 10;
    return {
      echelle,
      largeurs: Object.fromEntries(
        l.map((x, j) => [x.cle, arrondies[j]]),
      ) as Record<string, number>,
    };
  };
  // 1. Les autres colonnes tiennent sur une ligne, le nom prend la place qui reste (comme avant) ;
  //    la police à peine réduite au besoin
  for (const e of ECHELLES_LARGEUR.filter((x) => x >= 0.88)) {
    const l = essai(e);
    const largeurs = l.map((x) =>
      x.nom ? Math.max(x.min, NOM_CONFORT * e) : x.pref,
    );
    if (somme(largeurs) <= utile) return resultat(l, largeurs, e);
  }
  // 2. Le texte passe à la ligne entre les mots, la place répartie selon ce que chaque colonne voudrait
  for (const e of ECHELLES_LARGEUR) {
    const l = essai(e);
    const mins = somme(l.map((x) => x.min));
    if (mins <= utile) {
      const prefs = somme(l.map((x) => x.pref));
      const t = prefs > mins ? (utile - mins) / (prefs - mins) : 0;
      return resultat(
        l,
        l.map((x) => x.min + (x.pref - x.min) * t),
        e,
      );
    }
  }
  // 3. Même à 70 % c'est trop large : seules les colonnes au plus long mot (souvent un nom très long)
  //    cèdent de la place, jusqu'à un plafond commun ; les autres gardent leurs mots entiers
  const e = ECHELLES_LARGEUR[ECHELLES_LARGEUR.length - 1];
  const l = essai(e);
  const mins = l.map((x) => x.min);
  const tries = [...mins].sort((a, b) => b - a);
  let plafond = 0;
  for (let i = 0; i < tries.length; i++) {
    const reste = somme(tries.slice(i + 1));
    const cap = (utile - reste) / (i + 1);
    if (cap >= (tries[i + 1] ?? 0)) {
      plafond = cap;
      break;
    }
  }
  return resultat(
    l,
    mins.map((m) => Math.min(m, Math.max(plafond, 1))),
    e,
  );
}
