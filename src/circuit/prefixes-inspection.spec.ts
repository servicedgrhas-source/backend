import { nomPropreInspection, prefixerInspection } from './catalogue';

describe('Préfixe du cycle devant le nom des inspections (DG, 26/10/2026)', () => {
  it('primaire : IEPA, et l’ancien « IEP » est remplacé', () => {
    expect(prefixerInspection('Boko-Songho 10', 'PRIMAIRE')).toEqual({
      sigle: 'IEPA Boko-Songho 10',
      nom: 'Inspection IEPA Boko-Songho 10',
    });
    expect(prefixerInspection('IEP MFILOU-NGAMABA', 'PRIMAIRE')).toEqual({
      sigle: 'IEPA MFILOU-NGAMABA',
      nom: 'Inspection IEPA MFILOU-NGAMABA',
    });
    expect(prefixerInspection('INSPECTION DE NGOYO', 'PRIMAIRE')).toEqual({
      sigle: 'IEPA NGOYO',
      nom: 'Inspection IEPA NGOYO',
    });
    expect(prefixerInspection('IEPA  Mbon', 'PRIMAIRE')).toEqual({
      sigle: 'IEPA Mbon',
      nom: 'Inspection IEPA Mbon',
    });
  });
  it('préscolaire : IP, et « IDP » est remplacé', () => {
    expect(prefixerInspection('Zabata', 'PRESCOLAIRE')).toEqual({
      sigle: 'IP Zabata',
      nom: 'Inspection IP Zabata',
    });
    expect(prefixerInspection('IDP NKENI-ALIMA', 'PRESCOLAIRE')).toEqual({
      sigle: 'IP NKENI-ALIMA',
      nom: 'Inspection IP NKENI-ALIMA',
    });
  });
  it('collège : ICEG ; lycée : ILZ déjà bon', () => {
    expect(prefixerInspection('Bouenza 1  (Madingou)', 'COLLEGE')).toEqual({
      sigle: 'ICEG Bouenza 1 (Madingou)',
      nom: 'Inspection ICEG Bouenza 1 (Madingou)',
    });
    expect(prefixerInspection('ILZ 8', 'LYCEE')).toEqual({
      sigle: 'ILZ 8',
      nom: 'Inspection ILZ 8',
    });
  });
  it('nom complet : suit le sigle, corrige l’ancienne écriture, garde un nom parlant', () => {
    expect(
      prefixerInspection(
        'ICEG CUVETTE 1 (Owando)',
        'COLLEGE',
        'Inspection ICGE CUVETTE 1 (OWANDO)',
      ),
    ).toEqual({
      sigle: 'ICEG CUVETTE 1 (Owando)',
      nom: 'Inspection ICEG CUVETTE 1 (OWANDO)',
    });
    expect(
      prefixerInspection(
        'ICEG PN 2',
        'COLLEGE',
        'Inspection des CEG de Pointe-Noire 2',
      ),
    ).toEqual({
      sigle: 'ICEG PN 2',
      nom: 'Inspection des CEG de Pointe-Noire 2',
    });
    expect(
      prefixerInspection('Divénié', 'PRIMAIRE', 'Inspection DIVENIE'),
    ).toEqual({ sigle: 'IEPA Divénié', nom: 'Inspection IEPA Divénié' });
  });
  it('une deuxième correction ne change plus rien', () => {
    for (const [sigle, cycle, nom] of [
      [
        'ICEG CUVETTE 1 (Owando)',
        'COLLEGE',
        'Inspection ICGE CUVETTE 1 (OWANDO)',
      ],
      ['INSPECTION DE NGOYO', 'PRIMAIRE', 'Inspection DE NGOYO'],
      ['Zabata', 'PRESCOLAIRE', 'Inspection Zabata'],
    ]) {
      const une = prefixerInspection(sigle, cycle, nom) as {
        sigle: string;
        nom: string;
      };
      expect(prefixerInspection(une.sigle, cycle, une.nom)).toEqual(une);
    }
  });
  it('préfixe d’un autre cycle : signalé, rien ne change', () => {
    expect(prefixerInspection('IEP Ouenzé', 'PRESCOLAIRE')).toHaveProperty(
      'conflit',
    );
  });
  it('un nom qui commence comme un préfixe n’en est pas un', () => {
    expect(prefixerInspection('Ipendja', 'PRIMAIRE')).toMatchObject({
      sigle: 'IEPA Ipendja',
    });
  });
  it('alphabétisation et sans cycle : en attente de la décision du DG', () => {
    expect(prefixerInspection('Talangai 1', 'ALPHABETISATION')).toBeNull();
    expect(prefixerInspection('Ewo', null)).toBeNull();
  });
  it('une inspection se retrouve avec ou sans son préfixe', () => {
    expect(nomPropreInspection('IEPA Boko-Songho 10')).toBe('Boko-Songho 10');
    expect(nomPropreInspection('Inspection Boko-Songho 10')).toBe(
      'Boko-Songho 10',
    );
    expect(nomPropreInspection('ILZ 8')).toBeNull();
  });
});
