import { IndexNoms } from './index-noms';

describe('Index de noms', () => {
  const index = new IndexNoms<string>();
  index.ajouter('MOUKOKO Jean Pierre', '1980-05-12', 'a');
  index.ajouter('MOUKOKO Jean Pierre', '1975-01-01', 'b');
  index.ajouter('MOUKOKO Jean Pierre', null, 'c');
  index.ajouter('MOUKOKO Jean Pierre', '1980-05-12', 'd');

  it('même date ou date inconnue : retrouvé, dans l’ordre d’ajout', () => {
    expect(index.probables('MOUKOKO Jean Pierre', '1980-05-12')).toEqual([
      'a',
      'c',
      'd',
    ]);
  });
  it('deux dates connues et différentes : jamais « très probablement » la même personne', () => {
    expect(index.probables('MOUKOKO Jean Pierre', '1990-02-02')).toEqual(['c']);
  });
  it('sans date : tous les noms identiques', () => {
    expect(index.probables('Jean Pierre MOUKOKO', null)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});
