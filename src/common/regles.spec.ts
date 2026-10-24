import { deriver, estContractuel } from '../affectation/calcul';
import { Affectation, Agent, LotPublication, RegleDiplome } from '../entities';
import {
  anomaliesMutation,
  dureeMois,
  etatMutation,
} from '../mutation/mutation.service';
import {
  codeDepartement,
  codeDiplome,
  codeMotif,
  lireGradeEchelon,
  REGLES_DIPLOMES,
  specialiteStat,
  titreDepartement,
} from './referentiels';
import { motsDuNom, ressemblance } from './ressemblance';
import {
  ageRevolu,
  codeCategorie,
  dateEnLettres,
  lireDate,
  romainVersEntier,
} from './texte';

const P = {
  ageLimite: 30,
  ageLimiteCatI: 35,
  dateReference: '2025-01-01',
  pointIndiciaire: 300,
};
const regles = new Map(REGLES_DIPLOMES.map((r) => [r.code, r as RegleDiplome]));

function affectation(
  agent: Partial<Agent>,
  aff: Partial<Affectation> = {},
): Affectation {
  const lot = {
    id: 3,
    numero: 3,
    dateSignatureArretes: '2025-12-31',
    dateSignatureDecrets: null,
  } as LotPublication;
  return {
    typeNote: 'PRIMAIRE',
    departementId: 2,
    structure: null,
    etablissement: null,
    specialite: null,
    agent: {
      diplomeCode: 'BAC',
      dateNaissance: '2000-01-01',
      contractuelForce: null,
      numeroTexte: '6758',
      typeTexte: 'ARRETE',
      dateSignatureTexte: null,
      lotPublication: lot,
      anomalies: [],
      ...agent,
    } as Agent,
    ...aff,
  } as Affectation;
}

describe('Normalisation des fichiers Excel', () => {
  it('lit les dates mal formées de la base', () => {
    expect(lireDate('09 10 1984')).toBe('1984-10-09');
    expect(lireDate('  04/03/1984 ')).toBe('1984-03-04');
    expect(lireDate('10.07.1980')).toBe('1980-07-10');
    expect(lireDate('2103/1986')).toBe('1986-03-21');
    expect(lireDate('01/071992')).toBe('1992-07-01');
    expect(lireDate('25/05/0997')).toBeNull();
    expect(lireDate('17/08/195')).toBeNull();
    expect(lireDate(new Date(Date.UTC(2002, 5, 25)))).toBe('2002-06-25');
  });

  it('reconnaît les variantes de départements', () => {
    expect(codeDepartement('kouilou')).toBe('KOUILOU');
    expect(codeDepartement('Kouiou')).toBe('KOUILOU');
    expect(codeDepartement('Cuevtte')).toBe('CUVETTE');
    expect(codeDepartement('Cuvette (Makoua)')).toBe('CUVETTE');
    expect(codeDepartement('Cuvette-Ouest')).toBe('CUVETTE_OUEST');
    expect(codeDepartement('IV. Cuvette-Ouest')).toBe('CUVETTE_OUEST');
    expect(codeDepartement('Braezzaville')).toBe('BRAZZAVILLE');
    expect(codeDepartement('XII. Pointe-Noire')).toBe('POINTE_NOIRE');
    expect(codeDepartement('V. Djoue Lefini')).toBe('DJOUE_LEFINI');
    expect(codeDepartement('Nkeni-alima')).toBe('NKENI_ALIMA');
    expect(codeDepartement('MEPPSA')).toBeNull();
    expect(codeDepartement('Anglais')).toBeNull();
  });

  it('reconnaît les 37 libellés de diplômes', () => {
    for (const b of ['BAC', 'BAC A4', 'BAC  G2', 'Bac', 'BAC ', ' BAC'])
      expect(codeDiplome(b)).toBe('BAC');
    expect(codeDiplome('BET-Préscolaire')).toBe('BET');
    expect(codeDiplome('CFEEN-Préscolaire')).toBe('CFEEN_PRESCO');
    expect(codeDiplome('CFEEN')).toBe('CFEEN');
    expect(codeDiplome('Dip. d’Etat')).toBe('DIPLOME_ETAT');
    expect(codeDiplome('Licence ')).toBe('LICENCE');
    expect(codeDiplome('Maîtrise')).toBe('MAITRISE');
    expect(codeDiplome('Permis')).toBe('PERMIS');
    expect(codeDiplome('PG')).toBeNull();
  });

  it('formate les titres et dates des notes', () => {
    expect(dateEnLettres('2025-12-31')).toBe('31 Décembre 2025');
    expect(dateEnLettres('2026-01-01')).toBe('1er Janvier 2026');
    expect(titreDepartement({ nom: 'Lékoumou', article: 'DE LA' })).toBe(
      'DEPARTEMENT SCOLAIRE DE LA LEKOUMOU',
    );
    expect(romainVersEntier('VIII')).toBe(8);
    expect(romainVersEntier('II ')).toBe(2);
  });
});

describe('Règles d’affectation (vérifiées sur le lot 3)', () => {
  it('âge révolu', () => {
    expect(ageRevolu('1994-12-31', '2025-01-01')).toBe(30);
    expect(ageRevolu('1994-01-01', '2025-01-01')).toBe(31);
  });

  it('contractuel au-delà de 30 ans au 1er janvier 2025', () => {
    expect(
      estContractuel({ dateNaissance: '1994-06-01', contractuelForce: null }, P)
        .contractuel,
    ).toBe(false);
    expect(
      estContractuel({ dateNaissance: '1993-06-01', contractuelForce: null }, P)
        .contractuel,
    ).toBe(true);
    expect(
      estContractuel(
        { dateNaissance: '1990-06-01', contractuelForce: false },
        P,
      ),
    ).toMatchObject({ contractuel: false, impose: true });
    expect(
      estContractuel({ dateNaissance: null, contractuelForce: null }, P)
        .contractuel,
    ).toBeNull();
  });

  it('âge compté jusqu’à la date de signature du texte de la FP', () => {
    const agent = {
      dateNaissance: '1995-03-15',
      contractuelForce: null,
      dateSignatureTexte: null,
      typeTexte: 'ARRETE' as const,
      lotPublication: { dateSignatureArretes: '2026-09-01' } as never,
    };
    // 29 ans au 1er janvier 2025, mais 31 ans à la signature : contractuel
    expect(estContractuel(agent, P)).toMatchObject({
      contractuel: true,
      age: 31,
      dateAge: '2026-09-01',
      provisoire: false,
    });
    // Date propre au texte prioritaire sur celle du lot
    expect(
      estContractuel({ ...agent, dateSignatureTexte: '2025-03-14' }, P),
    ).toMatchObject({ contractuel: false, age: 29 });
    // Sans texte signé : prévision
    expect(
      estContractuel({ ...agent, lotPublication: null }, P).provisoire,
    ).toBe(true);
  });

  it('catégorie I (licence, master) : contractuel au-delà de 35 ans', () => {
    const agent = { dateNaissance: '1991-06-01', contractuelForce: null };
    expect(estContractuel(agent, P, 'I').contractuel).toBe(false);
    expect(estContractuel(agent, P, 'II').contractuel).toBe(true);
    expect(
      estContractuel(
        { dateNaissance: '1988-06-01', contractuelForce: null },
        P,
        'I',
      ).contractuel,
    ).toBe(true);
    const d = deriver(
      affectation(
        { diplomeCode: 'LICENCE', dateNaissance: '1991-06-01' },
        { typeNote: 'DECRET_COLLEGE' },
      ),
      regles,
      P,
    );
    expect(d).toMatchObject({ grade: 'PCEG', categorie: 'I', echelle: 2 });
  });

  it('BEP traité comme le BAC ; CFEEN préscolaire distinct', () => {
    expect(regles.get('BEP')).toMatchObject({
      cycle: 'PRIMAIRE',
      grade: 'Inst.',
      echelle: 1,
    });
    expect(regles.get('CFEEN_PRESCO')).toMatchObject({
      typeNote: 'PRESCOLAIRE',
      grade: 'Inst.',
    });
    expect(codeDiplome('CFEEN-Préscolaire')).toBe('CFEEN_PRESCO');
    expect(codeDiplome('CFEEN')).toBe('CFEEN');
    expect(codeDiplome('DCAS')).toBe('DECS');
  });

  it('BAC jeune -> Inst II-1-1, référence « n° du 31 Décembre 2025 »', () => {
    const d = deriver(affectation({}), regles, P);
    expect(d).toMatchObject({
      grade: 'Inst.',
      categorie: 'II',
      echelle: 1,
      echelon: 1,
      cycleLibelle: 'Primaire',
      reference: '6758 du 31 Décembre 2025',
    });
    expect(d.bloquants).toEqual([]);
  });

  it('BEPC contractuel -> Inst.A.C II-2-1', () => {
    const d = deriver(
      affectation(
        { diplomeCode: 'BEPC', dateNaissance: '1985-03-21' },
        { typeNote: 'PRESCOLAIRE' },
      ),
      regles,
      P,
    );
    expect(d).toMatchObject({
      grade: 'Inst.A.C.',
      categorie: 'II',
      echelle: 2,
      echelon: 1,
    });
  });

  it('CEPE -> Com. des SAF III-2-1 ; Permis -> Chauffeur III-3-1 ; DCAF -> Econ II-1-1', () => {
    const pa = { typeNote: 'PERS_ADM', structure: 'DDEPPSA Brazzaville' };
    expect(
      deriver(affectation({ diplomeCode: 'CEPE' }, pa), regles, P),
    ).toMatchObject({ grade: 'Com. des SAF', categorie: 'III', echelle: 1 });
    expect(
      deriver(affectation({ diplomeCode: 'PERMIS' }, pa), regles, P),
    ).toMatchObject({ grade: 'Chauffeur', categorie: 'III', echelle: 3 });
    expect(
      deriver(affectation({ diplomeCode: 'DCAF' }, pa), regles, P),
    ).toMatchObject({ grade: 'Econ.', categorie: 'II', echelle: 1 });
  });

  it('bloque une ligne sans date de signature ni département', () => {
    const lot = {
      id: 1,
      numero: 1,
      dateSignatureArretes: null,
    } as LotPublication;
    const d = deriver(
      affectation({ lotPublication: lot }, { departementId: null }),
      regles,
      P,
    );
    expect(d.bloquants).toEqual(
      expect.arrayContaining([
        'Département retenu manquant',
        'Date de signature du texte manquante (à renseigner sur le lot)',
      ]),
    );
  });
});

describe('Mutations', () => {
  it('sépare grade et échelon', () => {
    expect(lireGradeEchelon('Inst1')).toEqual({ grade: 'Inst', echelon: 1 });
    expect(lireGradeEchelon('Inst A 1')).toEqual({
      grade: 'Inst.A',
      echelon: 1,
    });
    expect(lireGradeEchelon('Inst,A1')).toEqual({
      grade: 'Inst.A',
      echelon: 1,
    });
    expect(lireGradeEchelon('InstAI')).toEqual({
      grade: 'Inst.A',
      echelon: null,
    });
    expect(lireGradeEchelon('PCL9')).toEqual({ grade: 'PCL', echelon: 9 });
    expect(lireGradeEchelon('1nst')).toEqual({ grade: 'Inst', echelon: null });
    expect(lireGradeEchelon('Commis des SAF1')).toEqual({
      grade: 'Com. des SAF',
      echelon: 1,
    });
  });

  it('reconnaît les motifs et spécialités', () => {
    expect(codeMotif('V. Ancienneté')).toBe('ANCIENNETE');
    expect(codeMotif('I. Rapprochement de Conjoint')).toBe(
      'RAPPROCHEMENT_CONJOINT',
    );
    expect(codeMotif('III. Raisons de Santé')).toBe('RAISONS_SANTE');
    expect(specialiteStat('H-G')).toBe('HISTOIRE-GEO');
    expect(specialiteStat('Arts-Plastiques')).toBe('DESSIN');
  });

  it('ancienneté minimale de 5 ans', () => {
    const base = {
      motif: 'ANCIENNETE',
      departementOrigineId: 1,
      departementSolliciteId: 2,
      typeAgent: 'FINALISTE' as const,
      grade: 'Inst',
      cycle: 'PRIMAIRE',
    };
    expect(anomaliesMutation({ ...base, dureeMois: 48 })).toContain(
      'Ancienneté inférieure à 5 ans (ou non renseignée)',
    );
    expect(anomaliesMutation({ ...base, dureeMois: 60 })).toEqual([]);
    expect(
      dureeMois(
        { datePriseService: '2020-09-01', dureeMois: null },
        new Date(2026, 9, 16),
      ),
    ).toBe(73);
  });

  it('circuit DDEPPSA -> DGRHAS -> Ministre', () => {
    const d = {
      retiree: false,
      instructionMinistre: null,
      avisDgrhas: null,
      avisDdeppsa: null,
    } as never;
    expect(etatMutation(d)).toBe('EN_ATTENTE_DDEPPSA');
    expect(
      etatMutation({ ...(d as object), avisDdeppsa: 'FAVORABLE' } as never),
    ).toBe('EN_ATTENTE_DGRHAS');
    expect(
      etatMutation({ ...(d as object), avisDgrhas: 'FAVORABLE' } as never),
    ).toBe('EN_ATTENTE_MINISTRE');
    expect(
      etatMutation({
        ...(d as object),
        instructionMinistre: 'ACCORDEE',
      } as never),
    ).toBe('ACCORDEE');
  });
});

describe('Ressemblance des noms (même personne écrite autrement)', () => {
  const r = (a: string, b: string, na?: string, nb?: string) =>
    ressemblance(motsDuNom(a), na, motsDuNom(b), nb);
  it('un prénom de plus ou de moins', () => {
    expect(r('MOUANDA Jean Paul', 'MOUANDA Jean')).toBe('PROBABLE');
    expect(r('MOUANDA KIMBOUALA Jean Paul', 'MOUANDA Jean Paul')).toBe(
      'PROBABLE',
    );
  });
  it('autre ordre et faute de frappe', () => {
    expect(r('Jean Paul MOUANDA', 'MOUANDA Jean-Paul')).toBe('PROBABLE');
    expect(r('MOUANDAH Jean Paul', 'MOUANDA Jean Paul')).toBe('PROBABLE');
  });
  it('dates différentes : on prévient sans conclure', () => {
    expect(
      r('MOUANDA Jean', 'MOUANDA Jean Paul', '1990-01-01', '1985-05-05'),
    ).toBe('POSSIBLE');
  });
  it('même date de naissance et même nom de famille', () => {
    expect(
      r('MOUANDA Albert', 'MOUANDA Albertine', '1990-01-01', '1990-01-01'),
    ).toBe('POSSIBLE');
    expect(
      r('MOUANDA Jean', 'MOUANDA Jean Paul', '1990-01-01', '1990-01-01'),
    ).toBe('PROBABLE');
  });
  it('deux personnes différentes', () => {
    expect(r('MOUANDA Jean', 'MOUANDA Paul')).toBeNull();
    expect(r('MOUANDA Jean', 'KIMBOUALA Jean')).toBeNull();
  });
});

describe('Catégorie écrite à la main (âge de la retraite)', () => {
  it('reconnaît les écritures courantes', () => {
    expect(codeCategorie('I')).toBe('I');
    expect(codeCategorie('Cat. II')).toBe('II');
    expect(codeCategorie('catégorie 3')).toBe('III');
    expect(codeCategorie('Catégorie III')).toBe('III');
    expect(codeCategorie('Hors catégorie')).toBe('HORS_CATEGORIE');
    expect(codeCategorie('HC')).toBe('HORS_CATEGORIE');
  });
  it('ne devine pas une catégorie inconnue', () => {
    expect(codeCategorie('')).toBeNull();
    expect(codeCategorie(null)).toBeNull();
    expect(codeCategorie('IV')).toBeNull();
    expect(codeCategorie('Instituteur')).toBeNull();
  });
});
