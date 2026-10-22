import { deriver, type ParametresCalcul } from '../affectation/calcul';
import type { Affectation, Agent, RegleDiplome } from '../entities';
import { lireNumeroEnregistrement } from '../mutation/mutation.service';
import {
  anomaliesAJour,
  cleTexte,
  NAISSANCE_IMPROBABLE,
  naissanceImprobable,
  TEXTE_PARTAGE,
} from './anomalies';

describe('N° d’enregistrement des mutations', () => {
  it('lit les nombres et les textes écrits à la main', () => {
    expect(lireNumeroEnregistrement(1218)).toBe(1218);
    expect(lireNumeroEnregistrement('1218')).toBe(1218);
    expect(lireNumeroEnregistrement(' 1 218 ')).toBe(1218);
    expect(lireNumeroEnregistrement('N° 1218')).toBe(1218);
    // Lettre O tapée à la place du zéro (fichier « GESTIONS DES MUTATIONS »)
    expect(lireNumeroEnregistrement('OO57')).toBe(57);
  });
  it('refuse ce qui n’est pas un numéro', () => {
    expect(lireNumeroEnregistrement(null)).toBeNull();
    expect(lireNumeroEnregistrement('')).toBeNull();
    expect(lireNumeroEnregistrement('x')).toBeNull();
    expect(lireNumeroEnregistrement(0)).toBeNull();
    expect(lireNumeroEnregistrement(12.5)).toBeNull();
  });
});

describe('Date de naissance improbable', () => {
  const ref = '2025-12-31';
  it('repère les âges impossibles à la signature', () => {
    expect(naissanceImprobable('2018-08-18', ref)).toBe(true); // 7 ans
    expect(naissanceImprobable('2008-05-04', ref)).toBe(true); // 17 ans
    expect(naissanceImprobable('1955-01-01', ref)).toBe(true); // 70 ans
  });
  it('laisse passer les âges possibles', () => {
    expect(naissanceImprobable('2007-12-31', ref)).toBe(false); // 18 ans pile
    expect(naissanceImprobable('1990-06-15', ref)).toBe(false);
    expect(naissanceImprobable(null, ref)).toBe(false);
  });
  it('l’anomalie disparaît quand la date est corrigée', () => {
    const anomalies = [`${NAISSANCE_IMPROBABLE} (18/08/2018)`];
    expect(anomaliesAJour({ anomalies, dateNaissance: '2018-08-18' })).toEqual(
      anomalies,
    );
    expect(anomaliesAJour({ anomalies, dateNaissance: '1988-08-18' })).toEqual(
      [],
    );
  });
});

describe('N° de texte partagé', () => {
  it('compare les numéros sans espaces ni « N° »', () => {
    expect(cleTexte('6 758')).toBe(cleTexte('N°6758'));
    expect(cleTexte('2025-697')).toBe('2025-697');
  });
  it('l’anomalie reste tant que la fiche garde ce numéro', () => {
    const anomalies = [`${TEXTE_PARTAGE} (6758, avec MOUANDA Jean)`];
    expect(anomaliesAJour({ anomalies, numeroTexte: '6758' })).toEqual(
      anomalies,
    );
    expect(anomaliesAJour({ anomalies, numeroTexte: '6759' })).toEqual([]);
  });
});

describe('Blocage d’une date de naissance improbable', () => {
  const regle = {
    code: 'BAC',
    libelle: 'BAC',
    cycle: 'PRIMAIRE',
    typeNote: 'PRIMAIRE',
    grade: 'Inst.',
    categorie: 'II',
    echelle: 1,
    echelon: 1,
    indice: 488,
  } as RegleDiplome;
  const p: ParametresCalcul = {
    ageLimite: 30,
    ageLimiteCatI: 35,
    dateReference: '2026-10-22',
    pointIndiciaire: 300,
  };
  const affectation = (agent: Partial<Agent>) =>
    ({
      typeNote: 'PRIMAIRE',
      departementId: 1,
      agent: {
        diplomeCode: 'BAC',
        numeroTexte: '6758',
        dateSignatureTexte: '2025-12-31',
        contractuelForce: null,
        anomalies: [],
        ...agent,
      },
    }) as unknown as Affectation;
  const regles = new Map([['BAC', regle]]);

  it('bloque une personne de 7 ans à la signature', () => {
    const d = deriver(affectation({ dateNaissance: '2018-08-18' }), regles, p);
    expect(d.bloquants.some((b) => b.startsWith(NAISSANCE_IMPROBABLE))).toBe(
      true,
    );
  });
  it('ne bloque plus si le statut écrit sur le texte est saisi', () => {
    const d = deriver(
      affectation({ dateNaissance: '2018-08-18', contractuelForce: false }),
      regles,
      p,
    );
    expect(d.bloquants).toEqual([]);
  });
  it('ne bloque pas une date normale', () => {
    const d = deriver(affectation({ dateNaissance: '1990-06-15' }), regles, p);
    expect(d.bloquants).toEqual([]);
  });
});
