import {
  cleEcole,
  cycleDeCategorie,
  cycleDuNom,
  faute,
  estHorsEcole,
  nomAffiche,
} from './effectifs-ecoles-regles';

describe('Nom affiché d’une école', () => {
  it.each([
    ['CENTRE PRESCOLAIRE 15 Août 1963', 'PRESCOLAIRE', 'CEP 15 Août 1963'],
    ["CENTRE PRESCOLAIRE D'IGNIE", 'PRESCOLAIRE', 'CEP IGNIE'],
    ["CENTRE D'EDUCATION PRESCOLAIRE DE Kintélé", 'PRESCOLAIRE', 'CEP Kintélé'],
    ['CENTRE PRESCOLAIRELine Renaud', 'PRESCOLAIRE', 'CEP LINE RENAUD'],
    ['Château d’Eau', 'PRESCOLAIRE', 'CEP Château d’Eau'],
    ['LYCEE DE DOLISIE II', 'LYCEE', 'Lycée DOLISIE II'],
    ['EP IGNIE "A"', 'PRIMAIRE', 'EP IGNIE "A"'],
    ['COMPLEXE SCOLAIRE', null, 'COMPLEXE SCOLAIRE'],
  ])('%s → %s', (nom, cycle, attendu) => {
    expect(nomAffiche(nom, cycle as never)).toBe(attendu);
  });

  it('lit « NKAYI I » comme « NKAYI 1 »', () => {
    expect(cleEcole('CEP NKAYI I')).toBe('NKAYI 1');
  });
});

describe('Écoles écrites à la main (Banque mondiale, 16/11/2026)', () => {
  it.each([
    ["CENTRE D'EDUCATION PRESCOLAIRE DE NANGA", 'PRESCOLAIRE', 'NANGA'],
    ['CEP DE NANGA', 'PRESCOLAIRE', 'NANGA'],
    ['C.E.P de Nanga', 'PRESCOLAIRE', 'NANGA'],
    ['Prescolaire Nanga', 'PRESCOLAIRE', 'NANGA'],
    ['C.E.PRESCOLAIRE DE LINNENGUE', 'PRESCOLAIRE', 'LINNENGUE'],
    ['CEP/Sembé', 'PRESCOLAIRE', 'SEMBE'],
    ['CENTRE PRESCOLAIRE Moungali 3', 'PRESCOLAIRE', 'MOUNGALI 3'],
    ['Prescolaire Moungali3', 'PRESCOLAIRE', 'MOUNGALI 3'],
    ['CEP 08 FEVRIER 1964', 'PRESCOLAIRE', '8 FEVRIER 1964'],
    ['CEP 8 février 1964', 'PRESCOLAIRE', '8 FEVRIER 1964'],
    ["CENTRE D'EDUCATION CENTRE VILLE", 'PRESCOLAIRE', 'CENTRE VILLE'],
    ['MBALA PROSPER', null, 'MBALA PROSPER'],
    ['LYCEE DE DOLISIE II', 'LYCEE', 'DOLISIE 2'],
    ['Lycée de Dolisie 2', 'LYCEE', 'DOLISIE 2'],
    ["LYCEE D'ENSEIGNEMENT GENERAL DE KINTELE", 'LYCEE', 'KINTELE'],
    ['CEG DE NGAMABA TSALAKOUA', 'COLLEGE', 'NGAMABA TSALAKOUA'],
    ['École primaire de Moungali 3', 'PRIMAIRE', 'MOUNGALI 3'],
    ['EP Moungali 3', 'PRIMAIRE', 'MOUNGALI 3'],
    ["CENTRE D'ALPHABETISATION DU MARCHE", 'ALPHABETISATION', 'MARCHE'],
    ['Ion-Ctre', null, 'ION CENTRE'],
    ['CENTRE PRESCOLAIRELine Renaud', 'PRESCOLAIRE', 'LINE RENAUD'],
    ["CONTRE D'EDUCATION PRESCOLAIRE DE MADINGOU", 'PRESCOLAIRE', 'MADINGOU'],
    ["CENTRE D'EVEIL COMMUNAUTAIRE DE MOKEKO", 'PRESCOLAIRE', 'MOKEKO'],
    [
      "CENTRE DE RESCOLARISATION ET D'ALPHABETISATION D'OWANDO",
      'ALPHABETISATION',
      'OWANDO',
    ],
  ])('%s → %s, %s', (nom, cycle, cle) => {
    expect(cycleDuNom(nom)).toBe(cycle);
    expect(cleEcole(nom)).toBe(cle);
  });

  it('reconnaît les lieux qui ne sont pas des écoles', () => {
    expect(estHorsEcole('INSPECTION PRESCOLAIRE DE DJAMBALA')).toBe(true);
    expect(
      estHorsEcole(
        "IRECTION DEPARTEMENTALE DE L'ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE",
      ),
    ).toBe(true);
    expect(estHorsEcole('CABINET DU MINISTRE')).toBe(true);
    expect(estHorsEcole('CEP DE NANGA')).toBe(false);
    for (const x of [
      'INPECTION PRIMAIRE DE NTOKOU',
      'INSPECION DES CEG ZONE I OWANDO',
      'DEPPSA BOUENZA',
      'MAIRIE DE LOUKOLELA',
      'SOUS PREFECTURE DE MABOMBO',
      'COORDINATION DEPARTEMENTALE DE L ALPHABETISATION',
      'CSI DE BILINGA',
      'COMUNAUTE URBAINE DE LOUTETE',
    ])
      expect(estHorsEcole(x)).toBe(true);
    expect(estHorsEcole('LYCEE DE LA REVOLUTION')).toBe(false);
  });

  it('tire le cycle de la catégorie de bourse', () => {
    expect(cycleDeCategorie('COM_PRESCOLAIRE')).toBe('PRESCOLAIRE');
    expect(cycleDeCategorie('PRIMAIRE')).toBe('PRIMAIRE');
    expect(cycleDeCategorie('COM_POST_ALPHA')).toBe('ALPHABETISATION');
    expect(cycleDeCategorie('BEAUX_ARTS')).toBeNull();
    expect(cycleDeCategorie(null)).toBeNull();
  });

  it('reconnaît une faute de frappe, pas une autre école', () => {
    expect(faute('MOUYONDZI', 'MOYONDZI')).toBe(true);
    expect(faute('MOUNGALI 2', 'MOUNGALI 3')).toBe(false);
    expect(faute('NKAYI', 'NKAY')).toBe(false);
    expect(faute('LOUDIMA GARE', 'LOUDIMA POSTE')).toBe(false);
  });
});
