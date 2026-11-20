import {
  cleEcole,
  cycleDeCategorie,
  cycleDuNom,
  faute,
  estHorsEcole,
  nomAffiche,
  ressemblance,
  vraisemblance,
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

  it('sépare la lettre de groupe collée au nombre', () => {
    expect(cleEcole('EP 31 JUILLET 1968B')).toBe('31 JUILLET 1968 B');
  });

  it.each([
    ["CENTRE D'ECADION PRESCOLAIRE DE LINZOLO", 'LINZOLO'],
    ['CENTRE PRESCOLIARE DE LOUINGUI', 'LOUINGUI'],
    ["CETRE D'EDUCATION PRESCOLAIRE DE MOSSENDJO", 'MOSSENDJO'],
    ['CEP PRECOLAIRE DE KINTELE', 'KINTELE'],
    ["CENTRE D'DUCATION PRESCOLAIRE EVANGELIQUE CITE", 'EVANGELIQUE CITE'],
  ])('reconnaît le libellé mal écrit : %s', (nom, cle) => {
    expect(cycleDuNom(nom)).toBe('PRESCOLAIRE');
    expect(cleEcole(nom)).toBe(cle);
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
    // Deux groupes : deux écoles, pas une faute de frappe
    expect(faute('NOTRE DAME DE FATIMA A', 'NOTRE DAME DE FATIMA B')).toBe(
      false,
    );
    expect(faute('NOTRE DAME DE FATIMA B', 'NOTRE DAME DE FATIAMA B')).toBe(
      true,
    );
    expect(faute('NKAYI', 'NKAY')).toBe(false);
    expect(faute('LOUDIMA GARE', 'LOUDIMA POSTE')).toBe(false);
  });
});

describe('Écoles qui se ressemblent', () => {
  it.each([
    ['ALPHANCE MASSAMBA DEBAT DIATA', 'ALPHONSE MASSAMBA DEBAT', true],
    ['MASSAMBA DEBAT', 'ALPHONSE MASSAMBA DEBAT', true],
    ['KINSOUNDI', 'KISOUNDI', true],
    ['MOUNGALI 2', 'MOUNGALI 3', false],
    ['LIBERTE A', 'LIBERTE B', false],
    ['IGNIE A', 'IGNIE B', false],
    ['MADINGOU', 'MOUYONDZI', false],
    ['NKAYI', 'LOUDIMA', false],
    ['PRESCOLAIRE', 'CENTRE D ECADION PRESCOLAIRE DE LINZOLO', false],
    ['31 AOUT 1968 A', '31 JUILLET 1968 B', false],
    ['31 AOUT 1968', '31 JUILLET 1968', false],
    [
      'CATHOLIQUE CONVENTIONNEE SAINT LOUIS B',
      'CONVENTIONNEE CATHOLIQUE SAINT LOUIS B',
      true,
    ],
  ])('%s / %s → %s', (a, b, proche) => {
    expect(ressemblance(a, b) >= 0.75).toBe(proche);
  });
});

describe('Probabilité que deux écoles soient la même', () => {
  const e = (
    nom: string,
    organigramme = false,
    cycle: string | null = 'PRESCOLAIRE',
  ) => ({
    cle: cleEcole(nom),
    organigramme,
    cycle,
  });
  it.each([
    ['CEP B. M Mavoungou', 'CEP BERNARD MOUNTOU MAVOUNGOU', 'TRES_PROBABLE'],
    ['CEP J. D. TCHIMBAKALA', 'CEP JEAN DENIS TCHIMBAKALA', 'TRES_PROBABLE'],
    ['CEP CP KINKALA', 'CEP Kinkala', 'TRES_PROBABLE'],
    ['EP BANGUISSA Gabriel', 'EP GABRIEL BANGUISSA', 'TRES_PROBABLE'],
    ['CEP Etoumbi', 'CEP Etoumbi Centre', 'PROBABLE'],
    ['CEP Moutabala', 'CEP Joseph Moutabala', 'PROBABLE'],
    ['EP Abala', 'EP Obala', 'A_VERIFIER'],
    ['CEP Mindouli', 'CEP Mindouli G', 'A_VERIFIER'],
    ['CEP LOULOMBO', 'CEP Loulombo Gare', 'A_VERIFIER'],
    ['EP Abala Centre', 'EP Abala-Ndolo', 'A_VERIFIER'],
    ['EP Kayes-Centre B', 'EP BODISSA DE KAYES', 'A_VERIFIER'],
    ['CEP Kinkala', 'INTERNAT DU LYCEE DE KINKALA', 'PEU_PROBABLE'],
    [
      'CEP Sibiti',
      "L'INSPECTION DE L'ENSEIGNEMENT PRIMAIRE SIBITI A",
      'PEU_PROBABLE',
    ],
    ['CEP Makola Caserne', 'CEP Makola Centre', 'PEU_PROBABLE'],
    ['EP LIBERTE A', 'EP LIBERTE B', 'PEU_PROBABLE'],
  ])('%s / %s → %s', (a, b, niveau) => {
    const cycle = /^EP/.test(a) ? 'PRIMAIRE' : 'PRESCOLAIRE';
    expect(vraisemblance(e(a, false, cycle), e(b, false, cycle)).niveau).toBe(
      niveau,
    );
  });
  it('deux écoles de l’organigramme : peu probable', () => {
    expect(
      vraisemblance(e('CEP Makola Centre', true), e('CEP Makola Village', true))
        .niveau,
    ).toBe('PEU_PROBABLE');
  });
  it('un CEG écrit en toutes lettres : la même école', () => {
    expect(
      vraisemblance(
        e('CEG OUESSO', false, 'COLLEGE'),
        e("COLLEGE D'ENSEIGNEMENT GENERAL DE OUESSO", false, 'COLLEGE'),
      ).niveau,
    ).toBe('TRES_PROBABLE');
  });
});
