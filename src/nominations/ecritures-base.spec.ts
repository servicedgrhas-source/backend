import {
  CATEGORIE,
  cycleBase,
  echelonBase,
  fonctionBase,
  gradeAbrege,
  repereNomination,
} from './categories';

describe('Écritures de la base des nominations (DGRHAS, 29/10/2026)', () => {
  it('le grade s’écrit en abrégé, comme dans la base', () => {
    expect(gradeAbrege('INSTITUTEUR')).toBe('Inst.');
    expect(gradeAbrege('INSTITUTEUR ADJOINT')).toBe('Inst. A.');
    expect(gradeAbrege('PROFESSEUR CERTIFIE DE LYCEE')).toBe('PCL');
    expect(gradeAbrege('PROFESSEUR CEG')).toBe('PCEG');
    expect(gradeAbrege('PROFESSEUR TECHNIQUE ADJOINT')).toBe('PTA');
    // Déjà abrégé : inchangé
    expect(gradeAbrege('Inst. C.')).toBe('Inst. C.');
    expect(gradeAbrege('PCL')).toBe('PCL');
  });
  it('un contractuel : « Inst. C. », d’après sa qualification', () => {
    expect(
      gradeAbrege('CONTRACTUEL CATEG. C ECHELLE 8', {
        statut: 'CONTRACTUEL',
        qualification: 'Instituteur',
      }),
    ).toBe('Inst. C.');
    expect(gradeAbrege('INSTITUTEUR', { statut: 'CONTRACTUEL' })).toBe(
      'Inst. C.',
    );
    expect(
      gradeAbrege('CONTRACTUEL CATEG. C ECHELLE 8', { statut: 'CONTRACTUEL' }),
    ).toBe('Contr.');
  });
  it('échelon, cycle, fonction et repère', () => {
    expect(echelonBase('1er')).toBe('1');
    expect(echelonBase('4e')).toBe('4');
    expect(echelonBase('HC 2')).toBe('HC 2');
    expect(cycleBase(CATEGORIE.get('COLLEGE_DE'))).toBe('4-Collège');
    expect(fonctionBase(CATEGORIE.get('COLLEGE_DE'))).toBe('2-D.E.');
    expect(fonctionBase(CATEGORIE.get('PRIMAIRE_DIRECTEUR'), 'F')).toBe(
      '1-Directrice',
    );
    expect(fonctionBase(CATEGORIE.get('COLLEGE_SG'))).toBe('3-SURGE');
    expect(repereNomination('LYCEE_PROVISEUR')).toBe('Nomm. Provis.');
  });
});
