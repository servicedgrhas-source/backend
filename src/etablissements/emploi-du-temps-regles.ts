/**
 * Génération de l'emploi du temps d'un collège ou d'un lycée (DG, 24/10/2026), sans base de
 * données pour être testée seule.
 *
 * 0. Plages horaires (DG, 28 et 30/10/2026) : ce que l'école a saisi pour un enseignant (le lundi
 *    07:30-08:25 en 6ème 1, ou à ses propres heures : 07:00-08:00) est placé tel quel, dans sa
 *    matière, à ses vraies heures. Une plage occupe tous les créneaux de l'école qu'elle touche (rien
 *    d'autre n'y est mis pour la classe ni pour lui) et compte autant d'heures que sa durée. Ces
 *    heures comptent dans le programme de la classe ; un enseignant qui a des plages n'a rien
 *    d'autre. Une plage qui chevauche, même de quelques minutes, une autre plage de la classe (un
 *    collègue) ou de l'enseignant est signalée, pas placée.
 * 1. Répartition du reste : chaque classe, pour chaque matière, reçoit un enseignant de la matière
 *    sans plages ; on donne d'abord les plus grosses charges, à l'enseignant le moins chargé, sans
 *    dépasser ses heures de la semaine. Sans enseignant possible, les heures restent « à pourvoir ».
 * 2. Placement : chaque heure va sur un créneau de la semaine où la classe, l'enseignant et la salle
 *    sont libres, dans les jours et heures de travail de l'enseignant ; la vague A le matin, la vague B
 *    l'après-midi ; pas plus de deux heures d'une matière par jour pour une classe, et les heures
 *    d'une matière réparties sur la semaine. Une heure qui ne trouve pas de place est signalée.
 */

export interface Creneau {
  debut: string;
  fin: string;
}
export interface ClasseEdt {
  id: number;
  nom: string;
  niveau: string;
  salleId: number | null;
}
export interface EnseignantEdt {
  id: number;
  nom: string;
  /** Matière enseignée (code du référentiel), d'après la spécialité de sa fiche. */
  matiere: string | null;
  /** Jours et heures de travail (1 = lundi) ; vide : tous les jours, toute la journée. */
  horaire: Record<string, { debut: string | null; fin: string | null }> | null;
  /** Plages horaires saisies par l'école (jour 1 = lundi, heures réelles) ; vide : réparti automatiquement. */
  plages?: { classeId: number; jour: number; debut: string; fin: string }[];
}
export interface Seance {
  classeId: number;
  classe: string;
  matiere: string;
  matiereLibelle: string;
  agentId: number | null;
  agent: string | null;
  jour: number;
  /** Ligne de la grille : le créneau de l'école où la séance commence (le plus couvert). */
  creneau: number;
  /** Plage saisie par l'école (sinon placée par le système). */
  fixe?: boolean;
  /** Heures réelles d'une plage saisie (07:00-08:00), si elles diffèrent du créneau. */
  debut?: string;
  fin?: string;
  /** Heures de cours que compte la séance (une plage de 07:30 à 09:20 : 2) ; vide : 1. */
  heures?: number;
}
export interface NonPlace {
  classe: string;
  matiere: string;
  matiereLibelle: string;
  heures: number;
  raison: string;
}
export interface ChargeEnseignant {
  agentId: number;
  agent: string;
  matiere: string | null;
  heures: number;
  classes: string[];
}
export interface ResultatEdt {
  seances: Seance[];
  nonPlaces: NonPlace[];
  charges: ChargeEnseignant[];
  heuresTotal: number;
  heuresPlacees: number;
}

const NOMS_JOURS = [
  '',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
];

const minutes = (h: string | null | undefined) => {
  const m = /^(\d{2}):(\d{2})$/.exec(h ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** Deux plages d'un même jour se chevauchent-elles (07:00-08:00 et 07:30-08:30 : oui ; 08:00-09:00 après 07:00-08:00 : non) ? */
export const seChevauchent = (
  a: { debut: string; fin: string },
  b: { debut: string; fin: string },
) => a.debut < b.fin && b.debut < a.fin;

/** Durée d'une heure de cours de l'école (la durée la plus courante de ses créneaux, 55 min). */
export function dureeHeure(creneaux: Creneau[]) {
  const d = creneaux
    .map((c) => (minutes(c.fin) ?? 0) - (minutes(c.debut) ?? 0))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 55;
}

/**
 * Où va une plage à ses heures réelles : les créneaux de l'école qu'elle touche (tous occupés), la
 * ligne de la grille où l'afficher (le créneau qu'elle couvre le plus ; sinon le plus proche), et
 * les heures de cours qu'elle compte (sa durée en heures de cours de l'école, au moins 1).
 */
export function placerPlage(
  creneaux: Creneau[],
  p: { debut: string; fin: string },
) {
  const d = minutes(p.debut) ?? 0;
  const f = minutes(p.fin) ?? 0;
  const recouvre = creneaux.map((c) =>
    Math.max(
      0,
      Math.min(f, minutes(c.fin) ?? 0) - Math.max(d, minutes(c.debut) ?? 0),
    ),
  );
  const couverts = recouvre.flatMap((x, i) => (x > 0 ? [i] : []));
  const ligne = couverts.length
    ? couverts.reduce(
        (m, i) => (recouvre[i] > recouvre[m] ? i : m),
        couverts[0],
      )
    : creneaux.reduce(
        (m, c, i) =>
          Math.abs((minutes(c.debut) ?? 0) - d) <
          Math.abs((minutes(creneaux[m].debut) ?? 0) - d)
            ? i
            : m,
        0,
      );
  return {
    couverts,
    ligne,
    heures: Math.max(1, Math.round((f - d) / dureeHeure(creneaux))),
  };
}
/** Un créneau du matin commence avant 13 h. */
export const estMatin = (c: Creneau) => (minutes(c.debut) ?? 0) < 13 * 60;
/** « 6ème 1A » : vague A (le matin), « 6ème 1B » : vague B (l'après-midi) ; sans lettre : une seule vague. */
export const vagueDe = (nomClasse: string) =>
  /\d([AB])$/i.exec(nomClasse.trim())?.[1]?.toUpperCase() ?? null;

/** « 07:30-08:25, 08:25-09:20 » → créneaux, dans l'ordre. */
export function lireCreneaux(texte: string): Creneau[] {
  return texte
    .split(/[,;\n]+/)
    .map((x) => /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(x))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({
      debut: `${m[1].padStart(2, '0')}:${m[2]}`,
      fin: `${m[3].padStart(2, '0')}:${m[4]}`,
    }))
    .filter((c) => c.fin > c.debut)
    .sort((a, b) => a.debut.localeCompare(b.debut));
}

export function genererEmploiDuTemps(e: {
  classes: ClasseEdt[];
  /** Heures par semaine de chaque matière, par niveau. */
  programme: Map<string, { matiere: string; heures: number }[]>;
  libelles: Map<string, string>;
  enseignants: EnseignantEdt[];
  jours: number[];
  creneaux: Creneau[];
  /** Heures de cours d'un enseignant par semaine (au plus). */
  heuresEnseignant: number;
}): ResultatEdt {
  const lib = (m: string) => e.libelles.get(m) ?? m;
  const nonPlaces: NonPlace[] = [];
  const charges = new Map<number, ChargeEnseignant>(
    e.enseignants.map((t) => [
      t.id,
      {
        agentId: t.id,
        agent: t.nom,
        matiere: t.matiere,
        heures: 0,
        classes: [],
      },
    ]),
  );
  const occupe = new Set<string>(); // « C:classe:jour:créneau », « A:agent:… », « S:salle:… »
  const parJour = new Map<string, number>(); // heures d'une matière, par classe et par jour
  const chargeJour = new Map<string, number>(); // heures d'une classe par jour
  const seances: Seance[] = [];
  const occuper = (
    classe: ClasseEdt,
    matiere: string,
    agent: EnseignantEdt | null,
    jour: number,
    i: number,
    fixe: boolean,
    /** Plage à ses heures réelles : les créneaux qu'elle touche, et ce qu'elle compte. */
    plage?: { debut: string; fin: string; couverts: number[]; heures: number },
  ) => {
    for (const j of plage ? plage.couverts : [i]) {
      const k = `${jour}:${j}`;
      occupe.add(`C:${classe.id}:${k}`);
      if (agent) occupe.add(`A:${agent.id}:${k}`);
      if (classe.salleId) occupe.add(`S:${classe.salleId}:${k}`);
    }
    const n = plage?.heures ?? 1;
    const kj = `${classe.id}:${matiere}:${jour}`;
    parJour.set(kj, (parJour.get(kj) ?? 0) + n);
    const kc = `${classe.id}:${jour}`;
    chargeJour.set(kc, (chargeJour.get(kc) ?? 0) + n);
    const c = e.creneaux[i];
    seances.push({
      classeId: classe.id,
      classe: classe.nom,
      matiere,
      matiereLibelle: lib(matiere),
      agentId: agent?.id ?? null,
      agent: agent?.nom ?? null,
      jour,
      creneau: i,
      ...(fixe ? { fixe: true } : {}),
      // Heures propres de la plage (si elles diffèrent du créneau) et ce qu'elle compte
      ...(plage && (plage.debut !== c?.debut || plage.fin !== c?.fin)
        ? { debut: plage.debut, fin: plage.fin }
        : {}),
      ...(n !== 1 ? { heures: n } : {}),
    });
  };
  const quand = (jour: number, p: { debut: string; fin: string }) =>
    `${NOMS_JOURS[jour] ?? `jour ${jour}`} ${p.debut}-${p.fin}`;
  /** Plages déjà placées, à leurs heures réelles : on y cherche les chevauchements. */
  const placees: {
    classeId: number;
    agentId: number;
    agent: string;
    classe: string;
    jour: number;
    debut: string;
    fin: string;
  }[] = [];

  // 0. Plages horaires saisies par l'école : placées telles quelles
  const parId = new Map(e.classes.map((c) => [c.id, c]));
  const fixes = new Map<string, number>(); // heures saisies, par « classe|matière »
  const qui = new Map<string, string>(); // l'enseignant de ces plages, par « classe|matière »
  for (const t of e.enseignants) {
    if (!t.plages?.length) continue;
    const ch = charges.get(t.id)!;
    if (!t.matiere) {
      nonPlaces.push({
        classe: '—',
        matiere: '',
        matiereLibelle: t.nom,
        heures: t.plages.length,
        raison:
          'plages horaires saisies, mais sa matière n’est pas connue : écrivez sa spécialité dans sa fiche pour qu’elles soient placées',
      });
      continue;
    }
    const matiere = t.matiere;
    for (const p of t.plages) {
      const classe = parId.get(p.classeId);
      const d = minutes(p.debut);
      const f = minutes(p.fin);
      if (
        !classe ||
        !e.jours.includes(p.jour) ||
        d === null ||
        f === null ||
        f <= d ||
        !e.creneaux.length
      ) {
        nonPlaces.push({
          classe: classe?.nom ?? '—',
          matiere,
          matiereLibelle: t.nom,
          heures: 1,
          raison: !classe
            ? 'plage dans une classe fermée ou d’une autre année : à saisir à nouveau'
            : !e.jours.includes(p.jour)
              ? `plage du ${quand(p.jour, p)} un jour sans cours (réglages changés ?) : à saisir à nouveau`
              : `plage du ${quand(p.jour, p)} aux heures mal écrites : à saisir à nouveau`,
        });
        continue;
      }
      // Lui-même : deux plages qui se chevauchent (la même saisie deux fois : ignorée)
      const lui = placees.find(
        (x) => x.agentId === t.id && x.jour === p.jour && seChevauchent(x, p),
      );
      if (lui) {
        if (!(
          lui.classeId === classe.id &&
          lui.debut === p.debut &&
          lui.fin === p.fin
        ))
          nonPlaces.push({
            classe: classe.nom,
            matiere,
            matiereLibelle: t.nom,
            heures: 1,
            raison: `le ${quand(p.jour, p)}, il a déjà cours en ${lui.classe} de ${lui.debut} à ${lui.fin} : les heures se chevauchent, cette plage n’est pas placée`,
          });
        continue;
      }
      // La classe : un collègue qui y a déjà cours à une heure qui chevauche
      const autre = placees.find(
        (x) =>
          x.classeId === classe.id && x.jour === p.jour && seChevauchent(x, p),
      );
      if (autre) {
        nonPlaces.push({
          classe: classe.nom,
          matiere,
          matiereLibelle: t.nom,
          heures: 1,
          raison: `le ${quand(p.jour, p)}, la classe a déjà cours avec ${autre.agent} de ${autre.debut} à ${autre.fin} : les heures se chevauchent, cette plage n’est pas placée`,
        });
        continue;
      }
      const pl = placerPlage(e.creneaux, p);
      occuper(classe, matiere, t, p.jour, pl.ligne, true, {
        debut: hhmm(d),
        fin: hhmm(f),
        couverts: pl.couverts,
        heures: pl.heures,
      });
      placees.push({
        classeId: classe.id,
        agentId: t.id,
        agent: t.nom,
        classe: classe.nom,
        jour: p.jour,
        debut: hhmm(d),
        fin: hhmm(f),
      });
      ch.heures += pl.heures;
      if (!ch.classes.includes(classe.nom)) ch.classes.push(classe.nom);
      const kf = `${classe.id}|${matiere}`;
      fixes.set(kf, (fixes.get(kf) ?? 0) + pl.heures);
      qui.set(kf, t.nom);
    }
    if (ch.heures > e.heuresEnseignant)
      nonPlaces.push({
        classe: '—',
        matiere,
        matiereLibelle: t.nom,
        heures: 0,
        raison: `${ch.heures} h saisies dans ses plages, plus que les ${e.heuresEnseignant} h d’un enseignant par semaine`,
      });
  }
  // Plages au-delà du programme de la classe (ou dans une matière hors programme) : c'est dit
  for (const [kf, n] of fixes) {
    const [id, matiere] = kf.split('|');
    const classe = parId.get(Number(id))!;
    const prevu = Math.round(
      (e.programme.get(classe.niveau) ?? []).find((p) => p.matiere === matiere)
        ?.heures ?? 0,
    );
    if (n > prevu)
      nonPlaces.push({
        classe: classe.nom,
        matiere,
        matiereLibelle: lib(matiere),
        heures: n - prevu,
        raison: prevu
          ? `${n} h saisies dans les plages pour ${prevu} h au programme : ${n - prevu} h de plus que le programme`
          : `${n} h saisies dans les plages, mais ${lib(matiere)} n’est pas au programme de ce niveau`,
      });
  }

  // 1. Répartition du reste (classe × matière) entre les enseignants de la matière sans plages
  const lots: {
    classe: ClasseEdt;
    matiere: string;
    heures: number;
    agent: EnseignantEdt | null;
    /** Le reste d'une matière dont l'école a saisi des plages dans la classe : pas d'autre enseignant. */
    complement?: string;
  }[] = [];
  for (const c of e.classes)
    for (const p of e.programme.get(c.niveau) ?? []) {
      const reste =
        Math.round(p.heures) - (fixes.get(`${c.id}|${p.matiere}`) ?? 0);
      if (p.heures > 0 && reste > 0)
        lots.push({
          classe: c,
          matiere: p.matiere,
          heures: reste,
          agent: null,
          complement: qui.get(`${c.id}|${p.matiere}`),
        });
    }
  lots.sort(
    (a, b) => b.heures - a.heures || a.classe.nom.localeCompare(b.classe.nom),
  );
  const avecPlages = (t: EnseignantEdt) => !!t.plages?.length;
  for (const l of lots) {
    // Une classe a un seul enseignant par matière : le reste ne va pas à un autre
    if (l.complement) continue;
    const possibles = e.enseignants
      .filter((t) => t.matiere === l.matiere && !avecPlages(t))
      .filter((t) => charges.get(t.id)!.heures + l.heures <= e.heuresEnseignant)
      .sort(
        (a, b) =>
          charges.get(a.id)!.heures - charges.get(b.id)!.heures ||
          a.nom.localeCompare(b.nom),
      );
    const t = possibles[0] ?? null;
    if (t) {
      l.agent = t;
      const ch = charges.get(t.id)!;
      ch.heures += l.heures;
      ch.classes.push(l.classe.nom);
    }
  }

  // 2. Placement heure par heure, autour des plages déjà placées
  const disponible = (t: EnseignantEdt | null, jour: number, c: Creneau) => {
    if (!t?.horaire || !Object.keys(t.horaire).length) return true;
    const h = t.horaire[String(jour)];
    if (!h) return false;
    const d = minutes(h.debut);
    const f = minutes(h.fin);
    return (
      (d === null || (minutes(c.debut) ?? 0) >= d) &&
      (f === null || (minutes(c.fin) ?? 0) <= f)
    );
  };
  // Les enseignants les plus chargés d'abord : ce sont eux qui ont le moins de place
  const ordre = [...lots].sort(
    (a, b) =>
      Number(!!b.agent) - Number(!!a.agent) ||
      (b.agent ? charges.get(b.agent.id)!.heures : 0) -
        (a.agent ? charges.get(a.agent.id)!.heures : 0) ||
      b.heures - a.heures,
  );
  for (const l of ordre) {
    const vague = vagueDe(l.classe.nom);
    let restant = l.heures;
    for (let n = 0; n < l.heures; n++) {
      let meilleur: { jour: number; i: number; score: number } | null = null;
      for (const jour of e.jours)
        e.creneaux.forEach((c, i) => {
          if (vague === 'A' && !estMatin(c)) return;
          if (vague === 'B' && estMatin(c)) return;
          // Samedi : la matinée seulement
          if (jour === 6 && !estMatin(c)) return;
          const k = `${jour}:${i}`;
          if (occupe.has(`C:${l.classe.id}:${k}`)) return;
          if (l.agent && occupe.has(`A:${l.agent.id}:${k}`)) return;
          if (l.classe.salleId && occupe.has(`S:${l.classe.salleId}:${k}`))
            return;
          if (!disponible(l.agent, jour, c)) return;
          const dejaCeJour =
            parJour.get(`${l.classe.id}:${l.matiere}:${jour}`) ?? 0;
          if (dejaCeJour >= 2) return;
          // Préférences : répartir la matière sur la semaine, équilibrer les journées de la
          // classe, deux heures d'une matière plutôt à la suite, le matin plutôt que le soir
          const suite =
            dejaCeJour > 0 &&
            [i - 1, i + 1].some((j) =>
              seances.some(
                (s) =>
                  s.classeId === l.classe.id &&
                  s.matiere === l.matiere &&
                  s.jour === jour &&
                  s.creneau === j,
              ),
            );
          const score =
            dejaCeJour * 100 -
            (suite ? 60 : 0) +
            (chargeJour.get(`${l.classe.id}:${jour}`) ?? 0) * 10 +
            (estMatin(c) ? 0 : 5) +
            i * 0.1;
          if (!meilleur || score < meilleur.score)
            meilleur = { jour, i, score };
        });
      if (!meilleur) break;
      const m = meilleur as { jour: number; i: number };
      occuper(l.classe, l.matiere, l.agent, m.jour, m.i, false);
      restant--;
    }
    if (!l.agent) {
      const deLaMatiere = e.enseignants.filter((t) => t.matiere === l.matiere);
      nonPlaces.push({
        classe: l.classe.nom,
        matiere: l.matiere,
        matiereLibelle: lib(l.matiere),
        heures: l.heures,
        raison: l.complement
          ? `${l.complement} a des plages dans cette classe, mais il manque ${l.heures} h du programme : complétez ses plages horaires (sinon elles restent « à pourvoir »)`
          : !deLaMatiere.length
            ? `aucun enseignant de ${lib(l.matiere)} dans l’école : heures « à pourvoir », enseignant à trouver`
            : deLaMatiere.every(avecPlages)
              ? `les plages horaires des enseignants de ${lib(l.matiere)} ne couvrent pas ces heures : ajoutez-les à la plage d’un enseignant, sinon elles restent « à pourvoir »`
              : `les enseignants de ${lib(l.matiere)} de l’école n’ont plus assez d’heures libres (${e.heuresEnseignant} h au plus chacun) : heures « à pourvoir », enseignant à trouver`,
      });
    }
    if (restant > 0)
      nonPlaces.push({
        classe: l.classe.nom,
        matiere: l.matiere,
        matiereLibelle: lib(l.matiere),
        heures: restant,
        raison:
          'Plus de créneau libre (classe, enseignant ou salle déjà pris, jours de travail de l’enseignant)',
      });
  }
  // Assez de créneaux dans la semaine pour le programme de chaque classe ? (vague B : l'après-midi
  // seulement, sans le samedi) : sinon, ce n'est pas un manque d'enseignant mais de créneaux
  const capacite = (vague: string | null) =>
    e.jours.reduce(
      (t, jour) =>
        t +
        e.creneaux.filter(
          (c) =>
            !(vague === 'A' && !estMatin(c)) &&
            !(vague === 'B' && estMatin(c)) &&
            !(jour === 6 && !estMatin(c)),
        ).length,
      0,
    );
  const besoinClasse = new Map<number, number>();
  for (const l of lots)
    besoinClasse.set(
      l.classe.id,
      (besoinClasse.get(l.classe.id) ?? 0) + l.heures,
    );
  for (const [kf, n] of fixes) {
    const id = Number(kf.split('|')[0]);
    besoinClasse.set(id, (besoinClasse.get(id) ?? 0) + n);
  }
  const manques: NonPlace[] = [];
  for (const c of e.classes) {
    const v = vagueDe(c.nom);
    const cap = capacite(v);
    const h = besoinClasse.get(c.id) ?? 0;
    if (h > cap)
      manques.push({
        classe: c.nom,
        matiere: '',
        matiereLibelle: 'Créneaux de la semaine',
        heures: 0,
        raison: `${h} h de programme mais seulement ${cap} créneaux par semaine${v === 'B' ? ' l’après-midi (vague B)' : v === 'A' ? ' le matin (vague A)' : ''} : ${h - cap} h ne peuvent pas être placées ; ajoutez des créneaux ou des jours dans Administration › Paramètres (emplois du temps)`,
      });
  }
  // Une classe dont le niveau n'a pas de programme ne reçoit aucune heure : on le dit
  for (const c of e.classes)
    if (!(e.programme.get(c.niveau) ?? []).some((p) => p.heures > 0))
      manques.push({
        classe: c.nom,
        matiere: '',
        matiereLibelle: 'Programme',
        heures: 0,
        raison: `aucun programme (heures par matière) pour le niveau « ${c.niveau} » : la classe n’a aucun cours ; ajoutez-le dans Administration › Référentiels › Programmes, ou corrigez le niveau de la classe`,
      });
  nonPlaces.unshift(...manques);
  // Dans l'ordre des heures réelles (une plage à 07:00 avant le créneau de 07:30)
  const heureDe = (x: Seance) => x.debut ?? e.creneaux[x.creneau]?.debut ?? '';
  seances.sort(
    (a, b) =>
      a.classe.localeCompare(b.classe) ||
      a.jour - b.jour ||
      heureDe(a).localeCompare(heureDe(b)),
  );
  const heuresTotal =
    lots.reduce((s, l) => s + l.heures, 0) +
    [...fixes.values()].reduce((s, n) => s + n, 0);
  return {
    seances,
    nonPlaces,
    charges: [...charges.values()].sort(
      (a, b) => b.heures - a.heures || a.agent.localeCompare(b.agent),
    ),
    heuresTotal,
    heuresPlacees: seances.reduce((n, x) => n + (x.heures ?? 1), 0),
  };
}
