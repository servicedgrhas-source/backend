import { montantArrete, nombreEnLettres } from './lettres';

describe('nombreEnLettres', () => {
  it.each([
    [0, 'zéro'],
    [21, 'vingt et un'],
    [71, 'soixante et onze'],
    [80, 'quatre-vingts'],
    [81, 'quatre-vingt-un'],
    [99, 'quatre-vingt-dix-neuf'],
    [200, 'deux cents'],
    [205, 'deux cent cinq'],
    [1000, 'mille'],
    [80000, 'quatre-vingt mille'],
    [200000, 'deux cent mille'],
    [8205000, 'huit millions deux cent cinq mille'],
    [5120000, 'cinq millions cent vingt mille'],
    // Récapitulatif de la bourse de septembre 2026 (signé)
    [167845000, 'cent soixante-sept millions huit cent quarante-cinq mille'],
    [1000000, 'un million'],
  ])('%i → %s', (n, attendu) => {
    expect(nombreEnLettres(n)).toBe(attendu);
  });

  it('montant arrêté comme sur la fiche de mise en route', () => {
    expect(montantArrete(8205000)).toBe(
      'HUIT MILLIONS DEUX CENT CINQ MILLE (8.205.000) FCFA',
    );
  });
});
