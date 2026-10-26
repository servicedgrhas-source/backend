import { BadRequestException } from '@nestjs/common';
import { valider } from './menu.controller';

describe('Réglage du menu (Administration › Menu)', () => {
  it('garde un réglage bien formé', () => {
    const c = valider({
      version: 2,
      noms: { 'espace:perso-suivi': 'Suivi des agents', 'pole:rh': 'Agents' },
      descriptions: { 'espace:perso-suivi': 'Présence et évaluations' },
      icones: { 'espace:perso-suivi': 'Users' },
      nouveaux: { poles: [], espaces: ['perso-suivi'] },
      structure: {
        menu: ['pole:rh', 'espace:structures'],
        poles: { rh: ['personnel', 'perso-suivi'] },
        espaces: {
          'perso-suivi': [
            { r: 'personnel/personnel/presence', g: 'Présence' },
            { r: 'personnel/personnel/evaluations' },
          ],
        },
      },
    });
    expect(c.version).toBe(2);
    expect(c.nouveaux).toEqual({ poles: [], espaces: ['perso-suivi'] });
    expect(c.structure?.espaces['perso-suivi']).toEqual([
      { r: 'personnel/personnel/presence', g: 'Présence' },
      { r: 'personnel/personnel/evaluations' },
    ]);
    expect(c.icones).toEqual({ 'espace:perso-suivi': 'Users' });
  });

  it('écarte ce qui est mal formé au lieu de l’enregistrer', () => {
    const c = valider({
      version: 2,
      noms: { 'mauvaise clé': 'x', 'espace:personnel': '   ' },
      icones: { 'espace:personnel': 'Users', 'espace:perso-a': '<script>' },
      nouveaux: { poles: ['MAJUSCULES', 'perso-ok'], espaces: [42] },
      structure: {
        menu: ['pole:rh', 'javascript:alert(1)', 7],
        poles: { 'clé invalide': ['x'], rh: ['personnel', 'a b'] },
        espaces: {
          personnel: [{ r: 'personnel/recensement' }, { r: '../..' }, 'x'],
        },
      },
    });
    expect(c.noms).toEqual({});
    // Icône seulement pour ce qui est créé ici, et un nom d'icône simple
    expect(c.icones).toBeUndefined();
    expect(c.nouveaux).toEqual({ poles: ['perso-ok'], espaces: [] });
    expect(c.structure?.menu).toEqual(['pole:rh']);
    expect(c.structure?.poles).toEqual({ rh: ['personnel'] });
    expect(c.structure?.espaces.personnel).toEqual([
      { r: 'personnel/recensement' },
    ]);
  });

  it('refuse un nom trop long', () => {
    expect(() => valider({ noms: { 'pole:rh': 'x'.repeat(61) } })).toThrow(
      BadRequestException,
    );
    expect(() =>
      valider({
        version: 2,
        noms: {},
        structure: {
          menu: [],
          poles: {},
          espaces: {
            personnel: [{ r: 'personnel/recensement', g: 'y'.repeat(61) }],
          },
        },
      }),
    ).toThrow(BadRequestException);
  });

  it('l’ancien réglage (noms et ordres) est toujours lu', () => {
    const c = valider({
      noms: { 'rubrique:/personnel/presence': 'Pointage' },
      ordres: { menu: ['espace:notes', 'pole:rh'] },
    });
    expect(c.noms).toEqual({ 'rubrique:/personnel/presence': 'Pointage' });
    expect(c.ordres).toEqual({ menu: ['espace:notes', 'pole:rh'] });
    expect(c.structure).toBeUndefined();
  });
});
