import { groupeQuota, libelleLot, repereLot, romain } from '../common/lots';
import { feuilleAutres, fusionner, type LigneLue } from './import.service';

/** Lots de publication du fichier et fusion des feuilles (DG, 30/10/2026). */
describe('lots du fichier', () => {
  it('écrit les lots en chiffres romains', () => {
    expect([1, 4, 8, 9, 14, 19].map(romain)).toEqual([
      'I',
      'IV',
      'VIII',
      'IX',
      'XIV',
      'XIX',
    ]);
  });

  it('nomme un lot du fichier par sa famille et son numéro', () => {
    const l = { numero: 38, typeTexte: 'ARRETE', rang: 8, numeroFichier: 8 };
    expect(libelleLot(l)).toBe('Arrêtés — lot VIII');
    expect(repereLot(l)).toBe('Arr/LVIII');
    expect(libelleLot({ ...l, typeTexte: 'DECRET', numeroFichier: 3 })).toBe(
      'Décrets — lot III',
    );
  });

  it('range une personne dans son groupe de quota', () => {
    expect(groupeQuota({ feuille: 'MEPPSA', departementId: null })).toBe(
      'MEPPSA',
    );
    expect(groupeQuota({ feuille: 'QUOTA_AUTRES', departementId: 3 })).toBe(
      'AUTRES_AVEC',
    );
    expect(groupeQuota({ feuille: 'QUOTA_AUTRES', departementId: null })).toBe(
      'AUTRES_SANS',
    );
    // Département donné par la répartition : « sans département » d'origine
    expect(
      groupeQuota({
        feuille: 'QUOTA_AUTRES',
        departementId: 3,
        repartitionId: 'x',
      }),
    ).toBe('AUTRES_SANS');
  });

  it('reconnaît les feuilles du quota « Autres »', () => {
    expect(feuilleAutres('QA arrêtés sans département')).toBe(true);
    expect(feuilleAutres('Quota Autres')).toBe(true);
    expect(feuilleAutres('Cumul Lot 8')).toBe(false);
  });

  it('réunit une personne présente dans deux feuilles en gardant son département', () => {
    const sans: LigneLue = {
      cle: 'QA|X|1990-01-01',
      departementId: null,
      departementBrut: null,
      numeroTexte: '120',
      lotPublicationNumero: 8,
      typeTexte: 'ARRETE',
      anomalies: ['Département absent'],
    };
    const avec: LigneLue = {
      ...sans,
      departementId: 5,
      departementBrut: 'Cuvette',
      observation: 'Note CBD',
      anomalies: [],
    };
    fusionner(sans, avec);
    expect(sans.departementId).toBe(5);
    expect(sans.departementBrut).toBe('Cuvette');
    expect(sans.observation).toBe('Note CBD');
    expect(sans.anomalies).toEqual([]);
  });

  it('signale un lot différent d’une feuille à l’autre', () => {
    const a: LigneLue = {
      lotPublicationNumero: 8,
      typeTexte: 'ARRETE',
      anomalies: [],
    };
    fusionner(a, {
      lotPublicationNumero: 4,
      typeTexte: 'ARRETE',
      anomalies: [],
    });
    expect(a.lotPublicationNumero).toBe(8);
    expect(a.anomalies[0]).toMatch(/VIII et IV/);
  });
});
