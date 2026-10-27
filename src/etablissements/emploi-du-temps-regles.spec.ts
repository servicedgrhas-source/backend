import {
  genererEmploiDuTemps,
  lireCreneaux,
  vagueDe,
  type EnseignantEdt,
} from './emploi-du-temps-regles';

const creneaux = lireCreneaux(
  '07:30-08:25, 08:25-09:20, 09:20-10:15, 10:30-11:25, 11:25-12:20, 15:00-15:55, 15:55-16:50, 16:50-17:45',
);
const programme = new Map([
  [
    '6EME',
    [
      { matiere: 'FR', heures: 6 },
      { matiere: 'MATH', heures: 5 },
      { matiere: 'ANG', heures: 3 },
    ],
  ],
]);
const libelles = new Map([
  ['FR', 'Français'],
  ['MATH', 'Mathématiques'],
  ['ANG', 'Anglais'],
]);
const prof = (
  id: number,
  matiere: string,
  horaire: EnseignantEdt['horaire'] = null,
): EnseignantEdt => ({
  id,
  nom: `Prof ${id}`,
  matiere,
  horaire,
});

describe('Emploi du temps (DG, 24/10/2026)', () => {
  it('lit les créneaux et la vague d’une classe', () => {
    expect(creneaux).toHaveLength(8);
    expect(vagueDe('6ème 1A')).toBe('A');
    expect(vagueDe('6ème 1')).toBeNull();
  });

  const r = genererEmploiDuTemps({
    classes: [
      { id: 1, nom: '6ème 1', niveau: '6EME', salleId: 10 },
      { id: 2, nom: '6ème 2', niveau: '6EME', salleId: 11 },
    ],
    programme,
    libelles,
    enseignants: [prof(100, 'FR'), prof(101, 'MATH'), prof(102, 'MATH')],
    jours: [1, 2, 3, 4, 5, 6],
    creneaux,
    heuresEnseignant: 20,
  });

  it('place toutes les heures pourvues, sans conflit', () => {
    const cles = new Set<string>();
    for (const s of r.seances) {
      for (const k of [
        `C${s.classeId}:${s.jour}:${s.creneau}`,
        ...(s.agentId ? [`A${s.agentId}:${s.jour}:${s.creneau}`] : []),
      ]) {
        expect(cles.has(k)).toBe(false);
        cles.add(k);
      }
    }
    expect(r.heuresTotal).toBe(28);
    expect(r.heuresPlacees).toBe(28);
  });

  it('un enseignant de français pour les deux classes (12 h), les maths réparties entre deux', () => {
    expect(r.charges.find((c) => c.agentId === 100)?.heures).toBe(12);
    expect(
      r.charges.filter((c) => c.matiere === 'MATH').map((c) => c.heures),
    ).toEqual([5, 5]);
  });

  it('l’anglais sans enseignant reste « à pourvoir », placé quand même dans la classe', () => {
    expect(r.nonPlaces.filter((x) => x.matiere === 'ANG')).toHaveLength(2);
    expect(
      r.seances.filter((s) => s.matiere === 'ANG' && s.agentId === null),
    ).toHaveLength(6);
  });

  it('au plus deux heures d’une matière par jour pour une classe, samedi matin seulement', () => {
    const n = new Map<string, number>();
    for (const s of r.seances) {
      const k = `${s.classeId}:${s.matiere}:${s.jour}`;
      n.set(k, (n.get(k) ?? 0) + 1);
      if (s.jour === 6) expect(creneaux[s.creneau].debut < '13:00').toBe(true);
    }
    expect(Math.max(...n.values())).toBeLessThanOrEqual(2);
  });

  it('un enseignant plein (20 h) ne reçoit pas plus ; ses jours de travail sont respectés', () => {
    const r2 = genererEmploiDuTemps({
      classes: [1, 2, 3, 4].map((i) => ({
        id: i,
        nom: `6ème ${i}`,
        niveau: '6EME',
        salleId: null,
      })),
      programme: new Map([['6EME', [{ matiere: 'FR', heures: 6 }]]]),
      libelles,
      enseignants: [
        prof(100, 'FR', {
          1: { debut: '07:30', fin: '12:20' },
          2: { debut: '07:30', fin: '12:20' },
          4: { debut: '07:30', fin: '12:20' },
        }),
      ],
      jours: [1, 2, 3, 4, 5],
      creneaux,
      heuresEnseignant: 20,
    });
    expect(r2.charges[0].heures).toBe(18);
    expect(r2.nonPlaces.some((x) => /déjà leurs 20 h/.test(x.raison))).toBe(
      true,
    );
    expect(
      r2.seances
        .filter((s) => s.agentId === 100)
        .every((s) => [1, 2, 4].includes(s.jour) && s.creneau <= 4),
    ).toBe(true);
  });

  it('deux vagues dans la même salle : A le matin, B l’après-midi', () => {
    const r3 = genererEmploiDuTemps({
      classes: [
        { id: 1, nom: '6ème 1A', niveau: '6EME', salleId: 9 },
        { id: 2, nom: '6ème 1B', niveau: '6EME', salleId: 9 },
      ],
      programme: new Map([['6EME', [{ matiere: 'FR', heures: 4 }]]]),
      libelles,
      enseignants: [prof(100, 'FR')],
      jours: [1, 2, 3, 4, 5],
      creneaux,
      heuresEnseignant: 20,
    });
    expect(
      r3.seances
        .filter((s) => s.classeId === 1)
        .every((s) => creneaux[s.creneau].debut < '13:00'),
    ).toBe(true);
    expect(
      r3.seances
        .filter((s) => s.classeId === 2)
        .every((s) => creneaux[s.creneau].debut >= '13:00'),
    ).toBe(true);
    expect(r3.heuresPlacees).toBe(8);
  });

  it('vague B : pas assez de créneaux l’après-midi pour le programme, le système le dit', () => {
    const r4 = genererEmploiDuTemps({
      classes: [{ id: 1, nom: '6ème 1B', niveau: '6EME', salleId: null }],
      programme: new Map([
        [
          '6EME',
          [
            { matiere: 'FR', heures: 8 },
            { matiere: 'MATH', heures: 10 },
          ],
        ],
      ]),
      libelles,
      enseignants: [prof(100, 'FR'), prof(101, 'MATH')],
      jours: [1, 2, 3, 4, 5, 6],
      creneaux,
      heuresEnseignant: 20,
    });
    // 3 créneaux l'après-midi × 5 jours (pas le samedi après-midi) = 15 pour 18 h
    const manque = r4.nonPlaces.find(
      (n) => n.matiereLibelle === 'Créneaux de la semaine',
    );
    expect(manque?.raison).toMatch(
      /18 h de programme mais seulement 15 créneaux/,
    );
    expect(r4.heuresPlacees).toBe(15);
  });
});
