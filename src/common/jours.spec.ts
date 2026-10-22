import { joursDepuis } from './jours';

describe('joursDepuis (jours du calendrier à Brazzaville)', () => {
  // 22 octobre 2026, 08 h 00 à Brazzaville (UTC+1)
  const maintenant = new Date('2026-10-22T07:00:00Z');

  it('arrivé hier soir : 1 jour (pas « aujourd’hui »)', () => {
    expect(joursDepuis('2026-10-21T22:30:00Z', maintenant)).toBe(1); // 23 h 30 à Brazzaville
  });
  it('arrivé ce matin : 0', () => {
    expect(joursDepuis('2026-10-22T06:00:00Z', maintenant)).toBe(0);
  });
  it('minuit passé à Brazzaville mais pas en UTC : déjà le lendemain', () => {
    // 21/10 à 23 h 30 UTC = 22/10 à 00 h 30 à Brazzaville
    expect(joursDepuis('2026-10-21T23:30:00Z', maintenant)).toBe(0);
  });
  it('date seule (enregistrement)', () => {
    expect(joursDepuis('2026-10-12', maintenant)).toBe(10);
    expect(joursDepuis('2014-01-01', maintenant)).toBe(4677);
  });
  it('absente ou illisible : null', () => {
    expect(joursDepuis(null, maintenant)).toBeNull();
    expect(joursDepuis('n’importe quoi', maintenant)).toBeNull();
  });
});
