import { cleOrigine, libelleOrigine } from './origines-regles';

describe('Origines de l’enrôlement (16/11/2026)', () => {
  it.each([
    ['S/C DRSC', 'DRSC'],
    ['S/D DRSC', 'DRSC'],
    ['SC/ DRSC', 'DRSC'],
    ['S/L DRSC', 'DRSC'],
    ['S/B DRSC', 'DRSC'],
    ['DRSC', 'DRSC'],
    ['S/C DD Cuvette-Ouest', 'DD CUVETTE OUEST'],
    ['DD Cuvette Ouest', 'DD CUVETTE OUEST'],
    ['CAB/MEPPSA', 'CAB MEPPSA'],
    ['SC/ CAB MEPPSA', 'CAB MEPPSA'],
    ['SC/ CABINET MEPPSA', 'CAB MEPPSA'],
    ['SC/ DDEPPSA Pointe-Noire', 'DDEPPSA POINTE NOIRE'],
    ['DDEPSA Pointe-Noire', 'DDEPPSA POINTE NOIRE'],
    ['S/C Att Mbolé', 'ATTACHE MBOLE'],
    ['SC/ Attaché MAKAYA', 'ATTACHE MAKAYA'],
    ['SC/ Mr PEA', 'PEA'],
    ['CDEP', 'CDEP'],
    ['', ''],
    [null, ''],
  ])('%s → %s', (brute, cle) => {
    expect(cleOrigine(brute)).toBe(cle);
  });

  it('garde l’écriture la plus fréquente, sans « S/C » devant', () => {
    expect(
      libelleOrigine(
        new Map([
          ['S/D DRSC', 48],
          ['SC/ DRSC', 31],
          ['DRSC', 15],
        ]),
      ),
    ).toBe('DRSC');
    expect(libelleOrigine(new Map([['S/C DD Cuvette-Ouest', 41]]))).toBe(
      'DD Cuvette-Ouest',
    );
    for (const [ecrit, attendu] of [
      ['SC/ Liele (ALECB)', 'Liele (ALECB)'],
      ['SC/ CB IS', 'CB IS'],
      ['DOS/CB Rolly', 'CB Rolly'],
      ['SC/DDEPPSA PNR', 'DDEPPSA PNR'],
      ['S/D DRSC', 'DRSC'],
      ['CAB/MEPPSA', 'CAB/MEPPSA'],
      ['Sous couvert du DG', 'du DG'.replace('du ', '')],
    ])
      expect(libelleOrigine(new Map([[ecrit, 1]]))).toBe(attendu);
    expect(cleOrigine('SC/ CB IS')).toBe('CB IS');
    expect(cleOrigine('DOS/CB Rolly')).toBe('CB ROLLY');
  });
});
