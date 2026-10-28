import { categorieDe, gradeEchelon, observationDe } from './categories';

describe('Nominations : lecture de la base de la DGRHAS', () => {
  it('reconnaît la fonction selon le cycle', () => {
    const cas: [string, string, string][] = [
      ['1-Préscolaire', '1-Directrice', 'PRESCO_DIRECTEUR'],
      ['1-Préscolaire', '4-Econome', 'PRESCO_ECONOME'],
      ['1-Préscolaire', 'CPCEP - Nkeni Alima', 'PRESCO_CP'],
      ['1-Préscolaire', 'ICCP', 'PRESCO_ICCS'],
      ['1-Préscolaire', 'ICAP', 'PRESCO_ICAP'],
      ['2-Primaire', '1-Directeur', 'PRIMAIRE_DIRECTEUR'],
      ['2-Primaire', 'I-Directeur', 'PRIMAIRE_DIRECTEUR'],
      ['2-Primaire', '4-Econome Insp', 'PRIMAIRE_ECONOME_INSP'],
      ['2-Primaire', 'C.P. Primaire', 'PRIMAIRE_CP'],
      ['2-Primaire', 'Conseiller.P - Gamboma 1', 'PRIMAIRE_CP'],
      ['2-Primaire', 'ICCS - Nkeni Alima', 'PRIMAIRE_ICCS'],
      ['2-Primaire', 'ICSS', 'PRIMAIRE_ICCS'],
      ['3-Alphab.', '1-CDAR', 'ALPHA_CDAR'],
      ['3-Alphab.', 'CTAEF', 'ALPHA_CTAR'],
      ['3-Alphab.', 'Cller Technique', 'ALPHA_CTAR'],
      ['3-Alphab.', '1-Directrice', 'ALPHA_DIRECTEUR'],
      ['4-Collège', '1-Directeur', 'COLLEGE_DIRECTEUR'],
      ['4-Collège', '2-D.E.', 'COLLEGE_DE'],
      ['4-Collège', '3-SURGE', 'COLLEGE_SG'],
      ['4-Collège', 'IDCAP', 'COLLEGE_IDCAP'],
      ['4-Collège', 'ICAP CEG', 'COLLEGE_ICAP'],
      ['4-Collège', 'ICEG-B1', 'COLLEGE_ICOORD'],
      ['4-Collège', 'Inspect Coordo CEG', 'COLLEGE_ICOORD'],
      ['5-Lycée', '1-Proviseur', 'LYCEE_PROVISEUR'],
      ['5-Lycée', '2-D.E.', 'LYCEE_DE'],
      ['5-Lycée', '4-Intendant Lycée', 'LYCEE_INTENDANT'],
      ['5-Lycée', 'Inspecteur Délg', 'LYCEE_IDELEGUE'],
      ['5-Lycée', 'Insp. Coordonnateur', 'LYCEE_ICOORD'],
      ['01-Admin/DDEPPSA', 'C.S.E.P', 'DDEPPSA_CHEF_SERVICE'],
      ['0-Administration', 'CA. INRAP', 'ITIN_INRAP'],
    ];
    for (const [cycle, fonction, attendu] of cas)
      expect([cycle, fonction, categorieDe(cycle, fonction)]).toEqual([
        cycle,
        fonction,
        attendu,
      ]);
    expect(categorieDe('2-Primaire', 'Chauffeur')).toBeNull();
  });

  it('lit l’observation : décidée ou proposée', () => {
    expect(observationDe('Reconduite')).toEqual({
      obs: 'RECONDUIT',
      proposee: false,
    });
    expect(observationDe('A Promouvoir')).toEqual({
      obs: 'PROMU',
      proposee: true,
    });
    expect(observationDe('Mutée')).toEqual({ obs: 'MUTE', proposee: false });
    expect(observationDe('Permuté')).toEqual({
      obs: 'PERMUTE',
      proposee: false,
    });
    expect(observationDe('Relevé')).toEqual({ obs: 'RELEVE', proposee: false });
    expect(observationDe('A POURVOIR')).toBeNull();
  });

  it('sépare le grade et l’échelon', () => {
    expect(gradeEchelon('Inst.5')).toEqual({ grade: 'Inst', echelon: '5' });
    expect(gradeEchelon('PCEG. 4e')).toEqual({ grade: 'PCEG', echelon: '4' });
    expect(gradeEchelon('PCL 1')).toEqual({ grade: 'PCL', echelon: '1' });
    expect(gradeEchelon('PCEG')).toEqual({ grade: 'PCEG', echelon: null });
  });
});
