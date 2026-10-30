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

/**
 * Minutes de retard d'une arrivée sur l'heure prévue du jour (0 : à l'heure ; null : inconnu).
 * La tolérance (le temps des formalités, réglable) : arrivé dans la marge, il est à l'heure ; au-delà,
 * le retard compte depuis l'heure prévue (arrivé à 8 h 25 pour 8 h, avec 10 min de marge : 25 min).
 */
export function retard(
  h: Horaire | null | undefined,
  jour: number,
  arrivee: string | null | undefined,
  tolerance = 0,
) {
  const prevu = minutes(h?.[String(jour)]?.debut);
  const venu = minutes(arrivee);
  if (prevu === null || venu === null) return null;
  return venu - prevu > tolerance ? venu - prevu : 0;
}

/* ------------------------------ Présence « comme une vraie école » (DG, 30/10/2026) ------------------------------ */

/** Marges et seuils réglables (Paramètres de la présence). */
export interface ReglagesPresence {
  toleranceArrivee: number;
  toleranceDepart: number;
  /** Retard important (minutes) : « 1 h de retard ou plus ». */
  retardGrave: number;
  /** À partir de ce nombre de retards sur la période : « souvent en retard ». */
  retardsFrequents: number;
  /** À partir de ce nombre d'absences non justifiées : « souvent absent ». */
  absencesFrequentes: number;
  /** Heures par défaut, du lundi au vendredi (« 07:30 », « 14:00 »). */
  debutDefaut: string;
  finDefaut: string;
}

/** Un cours de l'emploi du temps de l'agent ce jour-là. */
export interface Cours {
  debut: string;
  fin: string;
  libelle: string;
}
/** Cours de la semaine, par jour (« 1 » = lundi). */
export type CoursSemaine = Record<string, Cours[]>;

export type SourceHoraire = 'EDT' | 'HORAIRE' | 'DEFAUT';

/**
 * Heures attendues d'un agent, jour par jour : pour un enseignant qui a des cours, son emploi du
 * temps (du début de son premier cours à la fin de son dernier) ; sinon les jours et heures saisis
 * par son chef ; sinon les heures par défaut, du lundi au vendredi.
 */
export function horaireEffectif(
  h: Horaire | null | undefined,
  cours: CoursSemaine | null | undefined,
  r: Pick<ReglagesPresence, 'debutDefaut' | 'finDefaut'>,
): { jours: Horaire; source: SourceHoraire } {
  const jours = Object.entries(cours ?? {}).filter(([, l]) => l.length);
  if (jours.length)
    return {
      source: 'EDT',
      jours: Object.fromEntries(
        jours.map(([j, l]) => [
          j,
          {
            debut: [...l].sort((a, b) => a.debut.localeCompare(b.debut))[0]
              .debut,
            fin: [...l].sort((a, b) => b.fin.localeCompare(a.fin))[0].fin,
          },
        ]),
      ),
    };
  if (h && Object.keys(h).length) return { source: 'HORAIRE', jours: h };
  return {
    source: 'DEFAUT',
    jours: Object.fromEntries(
      JOURS_DEFAUT.map((j) => [
        String(j),
        { debut: r.debutDefaut, fin: r.finDefaut },
      ]),
    ),
  };
}

export interface AnalyseJour {
  /** Minutes de retard (0 : à l'heure ou dans la marge ; null : heure d'arrivée inconnue). */
  retard: number | null;
  /** Retard important (au moins le seuil réglé, 1 h par défaut). */
  retardGrave: boolean;
  /** Minutes de départ avant la fin prévue (au-delà de la marge) ; 0 sinon. */
  departAnticipe: number;
  /** Cours (ou morceaux de cours) où il n'était pas là : arrivé après, ou parti avant. */
  coursManques: (Cours & { minutes: number })[];
  minutesCoursPerdues: number;
}

/**
 * Une journée d'un agent venu : son retard sur l'heure prévue, son départ anticipé, et pour un
 * enseignant les cours qu'il n'a pas faits en entier (on compare ses heures d'arrivée et de départ
 * à chaque cours de son emploi du temps). Sans heure notée, on le suppose là toute la journée.
 */
export function analyseJour(
  prevu: { debut: string | null; fin: string | null } | null | undefined,
  cours: Cours[],
  p: Pointage,
  r: Pick<
    ReglagesPresence,
    'toleranceArrivee' | 'toleranceDepart' | 'retardGrave'
  >,
): AnalyseJour {
  const vide: AnalyseJour = {
    retard: null,
    retardGrave: false,
    departAnticipe: 0,
    coursManques: [],
    minutesCoursPerdues: 0,
  };
  if (ABSENCES.includes(p.statut)) return vide;
  const debut = minutes(prevu?.debut);
  const fin = minutes(prevu?.fin);
  const arr = minutes(p.arrivee);
  const dep = minutes(p.depart);
  const enRetard =
    debut !== null && arr !== null
      ? arr - debut > r.toleranceArrivee
        ? arr - debut
        : 0
      : null;
  const departAnticipe =
    fin !== null && dep !== null && fin - dep > r.toleranceDepart
      ? fin - dep
      : 0;
  const coursManques: AnalyseJour['coursManques'] = [];
  for (const c of cours) {
    const cd = minutes(c.debut);
    const cf = minutes(c.fin);
    if (cd === null || cf === null || cf <= cd) continue;
    // Présent de son arrivée à son départ (la marge d'arrivée ne compte pas comme un cours manqué)
    const la = arr !== null && enRetard ? arr : cd;
    const parti = dep !== null && departAnticipe ? dep : cf;
    const fait = Math.max(0, Math.min(cf, parti) - Math.max(cd, la));
    const manque = cf - cd - fait;
    if (manque > 0) coursManques.push({ ...c, minutes: manque });
  }
  return {
    retard: enRetard,
    retardGrave: (enRetard ?? 0) >= r.retardGrave,
    departAnticipe,
    coursManques,
    minutesCoursPerdues: coursManques.reduce((s, c) => s + c.minutes, 0),
  };
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
  toleranceArrivee = 0,
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
    minutesRetard += retard(h, j, p.arrivee, toleranceArrivee) ?? 0;
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
