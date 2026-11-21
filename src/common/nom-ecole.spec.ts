import { nomEcole, nomStructureNorme, sansTypeEcole } from './nom-ecole';

/** Nom des écoles : préfixe du cycle + nom propre (DG, 21/11/2026). */
describe('Nom des écoles', () => {
  it('retire le type écrit, avec ou sans accents', () => {
    for (const t of [
      'Lycée Minangou Laurent',
      'LYCEE MINANGOU LAURENT',
      'ecole primaire Minangou Laurent',
      'École primaire publique Minangou Laurent',
      'EP MINANGOU LAURENT',
      'E.P. Minangou Laurent',
      'C.E.G. Minangou Laurent',
      'Collège d’enseignement général Minangou Laurent',
      "LYCÉE DE L'ENSEIGNEMENT GÉNÉRAL Minangou Laurent",
      "Centre d'éducation préscolaire Minangou Laurent",
      'Centre d’alphabétisation Minangou Laurent',
      'CA Minangou Laurent',
      'LEG Minangou Laurent',
    ])
      expect(sansTypeEcole(t).toUpperCase()).toBe('MINANGOU LAURENT');
  });

  it('donne le préfixe du cycle', () => {
    expect(nomEcole('PRIMAIRE', 'Lycée Minangou Laurent')).toBe(
      'EP MINANGOU LAURENT',
    );
    expect(nomEcole('PRESCOLAIRE', 'Minangou Laurent')).toBe(
      'CEP MINANGOU LAURENT',
    );
    expect(nomEcole('COLLEGE', 'École primaire Minangou')).toBe('CEG MINANGOU');
    expect(nomEcole('LYCEE', 'LYCEE DE MADINGOU')).toBe('LEG DE MADINGOU');
    expect(nomEcole('ALPHABETISATION', "Centre d'Alphabetisation Mengo")).toBe(
      'CA MENGO',
    );
  });

  it('garde ce qui fait le nom', () => {
    expect(sansTypeEcole('CEP CENTRE VILLE')).toBe('CENTRE VILLE');
    expect(sansTypeEcole('École primaire EPAGNE')).toBe('EPAGNE');
    expect(sansTypeEcole('CAMP 15 AOUT')).toBe('CAMP 15 AOUT');
    // Une initiale après le type reste (et le nom normé ne change plus ensuite)
    expect(nomEcole('PRIMAIRE', 'École primaire P. Ndzoko')).toBe(
      'EP P. NDZOKO',
    );
    expect(nomEcole('PRIMAIRE', 'EP P.M.D.')).toBe('EP P.M.D.');
    expect(sansTypeEcole('EPP Ngoko')).toBe('Ngoko');
    expect(nomEcole('ALPHABETISATION', 'CA ALPHA MOUKONDO')).toBe(
      'CA MOUKONDO',
    );
    expect(sansTypeEcole('École')).toBe('École');
    expect(nomEcole(null, 'École primaire X')).toBe('École primaire X');
  });

  it('répare les dates abîmées par Excel', () => {
    expect(sansTypeEcole("Centre d'Alphabetisation 1964-02-08 00:00:00")).toBe(
      '8 Février 1964',
    );
    expect(sansTypeEcole('CA 1969-12-01')).toBe('1er Décembre 1969');
  });

  it('ne touche que les écoles', () => {
    expect(
      nomStructureNorme({
        type: 'INSPECTION',
        cycle: 'PRIMAIRE',
        nom: 'Inspection X',
      }),
    ).toBe('Inspection X');
  });
});
