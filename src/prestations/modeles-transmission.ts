/**
 * Les soit-transmis des demandes de prestation, recopiés des modèles Word de la DGRHAS (dossier
 * « word », 04/11/2026). Une entrée par prestation ; le nom du fichier Word est rappelé au-dessus.
 * Les tirets à remplir du modèle sont des repères (moteur.ts) :
 * - `{identite}` : « monsieur X, instituteur de 1er échelon, indice 488, matricule de solde n° … » ;
 * - `{enServiceA}` : « en service à l’école … » ; `{departementScolaire}` : « département
 *   scolaire de Brazzaville » ;
 * - `{civilite}`, `{grade}`, `{integreEngage}` (« intégré(e) » ou « engagé(e) » selon le statut),
 *   `{administrateurAyantDroit}` (« administrateur » ou « administratrice » des biens).
 * Rien n'est ajouté au texte des modèles ; là où le système a une prestation que le dossier
 * « word » n'a pas, la phrase suit le modèle le plus proche (signalé « sans modèle »).
 */

import type {
  ColonneTransmission,
  TransmissionModele,
} from './definitions';

/** La phrase commune des modèles : « , formulée par monsieur X, grade de … échelon, indice …,
 * matricule de solde n° …, en service à …, département scolaire de …. » */
const FORMULEE =
  ', formulée par {identite}, {enServiceA}, {departementScolaire}.';

/** Colonnes des tableaux des modèles « Transmission de six (06) demandes… ». */
const SANS_TEXTE: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const TEXTE_RECRUTEMENT: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'TEXTE_RECRUTEMENT',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const NOTE_NOMINATION: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'NOTE_NOMINATION',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const DERNIERE_PROMOTION_ET_PRISE: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'TEXTE_PROMOTION',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const DERNIERE_PROMOTION: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'TEXTE_PROMOTION',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];

/** Primes (n° 46 à 52) : « Transmission d’une demande de mandatement des primes… ». */
const PRIME = (prime: string): TransmissionModele => ({
  objet: 'de mandatement des primes',
  corpsObjet: `de mandatement de la ${prime}`,
  article: 'la',
  // Le modèle n'a pas de virgule avant « formulée »
  phrase: ' formulée par {identite}, {enServiceA}, {departementScolaire}.',
  colonnes: SANS_TEXTE,
});

export const MODELES_TRANSMISSION: Record<string, TransmissionModele> = {
  // « Transmission d'une (01) demande de prise en charge en solde »
  PRISE_EN_CHARGE_SOLDE: {
    objet: 'de prise en charge en solde',
    article: 'une',
    phrase:
      ', formulée par {civilite} {agent.nomComplet}, {grade} de {echelon}, indice {agent.indice}, {integreEngage} dans la fonction publique par {agent.texteRecrutement}, {enServiceA}, {departementScolaire}, depuis le {champ:datePriseService}.',
    colonnes: TEXTE_RECRUTEMENT,
  },
  // « … de domiciliation de salaire » et « Transmission de 03 demandes de domiciliation de salaire »
  DOMICILIATION_SALAIRE: {
    objet: 'de domiciliation de salaire',
    article: 'la',
    phrase: FORMULEE,
    colonnes: SANS_TEXTE,
  },
  // « … de changement de MDR » et « Transmission de 03 demandes de changement de MDR »
  CHANGEMENT_REGLEMENT: {
    objet: 'de changement de mode de règlement (MDR)',
    article: 'une',
    phrase: FORMULEE,
    colonnes: TEXTE_RECRUTEMENT,
  },
  // « … de rectificatif de nom », « … de changement de la situation matrimoniale sur le bulletin de
  // solde », « Transmission de deux (02) demandes de rectificatif de nom sur le bulletin de solde »
  RECTIFICATIF_IDENTITE: {
    objet: 'de rectificatif de nom sur le bulletin de solde',
    article: 'la',
    phrase: FORMULEE,
    colonnes: TEXTE_RECRUTEMENT,
    selon: {
      champ: 'nature',
      valeurs: {
        NOM: { objet: 'de rectificatif de nom sur le bulletin de solde' },
        SITUATION_MATRIMONIALE: {
          objet:
            'de changement|de la situation matrimoniale sur le bulletin de solde',
          article: 'une',
        },
        // Sans modèle : comme le rectificatif de nom
        GRADE: { objet: 'de rectificatif de grade sur le bulletin de solde' },
        IDENTITE: {
          objet: 'de rectificatif d’identité sur le bulletin de solde',
        },
        CODE_SERVICE: {
          objet: 'de rectificatif du code de service sur le bulletin de solde',
        },
      },
    },
  },
  // « … de mandatement de l'indemnité de fonction » (le modèle s'arrête au lieu de service)
  INDEMNITE_FONCTION: {
    objet: 'de mandatement de l’indemnité de fonction',
    article: 'une',
    phrase: ', formulée par {identite}, {enServiceA}.',
    colonnes: NOTE_NOMINATION,
  },
  // « Transmission de sept (07) demandes de rétablissement de l'indemnité de fonction »
  RETABLISSEMENT_INDEMNITE: {
    objet: 'de rétablissement de l’indemnité de fonction',
    article: 'la',
    phrase: ', formulée par {identite}, {enServiceA}.',
    colonnes: NOTE_NOMINATION,
  },
  // « … de mandatement de rappel de promotion » et sa version à six demandes
  RAPPEL_PROMOTIONS: {
    objet: 'de mandatement de rappel de promotion',
    article: 'une',
    phrase: FORMULEE,
    colonnes: DERNIERE_PROMOTION_ET_PRISE,
  },
  // « … de mandatement de rappel de solde d'activité » et sa version à six demandes
  RAPPEL_SOLDE: {
    objet: 'de mandatement de rappel de solde d’activité',
    article: 'une',
    phrase: FORMULEE,
    colonnes: TEXTE_RECRUTEMENT,
  },
  // « … de paiement de capital décès »
  CAPITAL_DECES: {
    objet: 'de paiement du capital décès',
    article: 'la',
    phrase:
      ', formulée par {acte:civiliteAyantDroit} {champ:ayantDroit}, {administrateurAyantDroit} des biens de {f:feu|feue} {agent.nomComplet}, précédemment {grade}, matricule de solde n° {agent.matricule}, {f:décédé|décédée} le {champ:dateDeces} à {champ:lieuDeces}.',
    colonnes: SANS_TEXTE,
  },
  // « … de cessation de paiement »
  CESSATION_PAIEMENT: {
    objet: 'd’obtention|d’un certificat de cessation de paiement',
    article: 'la',
    phrase:
      ', formulée par {acte:civiliteAyantDroit} {champ:ayantDroit}, {administrateurAyantDroit} des biens de {f:feu|feue} {agent.nomComplet}, précédemment {grade}, matricule de solde n° {agent.matricule}, {f:décédé|décédée} le {champ:dateDeces} au {champ:lieuDeces}.',
    colonnes: SANS_TEXTE,
  },
  // « Transmission d'une damande de paiement de l'indeminité de fin de carrière »
  INDEMNITE_FIN_CARRIERE: {
    objet: 'de paiement|de l’indemnité de fin de carrière',
    article: 'la',
    phrase:
      ', formulée par {civilite} {agent.nomComplet}, {grade}, matricule de solde n° {agent.matricule}, {f:admis|admise} à la retraite depuis le {champ:dateRetraite}.',
    colonnes: SANS_TEXTE,
  },
  // « Transmission d'une demande de validation de la RCA »
  RCA_SOLDE: {
    objet:
      'de prise en compte|de la reconstitution de la carrière administrative à la solde',
    article: 'la',
    phrase: FORMULEE,
    colonnes: DERNIERE_PROMOTION,
  },
  // « Transmission de six(06) demandes de prise en compte de l'arrêté de dernière promotion à la solde »
  ARRETE_PROMOTION_SOLDE: {
    objet:
      'de prise en compte|de l’arrêté de dernière promotion à la solde',
    article: 'la',
    phrase: FORMULEE,
    colonnes: DERNIERE_PROMOTION,
  },
  // « Transmission de six (06) demandes de changement de statut »
  CHANGEMENT_STATUT: {
    objet: 'de changement de statut',
    article: 'la',
    phrase: FORMULEE,
    colonnes: DERNIERE_PROMOTION,
  },
  // « Transmission d'une demande de mandatement des primes de risque et santé, documentation et
  // matériel didactique, hinterland » et « Transmission de six (06) demandes de mandatement de primes »
  PRIME_DOCUMENTATION: PRIME('prime de documentation et matériel didactique'),
  PRIME_HINTERLAND: PRIME('prime d’hinterland'),
  PRIME_RISQUE_SANTE: PRIME('prime de risque et santé'),
  // Sans modèle : comme les primes ci-dessus
  PRIME_MULTIGRADE: PRIME('prime de classe multigrade'),
  PRIME_FIDELITE: PRIME('prime de fidélité'),
  PRIME_ENRACINEMENT: PRIME('prime d’enracinement'),
  PRIME_PLETHORE: PRIME('prime de pléthore'),
  ALLOCATIONS_FAMILIALES: {
    objet: 'de paiement des allocations familiales',
    article: 'la',
    phrase: FORMULEE,
    colonnes: SANS_TEXTE,
  },
  RAPPEL_INDEMNITE: {
    objet: 'de rappel de l’indemnité de fonction',
    article: 'la',
    phrase: ', formulée par {identite}, {enServiceA}.',
    colonnes: NOTE_NOMINATION,
  },
  AVANCEMENT: {
    objet: 'de {acte:nature}',
    article: 'la',
    phrase: FORMULEE,
    colonnes: DERNIERE_PROMOTION,
  },
  AVANCEMENT_EXCEPTIONNEL: {
    objet: 'd’avancement à titre exceptionnel',
    article: 'la',
    phrase: FORMULEE,
    colonnes: DERNIERE_PROMOTION,
  },
  RECTIFICATIF_INTEGRATION: {
    objet: 'de rectificatif de texte d’intégration',
    article: 'la',
    phrase: FORMULEE,
    colonnes: TEXTE_RECRUTEMENT,
  },
  PROMOTION_APTITUDE: {
    objet: 'de promotion sur liste d’aptitude',
    article: 'la',
    phrase: FORMULEE,
    colonnes: DERNIERE_PROMOTION,
  },
};
