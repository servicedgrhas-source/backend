import { bilanSemaine, retard } from './presence-regles';
import { appreciation, lecture } from './suivi.service';

const semaine = [
  '2026-10-19',
  '2026-10-20',
  '2026-10-21',
  '2026-10-22',
  '2026-10-23',
  '2026-10-24',
];
const avant = semaine.map((d) =>
  new Date(new Date(`${d}T00:00:00Z`).getTime() - 7 * 864e5)
    .toISOString()
    .slice(0, 10),
);
/** Enseignant attendu lundi, mardi et jeudi de 8 h à 12 h. */
const h = {
  '1': { debut: '08:00', fin: '12:00' },
  '2': { debut: '08:00', fin: '12:00' },
  '4': { debut: '08:00', fin: '12:00' },
};

describe('Présence : retard et alertes de fin de semaine (DG, 24/10/2026)', () => {
  it('le retard se lit sur l’heure d’arrivée', () => {
    expect(retard(h, 1, '08:20')).toBe(20);
    expect(retard(h, 1, '07:50')).toBe(0);
    expect(retard(h, 3, '09:00')).toBeNull(); // pas attendu le mercredi
  });

  it('venu tous ses jours, à l’heure : aucune alerte', () => {
    const b = bilanSemaine(h, semaine, {
      '2026-10-19': { statut: 'PRESENT' },
      '2026-10-20': { statut: 'PRESENT', arrivee: '08:00', depart: '12:00' },
      '2026-10-22': { statut: 'PRESENT' },
    });
    expect(b.alertes).toEqual([]);
    expect(b.minutesPrevues).toBe(720);
    expect(b.minutesFaites).toBe(720);
  });

  it('absent plus de la moitié des jours attendus : alerte', () => {
    const b = bilanSemaine(h, semaine, {
      '2026-10-19': { statut: 'ABSENT' },
      '2026-10-20': { statut: 'ABSENT_JUSTIFIE' },
      '2026-10-22': { statut: 'PRESENT' },
    });
    expect(b.alertes.map((a) => a.code)).toContain('JOURS');
  });

  it('moins de la moitié des heures prévues : alerte', () => {
    const b = bilanSemaine(h, semaine, {
      '2026-10-19': { statut: 'PRESENT', arrivee: '10:30', depart: '12:00' },
      '2026-10-20': { statut: 'RETARD', arrivee: '10:00', depart: '11:00' },
      '2026-10-22': { statut: 'PRESENT', arrivee: '11:00', depart: '12:00' },
    });
    expect(b.alertes.map((a) => a.code)).toEqual(['HEURES']);
    expect(b.minutesFaites).toBe(210);
    expect(b.minutesRetard).toBe(150 + 120 + 180);
  });

  it('deux semaines d’affilée sans travailler : alerte', () => {
    const absent = (dates: string[]) =>
      Object.fromEntries(
        [0, 1, 3].map((i) => [dates[i], { statut: 'ABSENT' }]),
      );
    const b = bilanSemaine(h, semaine, absent(semaine), {
      dates: avant,
      pointages: absent(avant),
    });
    expect(b.alertes.map((a) => a.code)).toContain('DEUX_SEMAINES');
    // Une seule semaine d'absence : pas encore
    const c = bilanSemaine(h, semaine, absent(semaine), {
      dates: avant,
      pointages: {},
    });
    expect(c.alertes.map((a) => a.code)).not.toContain('DEUX_SEMAINES');
  });

  it('sans horaire : du lundi au vendredi, pas d’alerte d’heures', () => {
    const b = bilanSemaine(null, semaine, {});
    expect(b.joursAttendus).toBe(5);
    expect(b.minutesPrevues).toBeNull();
  });
});

describe('Évaluation : la moyenne est 2,5 (DG, 24/10/2026)', () => {
  it('2,5 est « bon », 2 « faible »', () => {
    expect(appreciation(2.5)).toBe('Bon');
    expect(appreciation(2)).toBe('Faible');
    expect(appreciation(1.5)).toBe('Très faible');
    expect(appreciation(4.5)).toBe('Très bon');
    expect(appreciation(5)).toBe('Excellent');
  });
  it('compétent mais relations difficiles : professionnelle ≥ 2,5, sociale < 2,5', () => {
    expect(lecture(3, 2)).toMatch(/relations difficiles/);
    expect(lecture(2, 3)).toMatch(/à renforcer/);
  });
});
