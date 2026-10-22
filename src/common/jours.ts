/**
 * Durées « depuis N jours » comptées en jours du calendrier, à l'heure de Brazzaville :
 * un dossier arrivé hier à 23 h compte 1 jour aujourd'hui à 8 h (et non 0, comme le
 * ferait un calcul par tranches de 24 heures, ni un décalage dû à l'heure du serveur).
 */
export const FUSEAU = 'Africa/Brazzaville';

const formatJour = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSEAU,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** « AAAA-MM-JJ » du jour, à Brazzaville. */
export function jourLocal(d: Date = new Date()): string {
  return formatJour.format(d);
}

/** Nombre de jours du calendrier écoulés depuis cette date (null si absente ou illisible). */
export function joursDepuis(
  v: Date | string | null | undefined,
  maintenant: Date = new Date(),
): number | null {
  if (!v) return null;
  // Une date seule (« 2024-05-10 ») est déjà un jour du calendrier
  let jour: string;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) jour = v;
  else {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    jour = jourLocal(d);
  }
  const debut = Date.parse(`${jour}T00:00:00Z`);
  const fin = Date.parse(`${jourLocal(maintenant)}T00:00:00Z`);
  if (Number.isNaN(debut) || Number.isNaN(fin)) return null;
  return Math.round((fin - debut) / 86_400_000);
}

/**
 * Le même calcul en SQL (PostgreSQL), pour trier et filtrer sans tout charger :
 * jour du calendrier à Brazzaville d'une expression horodatée ou datée (texte ISO).
 */
export const sqlJourLocal = (expression: string) =>
  `((${expression})::timestamptz AT TIME ZONE '${FUSEAU}')::date`;
export const SQL_AUJOURDHUI = `(now() AT TIME ZONE '${FUSEAU}')::date`;
