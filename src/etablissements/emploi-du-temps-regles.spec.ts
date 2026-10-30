import {
  genererEmploiDuTemps,
  lireCreneaux,
  vagueDe,
  type EnseignantEdt,
} from './emploi-du-temps-regles';

const creneaux = lireCreneaux(
  '07:30-08:25, 08:25-09:20, 09:20-10:15, 10:30-11:25, 11:25-12:20, 15:00-15:55, 15:55-16:50, 16:50-17:45',
);
/** Une plage au créneau n° i de l'école (ses heures). */
const pl = (classeId: number, jour: number, i: number) => ({
  classeId,
  jour,
  debut: creneaux[i].debut,
  fin: creneaux[i].fin,
});
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
    expect(
      r2.nonPlaces.some((x) =>
        /plus assez d’heures libres \(20 h au plus/.test(x.raison),
      ),
    ).toBe(true);
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

  it('respecte les jours ET les heures de chaque jour d’un enseignant (lundi 9 h-12 h, mardi 7 h-9 h, jeudi toute la journée)', () => {
    const horaire = {
      '1': { debut: '09:00', fin: '12:30' },
      '2': { debut: '07:00', fin: '09:30' },
      '4': { debut: null, fin: null },
    };
    const x = genererEmploiDuTemps({
      classes: [{ id: 1, nom: '6ème 1', niveau: '6EME', salleId: null }],
      programme: new Map([['6EME', [{ matiere: 'ANG', heures: 6 }]]]),
      libelles,
      enseignants: [prof(200, 'ANG', horaire)],
      jours: [1, 2, 3, 4, 5],
      creneaux,
      heuresEnseignant: 20,
    });
    const siennes = x.seances.filter((s) => s.agentId === 200);
    expect(siennes.length).toBeGreaterThan(0);
    for (const s of siennes) {
      const c = creneaux[s.creneau];
      expect([1, 2, 4]).toContain(s.jour);
      if (s.jour === 1)
        expect(c.debut >= '09:00' && c.fin <= '12:30').toBe(true);
      if (s.jour === 2)
        expect(c.debut >= '07:00' && c.fin <= '09:30').toBe(true);
    }
    // Le mardi, seuls 07:30-08:25 et 08:25-09:20 tiennent dans 7 h-9 h 30
    expect(
      siennes.filter((s) => s.jour === 2).every((s) => s.creneau <= 1),
    ).toBe(true);
  });
  describe('plages horaires saisies par l’école (DG, 28/10/2026)', () => {
    const classes = [1, 2, 3].map((id) => ({
      id,
      nom: `6ème ${id}`,
      niveau: '6EME',
      salleId: 10 + id,
    }));
    const base = {
      classes,
      programme,
      libelles,
      jours: [1, 2, 3, 4, 5, 6],
      creneaux,
      heuresEnseignant: 20,
    };
    // Prof 101 : la 6ème 2 le lundi aux deux premiers créneaux et le mardi au 4e, puis la 6ème 1
    // le jeudi au 1er ; chaque classe a 5 h de maths au programme
    const plages101 = [
      { ...pl(2, 1, 0), creneau: 0 },
      { ...pl(2, 1, 1), creneau: 1 },
      { ...pl(2, 2, 3), creneau: 3 },
      { ...pl(2, 3, 0), creneau: 0 },
      { ...pl(2, 5, 2), creneau: 2 },
      { ...pl(1, 4, 0), creneau: 0 },
    ];
    const x = genererEmploiDuTemps({
      ...base,
      enseignants: [
        { ...prof(101, 'MATH'), plages: plages101 },
        prof(102, 'MATH'),
        prof(100, 'FR'),
      ],
    });
    const de = (agent: number) => x.seances.filter((s) => s.agentId === agent);

    it('chaque plage est placée telle quelle : même classe, même jour, même créneau, marquée « saisie »', () => {
      const places = de(101)
        .map((s) => `${s.classeId}:${s.jour}:${s.creneau}:${s.fixe}`)
        .sort();
      expect(places).toEqual(
        plages101
          .map((p) => `${p.classeId}:${p.jour}:${p.creneau}:true`)
          .sort(),
      );
      expect(de(101).every((s) => s.matiere === 'MATH')).toBe(true);
    });
    it('un enseignant qui a des plages n’a rien d’autre : la 6ème 3 va à l’enseignant sans plages', () => {
      expect(de(101)).toHaveLength(6);
      const maths3 = new Set(
        x.seances
          .filter((s) => s.classeId === 3 && s.matiere === 'MATH')
          .map((s) => s.agentId),
      );
      expect([...maths3]).toEqual([102]);
    });
    it('5 h saisies en 6ème 2 : le programme est couvert, rien d’autre n’y est ajouté', () => {
      expect(
        x.seances.filter((s) => s.classeId === 2 && s.matiere === 'MATH'),
      ).toHaveLength(5);
    });
    it('1 h saisie en 6ème 1 sur 5 : les 4 h manquantes ne vont pas à un autre enseignant, c’est dit', () => {
      const maths1 = x.seances.filter(
        (s) => s.classeId === 1 && s.matiere === 'MATH',
      );
      expect(maths1).toHaveLength(5);
      expect(maths1.filter((s) => s.agentId === 102)).toHaveLength(0);
      expect(maths1.filter((s) => s.agentId === null)).toHaveLength(4);
      expect(
        x.nonPlaces.some(
          (n) =>
            n.classe === '6ème 1' &&
            n.heures === 4 &&
            /complétez ses plages/.test(n.raison),
        ),
      ).toBe(true);
    });
    it('les autres cours se placent autour des plages, sans conflit', () => {
      const cles = new Set<string>();
      for (const s of x.seances)
        for (const k of [
          `C${s.classeId}:${s.jour}:${s.creneau}`,
          ...(s.agentId ? [`A${s.agentId}:${s.jour}:${s.creneau}`] : []),
        ]) {
          expect(cles.has(k)).toBe(false);
          cles.add(k);
        }
      expect(x.heuresTotal).toBe(42);
      expect(x.heuresPlacees).toBe(42);
    });
    it('deux enseignants sur la même classe au même créneau : la seconde plage est refusée et signalée', () => {
      const y = genererEmploiDuTemps({
        ...base,
        enseignants: [
          {
            ...prof(101, 'MATH'),
            plages: [pl(1, 1, 0)],
          },
          {
            ...prof(100, 'FR'),
            plages: [pl(1, 1, 0)],
          },
        ],
      });
      const lundi = y.seances.filter(
        (s) => s.classeId === 1 && s.jour === 1 && s.creneau === 0,
      );
      expect(lundi).toHaveLength(1);
      expect(
        y.nonPlaces.some((n) => /a déjà cours avec Prof 101/.test(n.raison)),
      ).toBe(true);
    });
    it('plus d’heures saisies que le programme, ou hors des créneaux : c’est dit', () => {
      const y = genererEmploiDuTemps({
        ...base,
        enseignants: [
          {
            ...prof(103, 'ANG'),
            plages: [0, 1, 2, 3].map((i) => pl(1, 2, i)),
          },
          {
            ...prof(104, 'FR'),
            plages: [{ ...pl(2, 1, 0), jour: 7 }],
          },
        ],
      });
      expect(
        y.nonPlaces.some(
          (n) =>
            n.classe === '6ème 1' &&
            /4 h saisies .* pour 3 h au programme/.test(n.raison),
        ),
      ).toBe(true);
      expect(y.nonPlaces.some((n) => /un jour sans cours/.test(n.raison))).toBe(
        true,
      );
    });
  });

  describe('plages à leurs propres heures (DG, 30/10/2026)', () => {
    const classes = [
      { id: 1, nom: '6ème 1', niveau: '6EME', salleId: null },
      { id: 2, nom: '6ème 2', niveau: '6EME', salleId: null },
    ];
    const base = {
      classes,
      programme,
      libelles: new Map([
        ['FR', 'Français'],
        ['MATH', 'Mathématiques'],
        ['ANG', 'Anglais'],
      ]),
      jours: [1, 2, 3, 4, 5],
      creneaux,
      heuresEnseignant: 20,
    };
    const prof = (id: number, matiere: string): EnseignantEdt => ({
      id,
      nom: `Prof ${id}`,
      matiere,
      horaire: null,
    });

    it('une plage de 07:00 à 08:00 garde ses heures et bloque le créneau 07:30-08:25 pour la classe et pour lui', () => {
      const y = genererEmploiDuTemps({
        ...base,
        enseignants: [
          {
            ...prof(1, 'MATH'),
            plages: [{ classeId: 1, jour: 1, debut: '07:00', fin: '08:00' }],
          },
          prof(2, 'FR'),
          prof(3, 'ANG'),
          prof(4, 'MATH'),
        ],
      });
      const p = y.seances.find((x) => x.agentId === 1)!;
      expect(p).toMatchObject({
        jour: 1,
        creneau: 0,
        debut: '07:00',
        fin: '08:00',
        fixe: true,
      });
      // Rien d'autre pour la 6ème 1 le lundi au 1er créneau
      expect(
        y.seances.filter(
          (x) => x.classeId === 1 && x.jour === 1 && x.creneau === 0,
        ),
      ).toHaveLength(1);
    });

    it('une plage de 07:30 à 09:20 compte 2 h et occupe les deux créneaux', () => {
      const y = genererEmploiDuTemps({
        ...base,
        enseignants: [
          {
            ...prof(1, 'MATH'),
            plages: [{ classeId: 1, jour: 2, debut: '07:30', fin: '09:20' }],
          },
          prof(2, 'FR'),
          prof(3, 'ANG'),
        ],
      });
      const p = y.seances.find((x) => x.agentId === 1)!;
      expect(p.heures).toBe(2);
      expect(
        y.seances.filter(
          (x) => x.classeId === 1 && x.jour === 2 && [0, 1].includes(x.creneau),
        ),
      ).toHaveLength(1);
      expect(
        y.nonPlaces.some(
          (n) =>
            n.classe === '6ème 1' &&
            n.matiere === 'MATH' &&
            n.heures === 3 &&
            /complétez ses plages/.test(n.raison),
        ),
      ).toBe(true);
    });

    it('deux enseignants dans la même classe, 07:00-08:00 et 07:30-08:30 : le chevauchement est signalé avec les heures', () => {
      const y = genererEmploiDuTemps({
        ...base,
        enseignants: [
          {
            ...prof(1, 'MATH'),
            plages: [{ classeId: 1, jour: 1, debut: '07:00', fin: '08:00' }],
          },
          {
            ...prof(2, 'FR'),
            plages: [{ classeId: 1, jour: 1, debut: '07:30', fin: '08:30' }],
          },
        ],
      });
      expect(y.seances.filter((x) => x.fixe)).toHaveLength(1);
      expect(
        y.nonPlaces.some((n) =>
          /a déjà cours avec Prof 1 de 07:00 à 08:00 : les heures se chevauchent/.test(
            n.raison,
          ),
        ),
      ).toBe(true);
    });

    it('à la suite sans chevauchement (07:00-08:00 puis 08:00-09:00) : les deux sont placées', () => {
      const y = genererEmploiDuTemps({
        ...base,
        enseignants: [
          {
            ...prof(1, 'MATH'),
            plages: [{ classeId: 1, jour: 1, debut: '07:00', fin: '08:00' }],
          },
          {
            ...prof(2, 'FR'),
            plages: [{ classeId: 1, jour: 1, debut: '08:00', fin: '09:00' }],
          },
        ],
      });
      expect(y.seances.filter((x) => x.fixe)).toHaveLength(2);
    });

    it('le même enseignant dans deux classes à des heures qui se chevauchent : signalé', () => {
      const y = genererEmploiDuTemps({
        ...base,
        enseignants: [
          {
            ...prof(1, 'MATH'),
            plages: [
              { classeId: 1, jour: 3, debut: '10:30', fin: '11:25' },
              { classeId: 2, jour: 3, debut: '11:00', fin: '12:00' },
            ],
          },
        ],
      });
      expect(y.seances.filter((x) => x.fixe)).toHaveLength(1);
      expect(
        y.nonPlaces.some((n) =>
          /il a déjà cours en 6ème 1 de 10:30 à 11:25/.test(n.raison),
        ),
      ).toBe(true);
    });
  });
});
