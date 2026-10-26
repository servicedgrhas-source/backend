import { IndexStructures } from './rattachement';

/** Lieu de service écrit dans une fiche → inspection renommée avec le préfixe de son cycle. */
const index = new IndexStructures([
  {
    id: 1,
    type: 'INSPECTION',
    nom: 'Inspection IEPA Boko-Songho 10',
    sigle: 'IEPA Boko-Songho 10',
    cycle: 'PRIMAIRE',
    departementId: 1,
  },
  {
    id: 2,
    type: 'INSPECTION',
    nom: 'Inspection IEPA Talangai 1',
    sigle: 'IEPA Talangai 1',
    cycle: 'PRIMAIRE',
    departementId: 2,
  },
  {
    id: 3,
    type: 'INSPECTION',
    nom: 'Inspection Talangai 1',
    sigle: 'Talangai 1',
    cycle: 'ALPHABETISATION',
    departementId: 2,
  },
  {
    id: 4,
    type: 'INSPECTION',
    nom: 'Inspection IP Zabata',
    sigle: 'IP Zabata',
    cycle: 'PRESCOLAIRE',
    departementId: 3,
  },
]);

describe('Rattachement à une inspection préfixée (IEPA, ICEG, ILZ, IP)', () => {
  it('l’ancien nom écrit dans la fiche retrouve l’inspection renommée', () => {
    expect(index.trouver('Inspection Boko-Songho 10', 1)?.id).toBe(1);
    expect(index.trouver('IEPA Boko-Songho 10', 1)?.id).toBe(1);
    expect(index.trouver('Inspection Zabata', 3)?.id).toBe(4);
    expect(index.trouver('IP Zabata', 3)?.id).toBe(4);
    expect(index.trouver('IDP Zabata', 3)?.id).toBe(4);
  });
  it('deux inspections au même endroit : le préfixe dit laquelle', () => {
    expect(index.trouver('IEPA Talangai 1', 2)?.id).toBe(2);
    expect(index.trouver('Inspection Talangai 1', 2)).toBeNull();
  });
});
