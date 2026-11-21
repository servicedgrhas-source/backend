import {
  avecAccents,
  memeEcriture,
  cleNomEcole,
  nomOfficiel,
  ressemblanceEcoles,
} from './repertoire-ecoles.service';

describe('Répertoire officiel des écoles', () => {
  it('garde le nom propre de l’école, sans son type', () => {
    expect(cleNomEcole('École primaire Obangui A')).toBe('OBANGUI A');
    expect(cleNomEcole('EP D’ASSOKO')).toBe('ASSOKO');
    expect(cleNomEcole('CEG DE BOKOMBO ')).toBe('BOKOMBO');
    expect(cleNomEcole('Centre d’Alphabetisation Henry-Bounda')).toBe(
      'HENRY BOUNDA',
    );
  });

  it('ne confond jamais l’école A et l’école B, ni 1 et 2', () => {
    expect(
      ressemblanceEcoles(cleNomEcole('OBANGUI A'), cleNomEcole('Obangui B')),
    ).toBeLessThan(0.78);
    expect(
      ressemblanceEcoles(cleNomEcole('OWANDO 1'), cleNomEcole('Owando 2')),
    ).toBeLessThan(0.78);
    expect(
      ressemblanceEcoles(
        cleNomEcole('DJOUE CAMP A2'),
        cleNomEcole('Djoué Camp A1'),
      ),
    ).toBeLessThan(0.78);
  });

  it('reconnaît une faute de frappe ou un nom raccourci', () => {
    expect(
      ressemblanceEcoles(
        cleNomEcole('MONBELOU'),
        cleNomEcole('École primaire MOUMBELOU'),
      ),
    ).toBeGreaterThanOrEqual(0.78);
    expect(
      ressemblanceEcoles(
        cleNomEcole('CEG FLEUVE CONGO'),
        cleNomEcole('CEG FLEUVE CONGO DE LIRANGA'),
      ),
    ).toBeGreaterThanOrEqual(0.88);
  });

  it('« Annexe Mayeye » n’est pas « Mayeye Centre »', () => {
    expect(cleNomEcole('ECOLE PRIMAIRE DE MAYEYE CENTRE')).toBe(
      'MAYEYE CENTRE',
    );
    expect(cleNomEcole('Centre d’éducation préscolaire de Zanaga')).toBe(
      'ZANAGA',
    );
    expect(
      ressemblanceEcoles(
        cleNomEcole('ANNEXE MAYEYE'),
        cleNomEcole('ECOLE PRIMAIRE DE MAYEYE CENTRE'),
      ),
    ).toBeLessThan(0.78);
    expect(
      ressemblanceEcoles(cleNomEcole('MAYEYE'), cleNomEcole('ANNEXE MAYEYE')),
    ).toBeLessThan(0.78);
    expect(
      ressemblanceEcoles(
        cleNomEcole('PASTEUR ISAAC BALENDE'),
        cleNomEcole('ISAAC BALENDE'),
      ),
    ).toBeGreaterThanOrEqual(0.88);
  });

  it('garde nos accents (DGRHAS, 20/11/2026)', () => {
    expect(memeEcriture('École primaire KOLO', 'École primaire Kolo')).toBe(
      true,
    );
    expect(
      memeEcriture(
        'Centre d’alphabétisation LEWEME',
        "Centre d'Alphabetisation Léwémé",
      ),
    ).toBe(true);
    expect(memeEcriture('EP DE KIMANDOU', 'École primaire Kimandou')).toBe(
      false,
    );
    expect(
      avecAccents('Centre d’alphabétisation MAYEYE CENTRE', [
        "Centre d'Alphabetisation Mayéyé centre",
      ]),
    ).toBe('Centre d’alphabétisation MAYÉYÉ CENTRE');
    expect(
      avecAccents('ECOLE PRIMAIRE DE LISSIEMI', ['École primaire Lissiémi']),
    ).toBe('ÉCOLE PRIMAIRE DE LISSIÉMI');
    expect(avecAccents('EP Kolo', ['École primaire Kolo'])).toBe('EP Kolo');
  });

  it('réunit les initiales et garde « Centre » à confirmer', () => {
    expect(cleNomEcole('CEG A A NETO')).toBe('AA NETO');
    expect(cleNomEcole('C E P 13 FEVRIER')).toBe('13 FEVRIER');
    expect(cleNomEcole('Lycée A. A. Neto B')).toBe('AA NETO B');
    expect(cleNomEcole('OBANGUI A')).toBe('OBANGUI A');
    const r = ressemblanceEcoles(
      cleNomEcole('Prescolaire Okoyo Centre'),
      cleNomEcole('CEP D’OKOYO'),
    );
    expect(r).toBeGreaterThanOrEqual(0.78);
    expect(r).toBeLessThan(0.88);
  });

  it('une école marquée et l’autre non : à confirmer seulement', () => {
    const r = ressemblanceEcoles(
      cleNomEcole('SOLIDARITE'),
      cleNomEcole('École primaire Solidarité A'),
    );
    expect(r).toBeLessThan(0.95);
  });

  it('donne toujours le préfixe du cycle (DG, 21/11/2026)', () => {
    expect(nomOfficiel('MOUNDZOMBO B', 'PRIMAIRE')).toBe('EP MOUNDZOMBO B');
    expect(nomOfficiel('ECOLE PRIMAIRE MOUNDZOMBO B', 'PRIMAIRE')).toBe(
      'EP MOUNDZOMBO B',
    );
    expect(nomOfficiel('EP D’ASSOKO', 'PRIMAIRE')).toBe('EP D’ASSOKO');
    expect(nomOfficiel('CEG BONIALA', 'COLLEGE')).toBe('CEG BONIALA');
    expect(nomOfficiel('BONIALA', 'COLLEGE')).toBe('CEG BONIALA');
    expect(nomOfficiel('LYCEE DE LA REVOLUTION', 'LYCEE')).toBe(
      'LEG DE LA REVOLUTION',
    );
    expect(nomOfficiel('NKAYI 3', 'PRESCOLAIRE')).toBe('CEP NKAYI 3');
    expect(nomOfficiel('MAYEYE CENTRE', 'ALPHABETISATION')).toBe(
      'CA MAYEYE CENTRE',
    );
    expect(
      nomOfficiel('Centre d’alphabétisation Mengo', 'ALPHABETISATION'),
    ).toBe('CA MENGO');
  });
});
