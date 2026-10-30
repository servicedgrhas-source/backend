import { analyseJour, horaireEffectif, retard } from './presence-regles';

const reglages = {
  toleranceArrivee: 10,
  toleranceDepart: 10,
  retardGrave: 60,
  debutDefaut: '07:30',
  finDefaut: '14:00',
};
/** Lundi : 6ème 1 de 7 h 30 à 8 h 25, 5ème 2 de 10 h 30 à 11 h 25. */
const cours = {
  '1': [
    { debut: '10:30', fin: '11:25', libelle: '5ème 2 · Mathématiques' },
    { debut: '07:30', fin: '08:25', libelle: '6ème 1 · Mathématiques' },
  ],
};

describe('Présence comme une vraie école (DG, 30/10/2026)', () => {
  it('l’heure attendue vient de l’emploi du temps, sinon de l’horaire, sinon du défaut', () => {
    const e = horaireEffectif(
      { '2': { debut: '08:00', fin: '12:00' } },
      cours,
      reglages,
    );
    expect(e.source).toBe('EDT');
    expect(e.jours).toEqual({ '1': { debut: '07:30', fin: '11:25' } });
    const h = horaireEffectif(
      { '2': { debut: '08:00', fin: '12:00' } },
      {},
      reglages,
    );
    expect(h.source).toBe('HORAIRE');
    const d = horaireEffectif(null, null, reglages);
    expect(d.source).toBe('DEFAUT');
    expect(Object.keys(d.jours)).toEqual(['1', '2', '3', '4', '5']);
    expect(d.jours['3']).toEqual({ debut: '07:30', fin: '14:00' });
  });

  it('la marge d’arrivée : dans la marge à l’heure, au-delà le retard compte depuis l’heure prévue', () => {
    const h = { '1': { debut: '08:00', fin: '12:00' } };
    expect(retard(h, 1, '08:10', 10)).toBe(0);
    expect(retard(h, 1, '08:25', 10)).toBe(25);
  });

  it('retard, retard important, départ anticipé et cours manqués', () => {
    const prevu = { debut: '07:30', fin: '11:25' };
    const l = [...cours['1']];
    // Arrivé à 8 h 40 : le premier cours est perdu (55 min), parti à 11 h : 25 min du second
    const a = analyseJour(
      prevu,
      l,
      { statut: 'RETARD', arrivee: '08:40', depart: '11:00' },
      reglages,
    );
    expect(a.retard).toBe(70);
    expect(a.retardGrave).toBe(true);
    expect(a.departAnticipe).toBe(25);
    expect(a.coursManques.map((c) => [c.libelle, c.minutes])).toEqual([
      ['5ème 2 · Mathématiques', 25],
      ['6ème 1 · Mathématiques', 55],
    ]);
    expect(a.minutesCoursPerdues).toBe(80);
    // Dans les marges : rien à signaler
    const b = analyseJour(
      prevu,
      l,
      { statut: 'PRESENT', arrivee: '07:38', depart: '11:20' },
      reglages,
    );
    expect(b).toMatchObject({
      retard: 0,
      retardGrave: false,
      departAnticipe: 0,
      minutesCoursPerdues: 0,
    });
    // Sans heures notées : là toute la journée ; absent : rien n'est calculé
    expect(
      analyseJour(prevu, l, { statut: 'PRESENT' }, reglages).retard,
    ).toBeNull();
    expect(
      analyseJour(prevu, l, { statut: 'ABSENT' }, reglages).coursManques,
    ).toEqual([]);
  });
});
