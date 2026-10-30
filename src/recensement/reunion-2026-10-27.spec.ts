import {
  completerReference,
  type EchelleGrille,
  echelonsDus,
  natureEnEntier,
} from './valeurs';

const grille: EchelleGrille[] = [
  {
    code: '3',
    libelle: 'Échelle 3',
    nombreEchelons: 16,
    dureeEchelonMois: null,
    echelonsHorsClasse: 0,
    libelleHorsClasse: 'Hors classe',
    echelleSuivante: null,
  },
];
const config = { delaiPromotionMois: 24, delaiAvancementMois: 28 };
const REF = '2026-12-31';

describe('Réunion DG du 27/10/2026', () => {
  it('la nature du texte s’écrit en entier', () => {
    expect(natureEnEntier('D n° 1203 du 12/03/2016')).toBe(
      'Décret n° 1203 du 12/03/2016',
    );
    expect(natureEnEntier('Arr. N°45')).toBe('Arrêté n° 45');
    expect(natureEnEntier('ARRETE N° 45')).toBe('Arrêté n° 45');
    expect(natureEnEntier('décret n°2020-12')).toBe('Décret n° 2020-12');
    expect(natureEnEntier('D 1203')).toBe('Décret 1203');
    expect(natureEnEntier('Note de service 12')).toBe('Note de service 12');
    expect(natureEnEntier('Décret n° 1203')).toBe('Décret n° 1203');
  });

  it('la référence complète ne répète pas la nature', () => {
    const r = completerReference({
      TEXTE_RECRUTEMENT: 'D n° 1203 du 12/03/2016',
      CATEGORIE: 'I',
    });
    expect(r).toBe('Décret n° 1203 du 12/03/2016');
    expect(
      completerReference({ TEXTE_RECRUTEMENT: '1203', CATEGORIE: 'I' }),
    ).toMatch(/^Décret n° 1203/);
  });

  it('échelons dus depuis la dernière promotion (fonctionnaire : 2 ans)', () => {
    const r = echelonsDus(
      config,
      'FONCTIONNAIRE',
      { DATE_GRADE: '2018-01-01', ECHELLE: '3', ECHELON: '5' },
      grille,
      REF,
    );
    expect(r?.dateManquante).toBe(false);
    expect(r?.attendues.map((x) => x.date)).toEqual([
      '2020-01-01',
      '2022-01-01',
      '2024-01-01',
      '2026-01-01',
    ]);
    expect(r?.attendues.at(-1)?.echelon).toBe(9);
  });

  it('par année : l’échelon de l’année est acquis au 31 décembre', () => {
    const d = { DATE_GRADE: '2024-03-01', ECHELLE: '3', ECHELON: '2' };
    // En octobre 2026, l'échelon de 2026 (mars) n'est pas encore acquis…
    expect(
      echelonsDus(config, 'FONCTIONNAIRE', d, grille, '2026-10-29')?.attendues,
    ).toEqual([]);
    // … il l'est dans la situation au 31/12/2026
    const r = echelonsDus(config, 'FONCTIONNAIRE', d, grille, REF);
    expect(r?.attendues.map((x) => [x.date, x.echelon])).toEqual([
      ['2026-03-01', 3],
    ]);
  });

  it('contractuel : un avancement tous les 2 ans et 4 mois', () => {
    const r = echelonsDus(
      config,
      'CONTRACTUEL',
      { DATE_GRADE: '2020-01-01', ECHELLE: '3', ECHELON: '1' },
      grille,
      REF,
    );
    expect(r?.attendues.map((x) => x.date)).toEqual([
      '2022-05-01',
      '2024-09-01',
    ]);
  });

  it('au 4e échelon sans date de dernière promotion : la date est à renseigner', () => {
    const r = echelonsDus(
      config,
      'FONCTIONNAIRE',
      { DATE_RECRUTEMENT: '2016-01-01', ECHELLE: '3', ECHELON: '4' },
      grille,
      REF,
    );
    expect(r?.dateManquante).toBe(true);
    expect(r?.attendues).toEqual([]);
  });

  it('au 1er échelon depuis l’entrée : les échelons dus partent de l’intégration', () => {
    const r = echelonsDus(
      config,
      'FONCTIONNAIRE',
      { DATE_RECRUTEMENT: '2016-01-01', ECHELLE: '3', ECHELON: '1' },
      grille,
      REF,
    );
    expect(r?.dateManquante).toBe(false);
    expect(r?.attendues).toHaveLength(5);
    expect(r?.attendues.at(-1)?.echelon).toBe(6);
  });

  it('au dernier échelon de l’échelle : rien n’est dû', () => {
    const r = echelonsDus(
      config,
      'FONCTIONNAIRE',
      { DATE_GRADE: '2010-01-01', ECHELLE: '3', ECHELON: '16' },
      grille,
      REF,
    );
    expect(r?.attendues).toEqual([]);
  });

  it('ni fonctionnaire ni contractuel : pas de calcul', () => {
    expect(
      echelonsDus(
        config,
        'VOLONTAIRE',
        { DATE_GRADE: '2010-01-01' },
        grille,
        REF,
      ),
    ).toBeNull();
  });
});
