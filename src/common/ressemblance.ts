import { normaliser } from './texte';

/**
 * Ressemblance entre deux noms de personne, mot par mot : un prénom ou un nom
 * de plus ou de moins, des mots dans un autre ordre, une faute de frappe
 * (« MOUANDA » / « MOUANDAH », « BOYA » / « BOIA ») n'empêchent pas de
 * reconnaître la même personne.
 */

/** Mots qui ne distinguent pas une personne (« née », « épouse »…). */
const MOTS_IGNORES = new Set([
  'NEE',
  'NE',
  'EPSE',
  'EPOUSE',
  'VEUVE',
  'VVE',
  'DIT',
  'DITE',
  'ALIAS',
  'DE',
  'DU',
  'DES',
  'LA',
  'LE',
]);

export function motsDuNom(nom: string): string[] {
  // « Jean-Paul » compte pour deux mots, comme « Jean Paul »
  return normaliser(nom)
    .split(/[^A-Z0-9]+/)
    .filter((m) => m.length >= 2 && !MOTS_IGNORES.has(m));
}

/** Distance d'édition (nombre de lettres à changer). */
export function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prec = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(
        d[j] + 1,
        d[j - 1] + 1,
        prec + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prec = t;
    }
  }
  return d[b.length];
}

/** Deux mots sont « les mêmes » s'ils ne diffèrent que d'une faute (deux pour les longs). */
function memeMot(a: string, b: string) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  return distance(a, b) <= (n >= 8 ? 2 : 1);
}

/** Nombre de mots communs (chaque mot ne sert qu'une fois). */
export function motsCommuns(a: string[], b: string[]) {
  const libres = [...b];
  let n = 0;
  for (const m of a) {
    const i = libres.findIndex((x) => memeMot(m, x));
    if (i >= 0) {
      n++;
      libres.splice(i, 1);
    }
  }
  return n;
}

export type Ressemblance = 'PROBABLE' | 'POSSIBLE' | null;

/**
 * PROBABLE : très sans doute la même personne (tous les mots du nom le plus
 * court se retrouvent dans l'autre, ou même date de naissance et un nom commun).
 * POSSIBLE : au moins deux mots en commun.
 */
export function ressemblance(
  motsA: string[],
  naissanceA: string | null | undefined,
  motsB: string[],
  naissanceB: string | null | undefined,
): Ressemblance {
  if (!motsA.length || !motsB.length) return null;
  const communs = motsCommuns(motsA, motsB);
  const plusCourt = Math.min(motsA.length, motsB.length);
  const memeNaissance = !!naissanceA && naissanceA === naissanceB;
  if (memeNaissance && communs >= 1 && (communs >= 2 || communs === plusCourt))
    return 'PROBABLE';
  // Deux dates connues et différentes : on prévient, sans conclure
  const naissancesDifferentes =
    !!naissanceA && !!naissanceB && naissanceA !== naissanceB;
  if (communs >= 2 && communs === plusCourt)
    return naissancesDifferentes ? 'POSSIBLE' : 'PROBABLE';
  if (communs >= 2) return 'POSSIBLE';
  // Même date de naissance et un nom en commun (jumeaux, prénom écrit autrement…)
  if (memeNaissance && communs >= 1) return 'POSSIBLE';
  return null;
}
