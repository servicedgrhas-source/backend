import { IndexStructures } from './rattachement';

/**
 * Règle prudente (DG, 24/11/2026) : un lieu écrit sans type (« POINTE-NOIRE 2 ») qui est aussi le
 * nom d'une inspection du département n'est rattaché à rien : c'est un lieu, pas une école.
 */
const index = new IndexStructures([
  {
    id: 1,
    type: 'INSPECTION',
    nom: 'Inspection IP Pointe-Noire 2',
    sigle: 'IP Pointe-Noire 2',
    cycle: 'PRESCOLAIRE',
    departementId: 5,
  },
  {
    id: 2,
    type: 'INSPECTION',
    nom: 'Inspection des CEG de Pointe-Noire 2',
    sigle: 'ICEG Pointe-Noire 2',
    cycle: 'COLLEGE',
    departementId: 5,
  },
  {
    id: 3,
    type: 'ETABLISSEMENT',
    nom: 'LEG de Pointe Noire 2',
    sigle: 'LEG Pointe Noire 2',
    cycle: 'LYCEE',
    departementId: 5,
  },
  {
    id: 4,
    type: 'ETABLISSEMENT',
    nom: 'EP Minangou Laurent',
    sigle: 'EP Minangou Laurent',
    cycle: 'PRIMAIRE',
    departementId: 5,
  },
]);

describe('Rattachement prudent : un nom de lieu n’est pas une école', () => {
  it('« POINTE-NOIRE 2 » sans type n’est rattaché à rien, quel que soit le cycle', () => {
    for (const cycle of ['PRESCOLAIRE', 'PRIMAIRE', 'COLLEGE', 'LYCEE', null])
      expect(index.trouver('POINTE-NOIRE 2', 5, cycle)).toBeNull();
  });

  it('écrit avec son type, chaque structure reste retrouvée', () => {
    expect(index.trouver('Inspection IP Pointe-Noire 2', 5)?.id).toBe(1);
    expect(index.trouver('ICEG Pointe-Noire 2', 5)?.id).toBe(2);
    // « Inspection de Pointe-Noire 2 » : deux inspections, aucun cycle écrit → rien
    expect(index.trouver('Inspection de Pointe-Noire 2', 5)).toBeNull();
    expect(index.trouver('LYCEE DE POINTE NOIRE 2', 5)?.id).toBe(3);
  });

  it('le nom seul d’une école (sans inspection de ce nom) reste reconnu par le cycle', () => {
    expect(index.trouver('MINANGOU LAURENT', 5, 'PRIMAIRE')?.id).toBe(4);
    expect(index.trouver('MINANGOU LAURENT', 5, null)).toBeNull();
  });

  it('« DDEPPSA » écrit comme lieu ne choisit pas une inspection', () => {
    expect(index.trouver('DDEPPSA', 5)).toBeNull();
  });
});
