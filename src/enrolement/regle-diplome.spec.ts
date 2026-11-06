import { regleDiplome } from './enrolement.service';

describe('regleDiplome (enrôlement, audio du 05/11/2026)', () => {
  it.each([
    ['BET', 'BET', 'Préscolaire', 'ok'],
    ['BET', 'BET', 'Economie sociale et spécialité préscolaire', 'ok'],
    ['BET', 'BET', 'PRÉCOLAIRE', 'ok'],
    ['BET', 'BET', 'PEURICULTURE', 'non'],
    ['BET', 'BET', 'Maçonnerie', 'non'],
    ['BET', 'BET', 'Primaire', 'verif'],
    ['BET', 'BET', '', 'verif'],
    ['AUTRE', 'BAC PEDA', null, 'non'],
    ['AUTRE', 'BAC', null, 'non'],
    ['DCAF', 'DCAF', 'Gestion scolaire', 'ok'],
    ['DCAF', 'DCAF', 'ADMINISTTRATION', 'ok'],
    ['DCAF', 'DCAF', 'Administration générale', 'ok'],
    ['DCAF', 'DCAF', 'ADM. SCOLAIRE', 'ok'],
    ['DCAF', 'DCAF', 'Administration du travail', 'verif'],
    ['DCAF', 'DCAF', 'Douanes', 'verif'],
    ['LICENCE', 'LICENCE', 'Droit des affaires', 'verif'],
    ['LICENCE', 'LICENCE', 'Français', 'ok'],
    ['MASTER', 'CAPES', 'Philosophie', 'ok'],
    ['CFEEN', 'CFEEN', 'Primaire', 'ok'],
  ])('%s « %s » « %s » → %s', (code, brut, sp, attendu) => {
    const r = regleDiplome(code, brut, sp);
    if (attendu === 'non') expect(r.nonConforme).toBeTruthy();
    else if (attendu === 'verif') expect(r.aVerifier).toBeTruthy();
    else expect(r).toEqual({});
  });
});
