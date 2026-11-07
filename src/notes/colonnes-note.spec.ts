import { ajusterColonnes, LARGEUR_UTILE_PORTRAIT } from './colonnes-note';

// Mesure simple : 0,2 mm par caractère et par point de corps (≈ Times New Roman)
const mesure = (t: string, corps: number, gras = false) =>
  t.length * 0.2 * corps * (gras ? 1.06 : 1) * 0.9;
const somme = (r: Record<string, number>) =>
  Object.values(r).reduce((s, x) => s + x, 0);

describe('ajusterColonnes (note toujours en A4 portrait)', () => {
  it('peu de colonnes : taille normale, le nom prend la place qui reste', () => {
    const r = ajusterColonnes(
      [
        {
          cle: 'n',
          entete: 'N°',
          textes: ['1', '12'],
          habituelle: 7,
          sansCoupure: true,
        },
        { cle: 'nom', entete: 'Noms et prénoms', textes: ['ZZ ALPHA Bravo'] },
        { cle: 'cycle', entete: 'Cycle', textes: ['Primaire'], habituelle: 19 },
      ],
      mesure,
    );
    expect(r.echelle).toBe(1);
    expect(somme(r.largeurs)).toBeCloseTo(LARGEUR_UTILE_PORTRAIT, 0);
    expect(r.largeurs.nom).toBeGreaterThan(100);
  });

  it('colonnes de mutation par défaut : tient en portrait, aucune colonne plus étroite que son plus long mot', () => {
    const cols = [
      {
        cle: 'n',
        entete: 'N°',
        textes: ['1', '99'],
        habituelle: 7,
        sansCoupure: true,
      },
      {
        cle: 'nom',
        entete: 'Noms et prénoms',
        textes: ['ZZTESTFICTIF Alpha Bravo Charlie'],
      },
      {
        cle: 'ge',
        entete: 'G/E',
        textes: ['Inst 3'],
        habituelle: 13,
        sansCoupure: true,
      },
      {
        cle: 'matricule',
        entete: 'Matricule Solde',
        textes: ['123456Z'],
        habituelle: 18,
        sansCoupure: true,
      },
      { cle: 'cycle', entete: 'Cycle', textes: ['Primaire'], habituelle: 19 },
      {
        cle: 'specialite',
        entete: 'Spécialité',
        textes: ['Mathématiques'],
        habituelle: 21,
      },
      {
        cle: 'ancienPoste',
        entete: 'Ancien Poste',
        textes: ['EP Moungali 3 de Brazzaville'],
        habituelle: 34,
      },
      {
        cle: 'origine',
        entete: "Dépar-tement d'origine",
        textes: ['Bouenza'],
        habituelle: 19,
      },
      {
        cle: 'duree',
        entete: 'Durée dans le poste',
        textes: ['5 ans 3 mois'],
        habituelle: 20,
      },
      {
        cle: 'justification',
        entete: 'Justification',
        textes: ['Rapprochement de la famille à Dolisie'],
        habituelle: 34,
      },
      { cle: 'obs', entete: 'Obs', textes: ['Ens. active'], habituelle: 16 },
    ];
    const r = ajusterColonnes(cols, mesure);
    expect(somme(r.largeurs)).toBeCloseTo(LARGEUR_UTILE_PORTRAIT, 0);
    expect(r.echelle).toBeGreaterThanOrEqual(0.7);
    for (const c of cols) {
      const mot = Math.max(
        ...c.textes.flatMap((t) =>
          (c.sansCoupure ? [t] : t.split(/\s+/)).map((m) =>
            mesure(m, 10 * r.echelle),
          ),
        ),
      );
      expect(r.largeurs[c.cle]).toBeGreaterThanOrEqual(mot);
    }
  });

  it('une colonne qui utilise peu de place ne garde pas sa largeur habituelle', () => {
    const r = ajusterColonnes(
      [
        { cle: 'nom', entete: 'Noms', textes: ['ZZ A'] },
        { cle: 'ancienPoste', entete: 'Poste', textes: ['EP'], habituelle: 34 },
      ],
      mesure,
    );
    expect(r.largeurs.ancienPoste).toBeLessThan(15);
  });

  it('beaucoup trop large : police à 70 %, toujours la largeur de la page', () => {
    const cols = Array.from({ length: 14 }, (_, i) => ({
      cle: `c${i}`,
      entete: 'Colonne',
      textes: ['Extraordinairement'],
      habituelle: 30,
    }));
    const r = ajusterColonnes(
      [{ cle: 'nom', entete: 'Noms', textes: ['ZZ A'] }, ...cols],
      mesure,
    );
    expect(r.echelle).toBe(0.7);
    expect(somme(r.largeurs)).toBeCloseTo(LARGEUR_UTILE_PORTRAIT, 0);
  });
});
