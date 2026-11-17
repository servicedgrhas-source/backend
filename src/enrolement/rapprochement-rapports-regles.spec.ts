import {
  codeMatricule,
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
    ['/', null],
  ])('statut %s → %s', (brut, statut) => {
    expect(statutDe(brut)).toBe(statut);
  });
  it('les parties du rapport', () => {
    expect(partieDe('A2 - Secteur privé').secteur).toBe('PRIVE');
    expect(partieDe('I-3 Secteur Conventionné').secteur).toBe('CONVENTIONNE');
    expect(partieDe('Personnel administratif en service dans les centres d’éducation du préscolaire')).toEqual({
      secteur: null,
      cycle: 'PRESCOLAIRE',
      rubrique: 'ADMINISTRATIF',
    });
  });
  it('la naissance', () => {
    expect(naissanceDe('1987')).toEqual({ annee: 1987, date: null });
    expect(naissanceDe('6/2/1987')).toEqual({ annee: 1987, date: '1987-02-06' });
    expect(naissanceDe('1987-02-06')).toEqual({ annee: 1987, date: '1987-02-06' });
    expect(naissanceDe('/')).toEqual({ annee: null, date: null });
  });
  it('le matricule', () => {
    expect(codeMatricule('233 792 R')).toBe('233792R');
  });
});

describe('Comparer un nom du rapport à la base', () => {
  const c = (a: string, b: string) => compareNoms(motsDuNom(a), motsDuNom(b));
  it('des prénoms en plus dans la base', () => {
    expect(c('MABIALA PEMBE Glavie', 'MABIALA PEMBE Laurette Glavie').complet).toBe(true);
  });
  it('une lettre de plus ou de moins', () => {
    expect(c('TSOKO Juslie Evane', 'NTSOKO Juslie Evane').complet).toBe(true);
    expect(c('NGANGOYE Espoir', 'NGANGOYE Espoire').complet).toBe(true);
  });
  it('un nom proche mais pas complet', () => {
    const r = c('LEMBE OKOMBA Michelle Patricia', 'LEMBA-OKOMBA Michelle Patience');
    expect(r.score).toBeGreaterThan(0.75);
  });
  it('deux personnes différentes', () => {
    expect(c('MINGA MAMPILA Zoe', 'DIAYANDI Kevin Odilon').score).toBeLessThan(0.4);
  });
});
