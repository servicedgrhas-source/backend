import { parPreseance } from './catalogue';

const s = (type: string, sigle: string, ordre = 0) => ({
  type,
  sigle,
  nom: sigle,
  ordre,
});

describe('Ordre de préséance des structures', () => {
  it('sans rang du DG : cabinet, inspection générale, directions générales', () => {
    const l = [
      s('DIRECTION_GENERALE', 'DGES'),
      s('DGRHAS', 'DGRHAS'),
      s('INSPECTION_GENERALE', 'IGEPSA'),
      s('CABINET', 'CAB'),
      s('DIRECTION_GENERALE', 'DGEB'),
    ].sort(parPreseance);
    expect(l.map((x) => x.sigle)).toEqual([
      'CAB',
      'IGEPSA',
      'DGEB',
      'DGES',
      'DGRHAS',
    ]);
  });
  it('le rang donné par le DG passe avant tout', () => {
    const l = [s('CABINET', 'CAB', 2), s('DIRECTION_GENERALE', 'DGES', 1)].sort(
      parPreseance,
    );
    expect(l.map((x) => x.sigle)).toEqual(['DGES', 'CAB']);
  });
  it('les numéros dans l’ordre : 2 avant 10', () => {
    const l = [
      s('INSPECTION', 'Boko-Songho 10'),
      s('INSPECTION', 'Boko-Songho 2'),
      s('INSPECTION', 'Boko-Songho'),
    ].sort(parPreseance);
    expect(l.map((x) => x.sigle)).toEqual([
      'Boko-Songho',
      'Boko-Songho 2',
      'Boko-Songho 10',
    ]);
  });
});
