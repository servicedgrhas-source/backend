import {
  type EchelleGrille,
  echelonHorsGrille,
  libelleEchelon,
  prochainAvancement,
  promotionsAttendues,
  rangEchelon,
  trouverEchelle,
} from './valeurs';

const E = (
  code: string,
  nombreEchelons: number | null,
  dureeEchelonMois: number | null,
  echelleSuivante: string | null = null,
  echelonsHorsClasse = 0,
): EchelleGrille => ({
  code,
  libelle: `Échelle ${code}`,
  nombreEchelons,
  dureeEchelonMois,
  echelonsHorsClasse,
  libelleHorsClasse: 'Hors classe',
  echelleSuivante,
});
/** Sans le libellé de l'échelon (« 5 », « HC 2 »), pour comparer les dates et les rangs */
const sansLibelle = <T extends { echelonLibelle: string }>(l: T[]) =>
  l.map((x) => {
    const y: Partial<T> = { ...x };
    delete y.echelonLibelle;
    return y;
  });
const grille = [E('1', 4, 24, '2'), E('2', 4, 36), E('3', 16, null)];
const config = { delaiPromotionMois: 24, delaiAvancementMois: 28 };

describe('Échelles et échelons (Administration › Référentiels › Échelles)', () => {
  it('l’échelle écrite dans la fiche est retrouvée', () => {
    expect(trouverEchelle(grille, '2')?.code).toBe('2');
    expect(trouverEchelle(grille, 'Échelle 2')?.code).toBe('2');
    expect(trouverEchelle(grille, 'ECHELLE 3')?.code).toBe('3');
    expect(trouverEchelle(grille, '')).toBeNull();
  });

  it('dernier échelon : passage au 1er échelon de l’échelle suivante, avec sa durée', () => {
    const l = promotionsAttendues({
      depuis: '2010-01-15',
      delaiMois: 24,
      dureeEchelle: true,
      echelon: 3,
      echelle: grille[0],
      echelles: grille,
      aujourdhui: '2016-01-01',
    });
    expect(sansLibelle(l)).toEqual([
      { date: '2012-01-15', echelon: 4, echelle: null },
      { date: '2014-01-15', echelon: 1, echelle: 'Échelle 2' },
      // Échelle 2 : 36 mois par échelon
      { date: '2017-01-15', echelon: 2, echelle: null },
    ]);
  });

  it('dernier échelon sans échelle suivante : on s’arrête', () => {
    const l = promotionsAttendues({
      depuis: '2010-01-15',
      delaiMois: 24,
      dureeEchelle: true,
      echelon: 3,
      echelle: grille[1],
      echelles: grille,
      aujourdhui: '2030-01-01',
    });
    expect(sansLibelle(l)).toEqual([
      { date: '2013-01-15', echelon: 4, echelle: null },
    ]);
  });

  it('durée d’échelon vide : le délai général (2 ans)', () => {
    const l = promotionsAttendues({
      depuis: '2020-06-30',
      delaiMois: 24,
      dureeEchelle: true,
      echelon: 1,
      echelle: grille[2],
      echelles: grille,
      aujourdhui: '2022-01-01',
    });
    expect(sansLibelle(l)).toEqual([
      { date: '2022-06-30', echelon: 2, echelle: null },
    ]);
  });

  it('avancement dû : rien après le dernier échelon de la dernière échelle', () => {
    const av = prochainAvancement(
      config,
      'FONCTIONNAIRE',
      { DATE_GRADE: '2015-01-01', ECHELLE: '2', ECHELON: '4' },
      grille,
    );
    expect(av).toMatchObject({ fin: true });
  });

  it('fonctionnaire : la durée de l’échelon de son échelle ; contractuel : 2 ans et 4 mois', () => {
    expect(
      prochainAvancement(
        config,
        'FONCTIONNAIRE',
        { DATE_GRADE: '2015-01-01', ECHELLE: '2', ECHELON: '1' },
        grille,
      )?.prochain,
    ).toBe('2018-01-01');
    expect(
      prochainAvancement(
        config,
        'CONTRACTUEL',
        { DATE_GRADE: '2015-01-01', ECHELLE: '2', ECHELON: '1' },
        grille,
      )?.prochain,
    ).toBe('2017-05-01');
  });

  it('sans échelle connue : comme avant (délais généraux)', () => {
    expect(
      prochainAvancement(config, 'FONCTIONNAIRE', { DATE_GRADE: '2022-03-15' })
        ?.prochain,
    ).toBe('2024-03-15');
  });

  describe('hors classe (DG, 29/10/2026 : après le 16e échelon, HC 1 à HC 4)', () => {
    const hc = E('1', 16, 24, null, 4);

    it('« HC 2 », « Hors classe 2 », « Hors catégorie 2 » : 2e échelon hors classe', () => {
      for (const v of [
        'HC 2',
        'hc2',
        'H.C. 2',
        'Hors classe 2',
        'Hors catégorie, 2e échelon',
      ])
        expect(rangEchelon(v, hc)).toBe(18);
      expect(rangEchelon('5e', hc)).toBe(5);
      expect(rangEchelon('1er', hc)).toBe(1);
      expect(libelleEchelon(18, hc)).toBe('HC 2');
      expect(libelleEchelon(16, hc)).toBe('16');
    });

    it('après le 16e : HC 1 à HC 4, puis plus rien', () => {
      const l = promotionsAttendues({
        depuis: '2010-01-01',
        delaiMois: 24,
        dureeEchelle: true,
        echelon: 15,
        echelle: hc,
        echelles: [hc],
        aujourdhui: '2040-01-01',
      });
      expect(l.map((x) => x.echelonLibelle)).toEqual([
        '16',
        'HC 1',
        'HC 2',
        'HC 3',
        'HC 4',
      ]);
      expect(l[1].echelle).toBe('Hors classe');
      expect(
        prochainAvancement(
          config,
          'FONCTIONNAIRE',
          { DATE_GRADE: '2015-01-01', ECHELLE: '1', ECHELON: 'HC 4' },
          [hc],
        ),
      ).toMatchObject({ fin: true });
    });

    it('l’échelon 17 n’existe pas ; HC 5 non plus', () => {
      expect(echelonHorsGrille('17', hc)).toContain('n’existe pas');
      expect(echelonHorsGrille('HC 5', hc)).toContain('HC 1 à HC 4');
      expect(echelonHorsGrille('abc', hc)).toContain('n’est pas un échelon');
      expect(echelonHorsGrille('16', hc)).toBeNull();
      expect(echelonHorsGrille('HC 4', hc)).toBeNull();
      expect(echelonHorsGrille('', hc)).toBeNull();
      // Échelle inconnue : 16 échelons et 4 hors classe
      expect(echelonHorsGrille('20', null)).toContain('n’existe pas');
      expect(echelonHorsGrille('HC 3', null)).toBeNull();
    });
  });
});
