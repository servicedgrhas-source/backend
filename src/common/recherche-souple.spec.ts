import { chercher, preparer } from './recherche-souple';

/** Recherche intelligente : on tape comme on entend, le système comprend (DG, 22/11/2026). */
describe('Recherche souple', () => {
  const ecoles = [
    'EP MOUSSA ETA A',
    'EP MOUSSA ETA B',
    'CEG DE VINDOULOU',
    'EP KINSOUNDI II-B',
    'EP KINSOUNDI 2A',
    'LEG PIERRE SAVORGNAN DE BRAZZA',
    'CEP 15 AOÛT 1963',
    'EP NGOUBOU-NGOUBOU',
    'CA PHILIPPE MOUKOUAMOU',
    "Centre d'Alphabetisation Akolo",
  ].map((nom) => ({ item: nom, prepare: preparer(nom, true) }));
  const premier = (q: string) => chercher(q, ecoles, 3, true)[0]?.item;

  it('trouve l’école sans le type, sans accents, dans le désordre', () => {
    expect(premier('vindoulou')).toBe('CEG DE VINDOULOU');
    expect(premier('ecole moussa eta a')).toBe('EP MOUSSA ETA A');
    expect(premier('brazza savorgnan')).toBe('LEG PIERRE SAVORGNAN DE BRAZZA');
    expect(premier('15 aout 1963')).toBe('CEP 15 AOÛT 1963');
    expect(premier('alfabetisation moukuamu')).toBe('CA PHILIPPE MOUKOUAMOU');
    expect(premier('lycé brazza')).toBe('LEG PIERRE SAVORGNAN DE BRAZZA');
    // « AKOLO » sonne comme « école » mais c'est un nom
    expect(premier('akollo')).toBe("Centre d'Alphabetisation Akolo");
    expect(premier('alfabetisation akolo')).toBe(
      "Centre d'Alphabetisation Akolo",
    );
  });
  it('comprend le début d’un mot, les mots collés et les chiffres romains', () => {
    expect(premier('vindou')).toBe('CEG DE VINDOULOU');
    expect(premier('moussaeta b')).toBe('EP MOUSSA ETA B');
    expect(premier('kinsoundi 2b')).toBe('EP KINSOUNDI II-B');
    expect(premier('kinsoundi deux a')).toBe('EP KINSOUNDI 2A');
  });
  it('pardonne les fautes et les sons équivalents', () => {
    expect(premier('vindoulu')).toBe('CEG DE VINDOULOU');
    expect(premier('ngubu ngubu')).toBe('EP NGOUBOU-NGOUBOU');
    expect(premier('filipe mukuamu')).toBe('CA PHILIPPE MOUKOUAMOU');
    expect(premier('savorgnian brazaa')).toBe('LEG PIERRE SAVORGNAN DE BRAZZA');
  });
  it('ne confond pas ce qui est différent', () => {
    expect(premier('moussa eta a')).toBe('EP MOUSSA ETA A');
    expect(chercher('kinsoundi 2a', ecoles, 3, true)[0]?.item).toBe(
      'EP KINSOUNDI 2A',
    );
    expect(chercher('zzz xxx', ecoles, 3, true)).toHaveLength(0);
  });

  const agents = [
    'MOUKOKO Jean Pierre',
    'NGOMA Alice',
    'BOUKOUANGOU MANIMA Julma',
    'MALONGA Christophe',
  ].map((nom) => ({ item: nom, prepare: preparer(nom) }));
  it('trouve un agent tapé comme on l’entend', () => {
    expect(chercher('mukoko jean', agents)[0]?.item).toBe(
      'MOUKOKO Jean Pierre',
    );
    expect(chercher('christof malonga', agents)[0]?.item).toBe(
      'MALONGA Christophe',
    );
    expect(chercher('bukwangu', agents)[0]?.item).toBe(
      'BOUKOUANGOU MANIMA Julma',
    );
    expect(chercher('alis ngoma', agents)[0]?.item).toBe('NGOMA Alice');
  });
});
