import {
  droitsDe,
  estCompteVide,
  refusCompteVide,
  validerDroits,
} from './droits';

/** Compte vide (21/11/2026) : il ne voit et ne fait que les rubriques qu'on lui ouvre. */
describe('Compte vide', () => {
  const ID = '11111111-1111-1111-1111-111111111111';
  const config = validerDroits({
    rolesPerso: {
      PERSO_SAISIE: { libelle: 'Saisie', base: 'AGENT', vide: true },
      PERSO_ORDINAIRE: { libelle: 'Ordinaire', base: 'AGENT' },
    },
    roles: {
      PERSO_SAISIE: {
        '/enrolement/saisie': 'MODIFICATION',
        '/recensement': 'MODIFICATION',
        '/mutations': 'LECTURE',
      },
    },
    attributions: { [ID]: 'PERSO_SAISIE' },
  });
  const u = { id: ID, role: 'AGENT' as const };
  const droits = droitsDe(config, u);

  it('est reconnu, et seulement pour son rôle « vide »', () => {
    expect(estCompteVide(config, u)).toBe(true);
    expect(config.rolesPerso?.PERSO_ORDINAIRE?.vide).toBeUndefined();
    expect(
      estCompteVide(config, {
        id: '22222222-2222-2222-2222-222222222222',
        role: 'AGENT',
      }),
    ).toBe(false);
  });

  it('a tout fermé sauf ce qui lui est ouvert', () => {
    expect(droits['/enrolement/saisie']).toBe('MODIFICATION');
    expect(droits['/nominations']).toBe('MASQUE');
    expect(droits['/personnel/agents']).toBe('MASQUE');
  });

  it('travaille dans ses rubriques', () => {
    expect(refusCompteVide(droits, '/enrolement/dossiers', 'POST')).toBeNull();
    expect(refusCompteVide(droits, '/enrolement/campagnes', 'GET')).toBeNull();
    // Le recensement complète et ajoute des fiches (rangées dans « Base du personnel »)
    expect(refusCompteVide(droits, '/recensement/agents', 'POST')).toBeNull();
    expect(refusCompteVide(droits, '/recensement/agents/12', 'PUT')).toBeNull();
    expect(refusCompteVide(droits, '/structures', 'GET')).toBeNull();
  });

  it('ne voit rien d’autre, même en lecture', () => {
    expect(refusCompteVide(droits, '/nominations', 'GET')).not.toBeNull();
    expect(refusCompteVide(droits, '/agents', 'GET')).not.toBeNull();
    expect(refusCompteVide(droits, '/journal', 'GET')).not.toBeNull();
  });

  it('consulte sans modifier une rubrique ouverte en lecture', () => {
    expect(refusCompteVide(droits, '/mutations', 'GET')).toBeNull();
    expect(refusCompteVide(droits, '/mutations', 'POST')).toMatch(
      /lecture seule/,
    );
  });
});
