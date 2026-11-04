import type { DemandePrestation } from '../entities';
import { definition, PRESTATIONS } from './definitions';
import type { ContexteActe } from './moteur';
import {
  ecrireTransmission,
  enLettres,
  nombreDemandes,
  politesseDe,
} from './transmission';

/** Demande fictive (ZZTESTFICTIF) d'un type, tous les renseignements remplis. */
function demande(code: string, n: number, genre: 'M' | 'F' = 'M') {
  const def = definition(code)!;
  const details: Record<string, unknown> = {};
  for (const c of def.champs) {
    if (c.type === 'liste') {
      details[c.cle] = c.options![0].valeur;
      details[`${c.cle}Libelle`] = c.options![0].libelle;
    } else if (c.type === 'date') details[c.cle] = '2025-09-12';
    else if (c.type === 'departement') {
      details[c.cle] = 1;
      details[`${c.cle}Nom`] = 'Bouenza';
    } else details[c.cle] = `Valeur ${c.cle}`;
  }
  return {
    numero: n,
    details,
    agent: {
      nomComplet: `ZZTESTFICTIF Agent ${n}`,
      genre,
      grade: 'Instituteur',
      echelon: '1',
      indice: '488',
      matricule: `12345${n}X`,
      fonction: 'Enseignant',
      lieuService: 'école primaire fictive',
      departement: 'Niari',
      texteRecrutement: 'Arrêté n° 1/MFPTSS/DGFP du 31/12/2025',
      datePriseService: '2026-01-05',
    },
  } as unknown as DemandePrestation;
}

const P = {
  destinataire: 'Monsieur le directeur général du budget',
  appel: 'Monsieur le directeur général et cher collègue,',
  expediteur:
    'Le Directeur général des ressources humaines et de l’administration scolaire',
  signataireNom: null,
  suffixeNumero: 'MEPPSA-CAB-DGRHAS-DRSC-SSC',
  lieu: 'Brazzaville',
  reference: (n: number) => `P-${n}`,
};
const ctxDe = (code: string) => (d: DemandePrestation) =>
  ({
    agent: d.agent,
    details: d.details,
    champs: definition(code)!.champs,
    param: () => null,
  }) as unknown as ContexteActe;

describe('Soit-transmis des demandes de prestation (modèles de la DGRHAS)', () => {
  it('écrit les nombres comme les modèles', () => {
    expect(nombreDemandes(1)).toBe('une (01) demande');
    expect(nombreDemandes(3)).toBe('trois (03) demandes');
    expect(nombreDemandes(7)).toBe('sept (07) demandes');
    expect(enLettres(21)).toBe('vingt et un');
    expect(enLettres(71)).toBe('soixante et onze');
    expect(enLettres(80)).toBe('quatre-vingts');
    expect(enLettres(97)).toBe('quatre-vingt-dix-sept');
    expect(enLettres(200)).toBe('deux cents');
  });

  it('formule de politesse tirée de l’appel', () => {
    expect(politesseDe(P.appel)).toBe(
      'Veuillez agréer, monsieur le directeur général et cher collègue, l’expression de ma franche collaboration.',
    );
  });

  it('une demande : objet sur deux lignes et phrase du modèle', () => {
    const d = demande('PRISE_EN_CHARGE_SOLDE', 4, 'F');
    const l = ecrireTransmission(
      definition('PRISE_EN_CHARGE_SOLDE')!,
      [d],
      ctxDe('PRISE_EN_CHARGE_SOLDE'),
      P,
    );
    expect(l.collective).toBe(false);
    expect(l.objet).toEqual([
      'Transmission d’une (01) demande',
      'de prise en charge en solde.',
    ]);
    expect(l.corps).toBe(
      'J’ai l’honneur de vous faire parvenir, pour compétence, une (01) demande de prise en charge en solde, formulée par madame ZZTESTFICTIF Agent 4, Instituteur de 1er échelon, indice 488, matricule de solde n° 123454X, intégrée ou engagée dans la Fonction publique par Arrêté n° 1/MFPTSS/DGFP du 31/12/2025, en service à école primaire fictive, département scolaire de Niari, depuis le 12/09/2025.',
    );
    expect(l.lignes).toEqual([]);
  });

  it('plusieurs demandes : tableau des agents avec les colonnes du modèle', () => {
    const ds = [1, 2, 3].map((n) => demande('CHANGEMENT_REGLEMENT', n));
    const l = ecrireTransmission(
      definition('CHANGEMENT_REGLEMENT')!,
      ds,
      ctxDe('CHANGEMENT_REGLEMENT'),
      P,
    );
    expect(l.objet).toEqual([
      'Transmission de trois (03) demandes',
      'de changement de mode de règlement (MDR).',
    ]);
    expect(l.corps).toBe(
      'J’ai l’honneur de vous faire parvenir, pour compétence, trois (03) demandes de changement de mode de règlement (MDR), formulées par les agents dont les noms et prénoms suivent, conformément au tableau ci-après :',
    );
    expect(l.colonnes.map((c) => c.libelle)).toEqual([
      'Grade',
      'Fonction',
      'Référence du texte de recrutement',
      'Date de prise de service',
      'Matricule de solde',
      'Structure',
      'Département',
    ]);
    expect(l.lignes[1]).toEqual({
      numero: '02',
      nomComplet: 'ZZTESTFICTIF Agent 2',
      valeurs: [
        'Instituteur',
        'Enseignant',
        'Arrêté n° 1/MFPTSS/DGFP du 31/12/2025',
        '05-01-2026',
        '123452X',
        'école primaire fictive',
        'Niari',
      ],
      reference: 'P-2',
    });
  });

  it.each(
    PRESTATIONS.filter((p) => p.acteModele.transmission).map(
      (p) => [p.code] as const,
    ),
  )('%s : s’écrit seule et à plusieurs, sans repère inconnu', (code) => {
    const def = definition(code)!;
    for (const n of [1, 2]) {
      const ds = Array.from({ length: n }, (_, i) => demande(code, i + 1));
      const l = ecrireTransmission(def, ds, ctxDe(code), P);
      expect(l.objet[1]).toMatch(/^d(e |’)/);
      expect(`${l.objet.join(' ')} ${l.corps}`).not.toMatch(/[{}]|\[\[|…/);
    }
  });

  it('toute lettre au Budget ou à la Fonction publique a son modèle de transmission', () => {
    const sans = PRESTATIONS.filter(
      (p) => p.acteModele.forme === 'LETTRE' && !p.acteModele.transmission,
    ).map((p) => p.code);
    expect(sans).toEqual([]);
  });
});
