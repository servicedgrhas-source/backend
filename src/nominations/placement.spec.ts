import {
  cleEcole,
  cleInspection,
  placerNominations,
  type StructurePlacable,
} from './placement';

const S = (
  id: number,
  type: string,
  nom: string,
  extra: Partial<StructurePlacable> = {},
): StructurePlacable => ({
  id,
  type,
  nom,
  sigle: null,
  parentId: null,
  departementId: 1,
  cycle: null,
  anciensNoms: [],
  actif: true,
  ...extra,
});

describe('Placer les nommés dans les structures', () => {
  it('lit les noms d’inspection des notes', () => {
    expect(cleInspection('Inspection des CEG Bouenza 1 (Madingou)')).toBe(
      'BOUENZA 1',
    );
    expect(cleInspection('ICEG Bouenza 1 : Madingou')).toBe('BOUENZA 1');
    expect(cleInspection('B/ville 3')).toBe('BRAZZAVILLE 3');
    expect(cleInspection('Inspection ICEG BZV 3')).toBe('BRAZZAVILLE 3');
    expect(cleInspection('Circonscription scolaire de Brazzaville II')).toBe(
      'BRAZZAVILLE 2',
    );
  });

  it('rapproche les écritures d’une même école', () => {
    expect(cleEcole('EP Kinsoundi II-B')).toBe(cleEcole('EP Kinsoundi 2 B'));
    expect(cleEcole('EP Trois Martyrs A')).toBe(
      cleEcole('École primaire 3 Martyrs A'),
    );
    expect(cleEcole('EP St-Louis A')).toBe(
      cleEcole('École primaire Saint Louis A'),
    );
    expect(cleEcole('Centre d’Alphab. et Rescol. Bouansa')).toBe(
      cleEcole('Centre d’alphabétisation Bouansa'),
    );
  });

  it('place chaque nomination dans sa structure', () => {
    const structures = [
      S(10, 'INSPECTION', 'Inspection Madingou', { cycle: 'PRIMAIRE' }),
      S(11, 'INSPECTION', 'Inspection Kayes', { cycle: 'PRIMAIRE' }),
      // Deux écoles du même nom : la circonscription de la note départage
      S(20, 'ETABLISSEMENT', 'École primaire Mankala', {
        cycle: 'PRIMAIRE',
        parentId: 10,
      }),
      S(21, 'ETABLISSEMENT', 'École primaire Mankala', {
        cycle: 'PRIMAIRE',
        parentId: 11,
      }),
      S(30, 'INSPECTION', 'Inspection ILZ 4', {
        cycle: 'LYCEE',
        departementId: 2,
      }),
      S(40, 'DIRECTION_CENTRALE', 'Inspection Pédagogique et Andragogique', {
        sigle: 'IPA',
      }),
      S(50, 'INSPECTION', 'Inspection IEP Zabata', { cycle: 'PRESCOLAIRE' }),
    ];
    const r = placerNominations(
      [
        {
          id: 1,
          categorie: 'PRIMAIRE_DIRECTEUR',
          departementId: 1,
          circonscription: 'Circonscription scolaire de Kayes',
          nouveauPoste: 'EP Mankala',
        },
        {
          id: 2,
          categorie: 'LYCEE_IDELEGUE',
          departementId: 1,
          circonscription: 'Zone 4 : Kouilou/Pointe-Noire',
          nouveauPoste: 'Zone 4 : Kouilou/Pointe-Noire',
        },
        {
          id: 3,
          categorie: 'ITIN_IPA',
          departementId: null,
          circonscription: null,
          nouveauPoste: 'Inspection Pédagogique et Andragogique (IPA)',
        },
        {
          id: 4,
          categorie: 'ALPHA_CDAR',
          departementId: 1,
          circonscription: null,
          nouveauPoste: 'CDAENF-Bouenza',
        },
        {
          id: 5,
          categorie: 'PRIMAIRE_DIRECTEUR',
          departementId: 1,
          circonscription: 'Circonscription scolaire de Madingou',
          nouveauPoste: 'EP Saint Joseph',
        },
        {
          id: 6,
          categorie: 'PRESCO_ICCS',
          departementId: 1,
          circonscription: null,
          nouveauPoste: 'Bouenza',
        },
        {
          id: 7,
          categorie: 'PRIMAIRE_DIRECTEUR',
          departementId: 1,
          circonscription: null,
          nouveauPoste: 'EP Mankala',
        },
      ],
      structures,
      [{ id: 1, nom: 'Bouenza' }],
    );
    expect(r.get(1)).toMatchObject({ etat: 'SUR', structureId: 21 });
    expect(r.get(2)).toMatchObject({ etat: 'SUR', structureId: 30 });
    expect(r.get(3)).toMatchObject({ etat: 'SUR', structureId: 40 });
    expect(r.get(4)?.etat).toBe('SANS_STRUCTURE');
    // École absente de l'organigramme : proposée à l'inspection de sa circonscription
    expect(r.get(5)).toMatchObject({
      etat: 'INTROUVABLE',
      inspectionAjoutId: 10,
    });
    expect(r.get(6)).toMatchObject({ etat: 'SUR', structureId: 50 });
    // Sans circonscription, deux écoles possibles : à confirmer
    expect(r.get(7)?.etat).toBe('PROBABLE');
  });
});
