import { nomAbrege, parCycleEtNom } from './etablissement-nom';

const abrev = (c: string) =>
  ({ PRESCOLAIRE: 'CEP', PRIMAIRE: 'EP', COLLEGE: 'CEG', LYCEE: 'Lycée' })[c] ??
  null;

describe('Nom des établissements (DG, 06/11/2026)', () => {
  it('abrège le libellé du cycle devant le nom', () => {
    expect(nomAbrege('École primaire de Moungali 3', 'PRIMAIRE', abrev)).toBe(
      'EP Moungali 3',
    );
    expect(nomAbrege("ECOLE PRIMAIRE D'ETI", 'PRIMAIRE', abrev)).toBe('EP ETI');
    expect(nomAbrege('Moungali 3', 'PRIMAIRE', abrev)).toBe('EP Moungali 3');
    expect(nomAbrege('EP Moungali 3', 'PRIMAIRE', abrev)).toBe('EP Moungali 3');
    expect(nomAbrege('E.P. Moungali 3', 'PRIMAIRE', abrev)).toBe(
      'EP Moungali 3',
    );
    expect(
      nomAbrege(
        'Centre d’éducation préscolaire de Bacongo',
        'PRESCOLAIRE',
        abrev,
      ),
    ).toBe('CEP Bacongo');
    expect(nomAbrege('CEG Boko-Songho', 'COLLEGE', abrev)).toBe(
      'CEG Boko-Songho',
    );
    expect(
      nomAbrege('Collège d’enseignement général de Mindouli', 'COLLEGE', abrev),
    ).toBe('CEG Mindouli');
    expect(nomAbrege('Lycée Savorgnan de Brazza', 'LYCEE', abrev)).toBe(
      'Lycée Savorgnan de Brazza',
    );
    expect(nomAbrege('Bouansa', 'LYCEE', abrev)).toBe('Lycée Bouansa');
  });

  it('remet en clair un nom devenu une date dans Excel', () => {
    expect(
      nomAbrege('Prescolaire 1963-08-15 00:00:00', 'PRESCOLAIRE', abrev),
    ).toBe('CEP 15 Août 1963');
    expect(nomAbrege('1963-08-15 00:00:00', 'PRIMAIRE', abrev)).toBe(
      'EP 15 Août 1963',
    );
    expect(
      nomAbrege('Centre 2000-01-01 00:00:00', 'ALPHABETISATION', abrev),
    ).toBe('Centre 1er Janvier 2000');
  });

  it('ne coupe pas un nom qui commence comme une abréviation', () => {
    expect(nomAbrege('Epena', 'PRIMAIRE', abrev)).toBe('EP Epena');
    expect(nomAbrege('Cepaz', 'PRESCOLAIRE', abrev)).toBe('CEP Cepaz');
  });

  it('laisse tels quels l’alphabétisation et les établissements sans cycle', () => {
    expect(
      nomAbrege(
        'Centre d’alphabétisation de Talangaï',
        'ALPHABETISATION',
        abrev,
      ),
    ).toBe('Centre d’alphabétisation de Talangaï');
    expect(nomAbrege('Institut Dupont', null, abrev)).toBe('Institut Dupont');
  });

  it('range par cycle puis par nom', () => {
    const l = [
      { nom: 'Lycée B', cycle: 'LYCEE' },
      { nom: 'EP Zanaga', cycle: 'PRIMAIRE' },
      { nom: 'Centre A', cycle: 'ALPHABETISATION' },
      { nom: 'CEP Mfilou', cycle: 'PRESCOLAIRE' },
      { nom: 'EP Abala', cycle: 'PRIMAIRE' },
      { nom: 'CEG X', cycle: 'COLLEGE' },
    ].sort(parCycleEtNom);
    expect(l.map((x) => x.nom)).toEqual([
      'CEP Mfilou',
      'EP Abala',
      'EP Zanaga',
      'CEG X',
      'Lycée B',
      'Centre A',
    ]);
  });
});
