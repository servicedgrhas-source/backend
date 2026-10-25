import { nomCourtNiveau } from '../etablissements/etablissements.service';
import { configDefaut, mettreAJour } from './configuration';
import { lieuCourt } from './carriere.service';
import {
  deduire,
  evaluer,
  formaterNom,
  lireValeur,
  prochainAvancement,
  valeurLisible,
} from './valeurs';

/** Règles demandées par le DG à la réunion du 24/10/2026. */
const c = configDefaut();
const champ = (code: string) => c.champs.find((x) => x.code === code)!;

describe('Nom : NOM en majuscules, Prénoms avec une majuscule', () => {
  it('met le nom en majuscules et les prénoms avec une majuscule', () => {
    expect(formaterNom('MOUKOKO jean-pierre')).toBe('MOUKOKO Jean-Pierre');
    expect(formaterNom('NGOMA MBEMBA alice   grâce')).toBe(
      'NGOMA MBEMBA Alice Grâce',
    );
  });
  it('garde tel quel un nom tout en majuscules (on ne sait pas où sont les prénoms)', () => {
    expect(formaterNom('MOUKOKO JEAN PIERRE')).toBe('MOUKOKO JEAN PIERRE');
  });
  it('tout en minuscules : le premier mot est le nom', () => {
    expect(formaterNom("moukoko jean d'arc")).toBe("MOUKOKO Jean D'Arc");
  });
});

describe('Promotion et avancement dus', () => {
  it('fonctionnaire : 2 ans après la dernière promotion', () => {
    const a = prochainAvancement(c, 'FONCTIONNAIRE', {
      DATE_GRADE: '2022-03-15',
    });
    expect(a).toMatchObject({
      nature: 'PROMOTION',
      depuis: '2022-03-15',
      prochain: '2024-03-15',
      origine: 'DERNIER',
    });
  });
  it('contractuel : 2 ans et 4 mois, à partir de la ligne la plus récente', () => {
    const a = prochainAvancement(c, 'CONTRACTUEL', {
      DATE_GRADE: '2019-01-10',
      PROMOTIONS: [{ DATE: '2021-06-30' }, { DATE: '2020-01-01' }],
    });
    expect(a).toMatchObject({ nature: 'AVANCEMENT', prochain: '2023-10-30' });
  });
  it('sans promotion : à partir de l’entrée ; fin de mois respectée', () => {
    const a = prochainAvancement(c, 'CONTRACTUEL', {
      DATE_RECRUTEMENT: '2022-06-30',
    });
    expect(a).toMatchObject({ origine: 'ENTREE', prochain: '2024-10-30' });
    expect(
      prochainAvancement(
        { delaiPromotionMois: 6, delaiAvancementMois: 6 },
        'FONCTIONNAIRE',
        { DATE_GRADE: '2023-08-31' },
      )?.prochain,
    ).toBe('2024-02-29');
  });
  it('contractuel titularisé ou révisé : géré comme un fonctionnaire (2 ans)', () => {
    const a = prochainAvancement(c, 'CONTRACTUEL', {
      PROMOTIONS: [{ DATE: '2023-03-01', NATURE: 'RSA' }],
    });
    expect(a).toMatchObject({ nature: 'PROMOTION', prochain: '2025-03-01' });
  });
  it('rien pour un volontaire, ni sans date', () => {
    expect(
      prochainAvancement(c, 'VOLONTAIRE', { DATE_GRADE: '2022-01-01' }),
    ).toBeNull();
    expect(prochainAvancement(c, 'FONCTIONNAIRE', {})).toBeNull();
  });
});

describe('Fiche de renseignements', () => {
  it('une ancienne liste de diplômes devient des lignes « Diplôme »', () => {
    const lu = lireValeur(champ('AUTRES_DIPLOMES'), ['CEPE', 'BAC']);
    expect(lu.valeur).toEqual([{ DIPLOME: 'CEPE' }, { DIPLOME: 'BAC' }]);
    expect(valeurLisible(champ('AUTRES_DIPLOMES'), ['BAC'])).toBe(
      'Baccalauréat',
    );
  });
  it('BEPC et BET sont deux diplômes différents', () => {
    expect(lireValeur(champ('DIPLOME_PRO'), 'BET').valeur).toBe('BET');
    expect(lireValeur(champ('DIPLOME_PRO'), 'BEPC').valeur).toBe('BEPC');
  });
  it('un enfant a son père et sa mère sur sa ligne', () => {
    const lu = lireValeur(
      champ('ENFANTS'),
      'MOUKOKO Grâce | 04/06/2015 | MOUKOKO Jean | NGOMA Alice',
    );
    expect(lu.valeur).toEqual([
      {
        NOM: 'MOUKOKO Grâce',
        NAISSANCE: '2015-06-04',
        PERE: 'MOUKOKO Jean',
        MERE: 'NGOMA Alice',
      },
    ]);
  });
  it('grade et échelon successifs : un ancien fichier « date | texte | nature » se lit encore', () => {
    const lu = lireValeur(
      champ('PROMOTIONS'),
      '12/05/2018 | Arrêté n° 1234 du 12/05/2018 | Avancement d’échelon',
    );
    expect(lu.valeur).toEqual([
      {
        DATE: '2018-05-12',
        TEXTE: 'Arrêté n° 1234 du 12/05/2018',
        NATURE: 'AVANCEMENT',
      },
    ]);
  });
  it('la nature du texte de recrutement se déduit de sa référence', () => {
    const d: Record<string, unknown> = {
      TEXTE_RECRUTEMENT: 'Arrêté n° 21996/MFPTSS/DGFP du 31/12/2025',
    };
    deduire(c, d);
    expect(d.NATURE_TEXTE_RECRUTEMENT).toBe('ARRETE');
  });
  it('un fonctionnaire entré par une note de service est à vérifier', () => {
    const e = evaluer(
      c,
      'FONCTIONNAIRE',
      { NATURE_TEXTE_RECRUTEMENT: 'NOTE_SERVICE' },
      {},
    );
    expect(e.aVerifier).toContain('REGLE:INTEGRATION_PAR_ARRETE');
  });
  it('statut d’activité : « en stage » est un détail de la position', () => {
    expect(lireValeur(champ('STATUT_ACTIVITE'), 'EN FORMATION').valeur).toBe(
      'STAGE',
    );
  });
});

describe('Lieu de service court', () => {
  it('« À la disposition de la DDEPPSA Pool » devient « DDEPPSA Pool »', () => {
    expect(lieuCourt('À la disposition de la DDEPPSA Pool')).toBe(
      'DDEPPSA Pool',
    );
    expect(
      lieuCourt(
        'Direction départementale de l’enseignement préscolaire, primaire, secondaire et de l’alphabétisation (Bouenza)',
      ),
    ).toBe('DDEPPSA Bouenza');
    expect(lieuCourt('CEG Nkayi 2')).toBe('CEG Nkayi 2');
  });
});

describe('Configuration enregistrée avant la réunion du 24/10', () => {
  it('reçoit les nouvelles rubriques et garde les réglages du DG', () => {
    const ancienne = configDefaut();
    ancienne.revision = undefined;
    ancienne.ageRetraite = 60;
    ancienne.champs = ancienne.champs
      .filter(
        (x) =>
          !['NATURE_TEXTE_RECRUTEMENT', 'REFERENCE_PRESENCE'].includes(x.code),
      )
      .map((x) =>
        x.code === 'PROMOTIONS'
          ? {
              ...x,
              libelle: 'Autres promotions ou avancements',
              obligatoirePour: [],
            }
          : x,
      );
    const m = mettreAJour(ancienne, 1);
    const codes = m.champs.map((x) => x.code);
    expect(codes.indexOf('NATURE_TEXTE_RECRUTEMENT')).toBe(
      codes.indexOf('TEXTE_RECRUTEMENT') - 1,
    );
    expect(codes.indexOf('REFERENCE_PRESENCE')).toBe(
      codes.indexOf('PRESENCE_POSTE') + 1,
    );
    const promo = m.champs.find((x) => x.code === 'PROMOTIONS')!;
    expect(promo.libelle).toBe(
      'Grade et échelon successifs (une ligne chacun)',
    );
    expect(promo.obligatoirePour).toEqual([]);
    expect(m.ageRetraite).toBeNull();
    expect(m.revision).toBe(4);
  });
});

describe('Bases de l’enrôlement biométrique', () => {
  it('cycle précédé d’un numéro, ou mal écrit', () => {
    expect(lireValeur(champ('CYCLE'), '2-PRIMAIRE').valeur).toBe('PRIMAIRE');
    expect(lireValeur(champ('CYCLE'), '4-COLLÈGE').valeur).toBe('COLLEGE');
    expect(lireValeur(champ('CYCLE'), 'PRESOLAIRE').valeur).toBe('PRESCOLAIRE');
    expect(lireValeur(champ('CYCLE'), '3-ALPHAB & RESCOL').valeur).toBe(
      'ALPHABETISATION',
    );
  });
  it('mois en lettres : juillet n’est pas juin', () => {
    expect(lireValeur(champ('DATE_NAISSANCE'), '14 JUILLET 1985').valeur).toBe(
      '1985-07-14',
    );
    expect(lireValeur(champ('DATE_NAISSANCE'), '02 JUIN 1985').valeur).toBe(
      '1985-06-02',
    );
    expect(lireValeur(champ('DATE_NAISSANCE'), '12 AOUT 1980').valeur).toBe(
      '1980-08-12',
    );
  });
  it('une configuration de la révision 3 reçoit les nouvelles écritures', () => {
    const r3 = configDefaut();
    r3.revision = 3;
    r3.champs = r3.champs.map((x) =>
      x.code === 'CYCLE'
        ? {
            ...x,
            options: x.options.map((o) => ({ ...o, synonymes: [] })),
          }
        : x,
    );
    const m = mettreAJour(r3, 3);
    const cy = m.champs.find((x) => x.code === 'CYCLE')!;
    expect(lireValeur(cy, 'PRESOLAIRE').valeur).toBe('PRESCOLAIRE');
  });
});

describe('Noms des classes : le niveau en lettres, la classe en chiffres', () => {
  it('collège, lycée, primaire', () => {
    expect(nomCourtNiveau('3EME', 'Troisième')).toBe('3ème');
    expect(nomCourtNiveau('6EME', 'Sixiéme')).toBe('6ème');
    expect(nomCourtNiveau('2NDE C', 'Seconde C')).toBe('2nde C');
    expect(nomCourtNiveau('TD', 'Terminale D')).toBe('Tle D');
    expect(nomCourtNiveau('1ERE', 'PREMIERE')).toBe('1ère');
    expect(nomCourtNiveau('CM2', 'Cours Moyen 2')).toBe('CM2');
    expect(nomCourtNiveau('P-1', 'P1')).toBe('P1');
  });
});
