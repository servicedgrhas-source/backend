import {
  codeMatricule,
  infosDuRapport,
  colonneDe,
  compareNoms,
  motsDuNom,
  naissanceDe,
  partieDe,
  statutDe,
  vide,
} from './rapprochement-rapports-regles';

describe('Colonnes d’un état nominatif de DDEPPSA', () => {
  it.each([
    ['Noms et prénoms', 'nom'],
    ['N°', 'numero'],
    ['Année naiss', 'naissance'],
    ['Annéenaiss', 'naissance'],
    ['G/E', 'grade'],
    ['Stat', 'statut'],
    ['Fonct', 'fonction'],
    ['Ecole d’origine', 'ecole'],
    ['Lieu de service', 'ecole'],
    ['Situat matri', 'situation'],
    ['Code serv', 'codeService'],
    ['Ind.', 'indice'],
    ['Mle solde', 'matricule'],
    ['Acad', 'diplomeAcad'],
    ['prof', 'diplomeProf'],
    ['recr', 'recrutement'],
    ['Dern. promot', 'promotion'],
    ['Arrv départ', 'arrivee'],
    ['Date de prise de service', 'arrivee'],
    ['Département', 'departement'],
  ])('%s → %s', (titre, colonne) => {
    expect(colonneDe(titre)).toBe(colonne);
  });
});

describe('Valeurs du rapport', () => {
  it('les cases vides', () => {
    expect(vide('/')).toBe(true);
    expect(vide(' :/')).toBe(true);
    expect(vide('C0')).toBe(false);
  });
  it.each([
    ['fonct', 'FONCTIONNAIRE'],
    ['Fonct', 'FONCTIONNAIRE'],
    ['Com.', 'COMMUNAUTAIRE'],
    ['Final', 'VOLONTAIRE'],
    ['Contractuel', 'CONTRACTUEL'],
    ['Cotr.', 'CONTRACTUEL'],
    ['Bénév', 'VOLONTAIRE'],
    ['Bén', 'VOLONTAIRE'],
    ['Vol.', 'VOLONTAIRE'],
    ['/', null],
  ])('statut %s → %s', (brut, statut) => {
    expect(statutDe(brut)).toBe(statut);
  });
  it('les parties du rapport', () => {
    expect(partieDe('A2 - Secteur privé').secteur).toBe('PRIVE');
    expect(partieDe('I-3 Secteur Conventionné').secteur).toBe('CONVENTIONNE');
    expect(
      partieDe(
        'Personnel administratif en service dans les centres d’éducation du préscolaire',
      ),
    ).toEqual({
      secteur: null,
      cycle: 'PRESCOLAIRE',
      rubrique: 'ADMINISTRATIF',
    });
  });
  it('la naissance', () => {
    expect(naissanceDe('1987')).toEqual({ annee: 1987, date: null });
    expect(naissanceDe('6/2/1987')).toEqual({
      annee: 1987,
      date: '1987-02-06',
    });
    expect(naissanceDe('1987-02-06')).toEqual({
      annee: 1987,
      date: '1987-02-06',
    });
    expect(naissanceDe('/')).toEqual({ annee: null, date: null });
    // Dates impossibles des rapports : pas de date (l'import ne bloque plus), l'année si plausible
    expect(naissanceDe('20/20/1978')).toEqual({ annee: 1978, date: null });
    expect(naissanceDe('31/02/1990')).toEqual({ annee: 1990, date: null });
    expect(naissanceDe('00/01/1900')).toEqual({ annee: null, date: null });
    expect(naissanceDe('19/06/1094')).toEqual({ annee: null, date: null });
    expect(naissanceDe('14/07/12964')).toEqual({ annee: null, date: null });
  });
  it('le matricule', () => {
    expect(codeMatricule('233 792 R')).toBe('233792R');
  });
});

describe('Comparer un nom du rapport à la base', () => {
  const c = (a: string, b: string) => compareNoms(motsDuNom(a), motsDuNom(b));
  it('des prénoms en plus dans la base', () => {
    expect(
      c('MABIALA PEMBE Glavie', 'MABIALA PEMBE Laurette Glavie').complet,
    ).toBe(true);
  });
  it('une lettre de plus ou de moins', () => {
    expect(c('TSOKO Juslie Evane', 'NTSOKO Juslie Evane').complet).toBe(true);
    expect(c('NGANGOYE Espoir', 'NGANGOYE Espoire').complet).toBe(true);
  });
  it('un nom proche mais pas complet', () => {
    const r = c(
      'LEMBE OKOMBA Michelle Patricia',
      'LEMBA-OKOMBA Michelle Patience',
    );
    expect(r.score).toBeGreaterThan(0.75);
  });
  it('deux personnes différentes', () => {
    expect(c('MINGA MAMPILA Zoe', 'DIAYANDI Kevin Odilon').score).toBeLessThan(
      0.4,
    );
  });
});

describe('Autres informations du bottin', () => {
  it('lit genre, nationalité, situation, enfants, échelon, diplômes', () => {
    const r = infosDuRapport(
      {
        Genre: 'F',
        Nat: 'Cong',
        'Situat matri': 'Célibataire',
        'Situation (écrite)': 'C.04',
        'G/E': 'I.C 1er',
        Catégorie: '2',
        Prof: 'CFEEN-CAP',
        Acad: 'BAC A4',
        Recr: '2023',
        Téléphone: '06 649 12 52',
      },
      'Enseig.',
    );
    expect(r).toEqual({
      GENRE: 'F',
      NATIONALITE: 'Congolaise',
      SITUATION_MATRIMONIALE: 'CELIBATAIRE',
      NOMBRE_ENFANTS: '4',
      TELEPHONE_1: '06 649 12 52',
      FONCTION: 'Enseignant',
      CATEGORIE: 'II',
      ECHELON: '1',
      DIPLOME_PRO: 'CFEEN CAP',
      AUTRES_DIPLOMES: 'BAC | A4 | |',
    });
  });
  it('« C3 » du Niari, « M » seul, échelon en colonne', () => {
    expect(infosDuRapport({ 'Situat matri': 'C3', Échelon: '7e' })).toEqual({
      SITUATION_MATRIMONIALE: 'CELIBATAIRE',
      NOMBRE_ENFANTS: '3',
      ECHELON: '7',
    });
    expect(infosDuRapport({ 'Situat matri': 'M' })).toEqual({
      SITUATION_MATRIMONIALE: 'MARIE',
    });
  });
  it('laisse le douteux : « Active », « ? », année seule', () => {
    expect(
      infosDuRapport({ Recr: '2014', Genre: '?', Prof: '2023' }, 'Active'),
    ).toEqual({});
  });
});
