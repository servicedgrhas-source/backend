import {
  decider,
  deciderVisiteur,
  droitsDe,
  refusInformatique,
  rolePersoDe,
  rubriquesDe,
  validerDroits,
} from './droits';

describe('Droits par rubrique', () => {
  it('rattache une adresse à la rubrique la plus précise', () => {
    expect(rubriquesDe('/notes/preparer/affectation')).toEqual([
      '/notes/affectation',
    ]);
    expect(rubriquesDe('/notes/12/valider').sort()).toEqual(
      [
        '/notes/affectation',
        '/notes/enrolement',
        '/notes/mutation',
        '/notes/nomination',
      ].sort(),
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

  it('rôle personnalisé : ses rubriques par-dessus son rôle de départ, la personne par-dessus', () => {
    const id = '33333333-3333-3333-3333-333333333333';
    const c = validerDroits({
      roles: {
        AGENT: { '/lots': 'MASQUE' },
        PERSO_SECRETARIAT: { '/lots': 'LECTURE', '/candidats': 'MODIFICATION' },
      },
      rolesPerso: {
        PERSO_SECRETARIAT: { libelle: 'Secrétariat', base: 'AGENT' },
      },
      attributions: {
        [id]: 'PERSO_SECRETARIAT',
        [id.replace(/3/g, '4')]: 'PERSO_INCONNU',
      },
      utilisateurs: { [id]: { '/candidats': 'LECTURE' } },
    });
    expect(Object.keys(c.attributions ?? {})).toEqual([id]);
    expect(droitsDe(c, { id, role: 'AGENT' })).toEqual({
      '/lots': 'LECTURE',
      '/candidats': 'LECTURE',
    });
    expect(rolePersoDe(c, id)).toBe('Secrétariat');
    // Sans attribution : seulement le rôle du système
    expect(droitsDe(c, { id: id.replace(/3/g, '5'), role: 'AGENT' })).toEqual({
      '/lots': 'MASQUE',
    });
  });

  it('refuse un rôle personnalisé parti du DG, de l’administrateur ou d’une structure', () => {
    for (const base of ['DG', 'ADMIN', 'STRUCTURE'])
      expect(() =>
        validerDroits({ rolesPerso: { PERSO_X: { libelle: 'X', base } } }),
      ).toThrow();
    expect(() =>
      validerDroits({
        rolesPerso: {
          PERSO_A: { libelle: 'Même', base: 'AGENT' },
          PERSO_B: { libelle: 'même', base: 'AGENT' },
        },
      }),
    ).toThrow();
  });

  describe('Compte visiteur', () => {
    const d = { '/personnel/agents': 'LECTURE' as const };
    const v = (chemin: string, methode = 'GET') =>
      deciderVisiteur(d, chemin, methode).decision;

    it('consulte seulement les rubriques ouvertes en lecture', () => {
      expect(v('/recensement/agents')).toBe('permis');
      expect(v('/recensement/agents/12')).toBe('permis');
      expect(v('/candidats')).toBe('refuse');
      expect(v('/tableau-de-bord')).toBe('refuse');
      expect(v('/inconnu')).toBe('refuse');
    });

    it('lit toujours les réglages communs des pages', () => {
      expect(v('/parametres')).toBe('permis');
      expect(v('/referentiels')).toBe('permis');
      expect(v('/auth/moi')).toBe('permis');
    });

    it('n’enregistre rien, sauf son propre mot de passe', () => {
      expect(v('/recensement/agents/12', 'PUT')).toBe('refuse');
      expect(v('/parametres/X', 'PUT')).toBe('refuse');
      expect(v('/auth/mot-de-passe', 'POST')).toBe('permis');
    });

    it('ne télécharge ni n’imprime aucun fichier, même dans sa rubrique', () => {
      expect(v('/recensement/export')).toBe('refuse');
      expect(v('/recensement/agents/12/pieces/5')).toBe('refuse');
      expect(v('/notes/3/word')).toBe('refuse');
      expect(v('/structures/modele')).toBe('refuse');
    });

    it('lit ce dont la page de sa rubrique a besoin, sans ouvrir l’autre rubrique', () => {
      const p = { '/personnel': 'LECTURE' as const };
      expect(deciderVisiteur(p, '/recensement/tableau', 'GET').decision).toBe(
        'permis',
      );
      expect(
        deciderVisiteur(p, '/recensement/modifications', 'GET').decision,
      ).toBe('refuse');
      expect(deciderVisiteur({}, '/recensement/tableau', 'GET').decision).toBe(
        'refuse',
      );
    });

    it('ne reçoit jamais plus que la lecture', () => {
      const r = droitsDe(
        {
          roles: { VISITEUR: { '/candidats': 'MODIFICATION' } },
          utilisateurs: {},
        },
        { id: 'x', role: 'VISITEUR' },
      );
      expect(r['/candidats']).toBe('LECTURE');
    });
  });

  describe('Compte Informatique (08/11/2026)', () => {
    const vide = validerDroits({});
    it('voit la configuration en lecture seule', () => {
      const d = droitsDe(vide, { id: 'x', role: 'INFORMATIQUE' });
      for (const r of [
        '/administration/parametres',
        '/administration/regles',
        '/administration/organigramme',
        '/administration/referentiels',
        '/administration/prestations',
        '/administration/origines',
        '/administration/menu',
      ])
        expect(d[r]).toBe('LECTURE');
      // Utilisateurs et droits par rubrique : invisibles
      expect(d['/administration']).toBe('MASQUE');
      expect(d['/administration/droits']).toBe('MASQUE');
      // Ni la sauvegarde de la base, ni le journal des actions
      expect(d['/administration/sauvegarde']).toBe('MASQUE');
      expect(d['/journal']).toBe('MASQUE');
      expect(d['/mutations']).toBeUndefined();
    });
    it('le DG peut masquer une rubrique, pas ouvrir la configuration en modification', () => {
      const c = validerDroits({
        roles: {
          INFORMATIQUE: {
            '/mutations': 'MASQUE',
            '/administration/parametres': 'MODIFICATION',
            '/administration/menu': 'MASQUE',
            '/administration': 'LECTURE',
          },
        },
      });
      const d = droitsDe(c, { id: 'x', role: 'INFORMATIQUE' });
      expect(d['/mutations']).toBe('MASQUE');
      expect(d['/administration/parametres']).toBe('LECTURE');
      expect(d['/administration/menu']).toBe('MASQUE');
      // Le DG ne peut pas lui ouvrir les utilisateurs
      expect(d['/administration']).toBe('MASQUE');
    });
    it('refuse les utilisateurs et les droits, même en lecture', () => {
      for (const [chemin, m] of [
        ['/utilisateurs', 'GET'],
        ['/utilisateurs', 'POST'],
        ['/utilisateurs/abc', 'PUT'],
        ['/utilisateurs/codes', 'POST'],
        ['/droits', 'GET'],
        ['/droits', 'PUT'],
        ['/sauvegarde/apercu', 'GET'],
        ['/sauvegarde/telecharger', 'GET'],
        ['/sauvegarde/cloudinary', 'POST'],
        ['/journal', 'GET'],
      ])
        expect(refusInformatique(chemin, m)).toMatch(
          /ne vous sont pas ouverts/,
        );
    });
    it('refuse les enregistrements de configuration, pas le travail', () => {
      for (const [chemin, m] of [
        ['/parametres/DG_NOM', 'PUT'],
        ['/configuration/grades', 'POST'],
        ['/structures/3', 'DELETE'],
        ['/referentiels/valeurs', 'POST'],
        ['/prestations/CONGE', 'PUT'],
        ['/origines/2', 'PUT'],
        ['/menu/configuration', 'PUT'],
        ['/enrolement/configuration', 'PUT'],
        ['/recensement/configuration', 'PUT'],
      ])
        expect(refusInformatique(chemin, m)).toMatch(/lecture|consulte/);
      for (const [chemin, m] of [
        ['/parametres', 'GET'],
        ['/configuration/apercu', 'POST'],
        ['/mutations', 'POST'],
        ['/notes/12/valider', 'POST'],
        ['/besoins-administratifs/structures/3/cadre', 'PUT'],
      ])
        expect(refusInformatique(chemin, m)).toBeNull();
    });
  });
});
