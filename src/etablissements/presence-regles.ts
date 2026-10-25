/**
 * Règles de la présence (DG, 24/10/2026), sans base de données pour être testées seules :
 * le retard se lit sur l'heure d'arrivée, et trois alertes tombent en fin de semaine.
 * 1. absent plus de la moitié des jours où il est attendu ;
 * 2. moins de la moitié des heures prévues dans la semaine ;
 * 3. deux semaines d'affilée sans travailler (la première peut être une maladie, la deuxième
 *    oblige à s'interroger sur sa situation).
 */

export type Horaire = Record<
  string,
  { debut: string | null; fin: string | null }
>;
export interface Pointage {
  statut: string;
  arrivee?: string | null;
  depart?: string | null;
}

/** Sans horaire saisi : attendu du lundi au vendredi. */
export const JOURS_DEFAUT = [1, 2, 3, 4, 5];
export const ABSENCES = ['ABSENT', 'ABSENT_JUSTIFIE'];

/** « 07:45 » → 465 minutes. */
export const minutes = (h: string | null | undefined) => {
  const m = /^(\d{2}):(\d{2})$/.exec(h ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/** 465 → « 7 h 45 », 480 → « 8 h ». */
export const heures = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
};

/** Jours attendus d'un agent (1 = lundi … 6 = samedi). */
export function joursAttendus(h: Horaire | null | undefined) {
  if (!h || !Object.keys(h).length) return JOURS_DEFAUT;
  return Object.keys(h)
    .map(Number)
    .filter((j) => j >= 1 && j <= 6);
}

/** Minutes de retard d'une arrivée sur l'heure prévue du jour (0 : à l'heure ; null : inconnu). */
export function retard(
  h: Horaire | null | undefined,
  jour: number,
  arrivee: string | null | undefined,
) {
  const prevu = minutes(h?.[String(jour)]?.debut);
  const venu = minutes(arrivee);
  if (prevu === null || venu === null) return null;
  return Math.max(0, venu - prevu);
}

export interface BilanSemaine {
  joursAttendus: number;
  joursAbsent: number;
  /** Minutes prévues (jours attendus qui ont leurs heures) ; null : horaires inconnus. */
  minutesPrevues: number | null;
  minutesFaites: number | null;
  minutesRetard: number;
  alertes: { code: 'JOURS' | 'HEURES' | 'DEUX_SEMAINES'; texte: string }[];
}

/**
 * Bilan d'une semaine d'un agent : `dates[i]` est le jour i+1 (lundi = 1) ; `semaine` les
 * pointages de la semaine par date, `precedente` ceux de la semaine d'avant (même agent, mêmes
 * jours attendus) pour la troisième alerte.
 */
export function bilanSemaine(
  h: Horaire | null | undefined,
  dates: string[],
  semaine: Record<string, Pointage>,
  precedente?: { dates: string[]; pointages: Record<string, Pointage> },
): BilanSemaine {
  const attendus = joursAttendus(h);
  let joursAbsent = 0;
  let prevues = 0;
  let faites = 0;
  let avecHeures = false;
  let minutesRetard = 0;
  for (const j of attendus) {
    const p = semaine[dates[j - 1]];
    const debut = minutes(h?.[String(j)]?.debut);
    const fin = minutes(h?.[String(j)]?.fin);
    const duree =
      debut !== null && fin !== null && fin > debut ? fin - debut : null;
    if (duree !== null) {
      prevues += duree;
      avecHeures = true;
    }
    if (!p || ABSENCES.includes(p.statut)) {
      if (p) joursAbsent++;
      continue;
    }
    const arr = minutes(p.arrivee);
    const dep = minutes(p.depart);
    // Présent sans heures notées : on compte la journée prévue
    if (arr !== null && dep !== null && dep > arr) faites += dep - arr;
    else if (duree !== null) {
      const venu = arr ?? debut!;
      const parti = dep ?? fin!;
      faites += Math.max(0, Math.min(parti, fin!) - Math.max(venu, debut!));
    }
    minutesRetard += retard(h, j, p.arrivee) ?? 0;
  }
  const alertes: BilanSemaine['alertes'] = [];
  if (attendus.length && joursAbsent > attendus.length / 2)
    alertes.push({
      code: 'JOURS',
      texte: `Absent ${joursAbsent} jour(s) sur ${attendus.length} attendu(s) : plus de la moitié de la semaine`,
    });
  if (avecHeures && faites < prevues / 2)
    alertes.push({
      code: 'HEURES',
      texte: `${heures(faites)} faites sur ${heures(prevues)} prévues : moins de la moitié des heures`,
    });
  const touteLaSemaine = (dts: string[], pts: Record<string, Pointage>) =>
    attendus.length > 0 &&
    attendus.every((j) => {
      const p = pts[dts[j - 1]];
      return !!p && ABSENCES.includes(p.statut);
    });
  if (
    precedente &&
    touteLaSemaine(dates, semaine) &&
    touteLaSemaine(precedente.dates, precedente.pointages)
  )
    alertes.push({
      code: 'DEUX_SEMAINES',
      texte:
        'Deux semaines d’affilée sans travailler : sa situation est à vérifier',
    });
  return {
    joursAttendus: attendus.length,
    joursAbsent,
    minutesPrevues: avecHeures ? prevues : null,
    minutesFaites: avecHeures ? faites : null,
    minutesRetard,
    alertes,
  };
}
