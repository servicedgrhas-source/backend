import { decider, droitsDe, rubriquesDe, validerDroits } from './droits';

describe('Droits par rubrique', () => {
  it('rattache une adresse à la rubrique la plus précise', () => {
    expect(rubriquesDe('/notes/preparer/affectation')).toEqual([
      '/notes/affectation',
    ]);
    expect(rubriquesDe('/notes/12/valider').sort()).toEqual(
      ['/notes/affectation', '/notes/enrolement', '/notes/mutation'].sort(),
    );
    expect(rubriquesDe('/candidats/import')).toEqual(['/candidats']);
    expect(rubriquesDe('/candidatsXYZ')).toEqual([]);
    expect(rubriquesDe('/parametres')).toEqual(['/administration/parametres']);
  });

  it('sans réglage : les droits d’origine du rôle', () => {
    expect(decider({}, '/candidats', 'POST').decision).toBe('normal');
    expect(decider({}, '/inconnu', 'POST').decision).toBe('normal');
  });

  it('lecture seule : on lit, on n’enregistre pas', () => {
    const d = { '/candidats': 'LECTURE' as const };
    expect(decider(d, '/candidats', 'GET').decision).toBe('permis');
    expect(decider(d, '/candidats/import', 'POST').decision).toBe('refuse');
  });

  it('masquée : enregistrements refusés, lectures selon le rôle', () => {
    const d = { '/candidats': 'MASQUE' as const };
    expect(decider(d, '/candidats', 'GET').decision).toBe('normal');
    expect(decider(d, '/candidats', 'PUT').decision).toBe('refuse');
  });

  it('adresse partagée : permise dès qu’une rubrique l’est', () => {
    const d = { '/notes/affectation': 'LECTURE' as const };
    expect(decider(d, '/notes/3/valider', 'POST').decision).toBe('normal');
    expect(decider(d, '/notes/preparer/affectation', 'POST').decision).toBe(
      'refuse',
    );
  });

  it('modification : rubrique ouverte en plus du rôle', () => {
    const d = { '/pilotage': 'MODIFICATION' as const };
    expect(decider(d, '/pilotage/repartition', 'POST').decision).toBe('permis');
  });

  it('les comptes ne s’ouvrent jamais au-delà du rôle', () => {
    expect(
      decider({ '/administration': 'MODIFICATION' }, '/utilisateurs', 'POST')
        .decision,
    ).toBe('normal');
    expect(
      decider({ '/administration': 'LECTURE' }, '/utilisateurs', 'GET')
        .decision,
    ).toBe('normal');
    expect(
      decider({ '/administration': 'LECTURE' }, '/utilisateurs', 'POST')
        .decision,
    ).toBe('refuse');
  });

  it('le réglage de la personne passe avant celui du rôle ; DG et administrateur libres', () => {
    const c = validerDroits({
      roles: {
        AGENT: { '/candidats': 'LECTURE', '/lots': 'MASQUE' },
        DG: { '/candidats': 'MASQUE' },
      },
      utilisateurs: {
        '11111111-1111-1111-1111-111111111111': {
          '/candidats': 'MODIFICATION',
        },
      },
    });
    expect(c.roles.DG).toBeUndefined();
    expect(
      droitsDe(c, {
        id: '11111111-1111-1111-1111-111111111111',
        role: 'AGENT',
      }),
    ).toEqual({ '/candidats': 'MODIFICATION', '/lots': 'MASQUE' });
    expect(
      droitsDe(c, {
        id: '22222222-2222-2222-2222-222222222222',
        role: 'AGENT',
      }),
    ).toEqual({ '/candidats': 'LECTURE', '/lots': 'MASQUE' });
  });

  it('refuse un niveau inconnu, ignore une rubrique inconnue', () => {
    expect(() =>
      validerDroits({ roles: { AGENT: { '/candidats': 'TOUT' } } }),
    ).toThrow();
    expect(
      validerDroits({ roles: { AGENT: { '/nimporte': 'LECTURE' } } }).roles,
    ).toEqual({});
  });
});
