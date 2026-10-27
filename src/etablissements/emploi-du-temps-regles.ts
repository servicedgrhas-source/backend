/**
 * Génération de l'emploi du temps d'un collège ou d'un lycée (DG, 24/10/2026), sans base de
 * données pour être testée seule.
 *
 * 1. Répartition : chaque classe, pour chaque matière, reçoit un enseignant de la matière ; on
 *    donne d'abord les plus grosses charges, à l'enseignant le moins chargé, sans dépasser ses heures
 *    de la semaine. Sans enseignant possible, les heures restent « à pourvoir » (le déficit).
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
}
export interface Seance {
  classeId: number;
  classe: string;
  matiere: string;
  matiereLibelle: string;
  agentId: number | null;
  agent: string | null;
  jour: number;
  creneau: number;
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

const minutes = (h: string | null | undefined) => {
  const m = /^(\d{2}):(\d{2})$/.exec(h ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
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
  // 1. Répartition des charges (classe × matière) entre les enseignants de la matière
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
  const lots: {
    classe: ClasseEdt;
    matiere: string;
    heures: number;
    agent: EnseignantEdt | null;
  }[] = [];
  for (const c of e.classes)
    for (const p of e.programme.get(c.niveau) ?? [])
      if (p.heures > 0)
        lots.push({
          classe: c,
          matiere: p.matiere,
          heures: Math.round(p.heures),
          agent: null,
        });
  lots.sort(
    (a, b) => b.heures - a.heures || a.classe.nom.localeCompare(b.classe.nom),
  );
  for (const l of lots) {
    const possibles = e.enseignants
      .filter((t) => t.matiere === l.matiere)
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

  // 2. Placement heure par heure
  const occupe = new Set<string>(); // « C:classe:jour:créneau », « A:agent:… », « S:salle:… »
  const parJour = new Map<string, number>(); // heures d'une matière, par classe et par jour
  const chargeJour = new Map<string, number>(); // heures d'une classe par jour
  const seances: Seance[] = [];
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
      const k = `${m.jour}:${m.i}`;
      occupe.add(`C:${l.classe.id}:${k}`);
      if (l.agent) occupe.add(`A:${l.agent.id}:${k}`);
      if (l.classe.salleId) occupe.add(`S:${l.classe.salleId}:${k}`);
      const kj = `${l.classe.id}:${l.matiere}:${m.jour}`;
      parJour.set(kj, (parJour.get(kj) ?? 0) + 1);
      chargeJour.set(
        `${l.classe.id}:${m.jour}`,
        (chargeJour.get(`${l.classe.id}:${m.jour}`) ?? 0) + 1,
      );
      seances.push({
        classeId: l.classe.id,
        classe: l.classe.nom,
        matiere: l.matiere,
        matiereLibelle: lib(l.matiere),
        agentId: l.agent?.id ?? null,
        agent: l.agent?.nom ?? null,
        jour: m.jour,
        creneau: m.i,
      });
      restant--;
    }
    if (!l.agent)
      nonPlaces.push({
        classe: l.classe.nom,
        matiere: l.matiere,
        matiereLibelle: lib(l.matiere),
        heures: l.heures,
        raison: e.enseignants.some((t) => t.matiere === l.matiere)
          ? `Les enseignants de ${lib(l.matiere)} ont déjà leurs ${e.heuresEnseignant} h : enseignant à trouver`
          : `Aucun enseignant de ${lib(l.matiere)} dans l’école : enseignant à trouver`,
      });
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
  nonPlaces.unshift(...manques);
  seances.sort(
    (a, b) =>
      a.classe.localeCompare(b.classe) ||
      a.jour - b.jour ||
      a.creneau - b.creneau,
  );
  const heuresTotal = lots.reduce((s, l) => s + l.heures, 0);
  return {
    seances,
    nonPlaces,
    charges: [...charges.values()].sort(
      (a, b) => b.heures - a.heures || a.agent.localeCompare(b.agent),
    ),
    heuresTotal,
    heuresPlacees: seances.length,
  };
}
