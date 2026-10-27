import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { cleCompacte, enTexte, normaliser } from '../common/texte';
import { ParametresService } from '../core/core.service';
import { Parametre } from '../entities';

/**
 * Configuration du recensement du personnel : la fiche de renseignements (rubriques, types,
 * listes de valeurs), ce qui est obligatoire pour chaque type d'agent, les pièces justificatives
 * exigées et les contrôles. Réglée par le DG dans l'application : rien n'est figé dans le code.
 *
 * Valeurs par défaut : la « Fiche de renseignements du personnel volontaire et communautaire à
 * recenser » (GRH-SIGE) remise par le DG le 23 octobre 2026, avec les précisions de la réunion
 * (fonctionnaires : bulletin de solde, grade et arrêtés ; marié : acte de mariage ; un acte de
 * naissance par enfant…).
 */

/** Type d'agent : fonctionnaire, contractuel, volontaire, communautaire… */
export interface StatutAgent {
  code: string;
  libelle: string;
  /** Écritures reconnues dans la colonne « Statut / type d'agent » des fichiers. */
  synonymes: string[];
  actif: boolean;
}

export interface Section {
  code: string;
  libelle: string;
  /** Cases par ligne à l'écran (3 par défaut) : 5 pour « Formation » (un diplôme sur une ligne). */
  colonnes?: number;
}

export type TypeChamp =
  | 'TEXTE'
  | 'NOMBRE'
  | 'DATE'
  | 'LISTE'
  | 'LISTE_MULTIPLE'
  | 'TELEPHONE'
  | 'EMAIL'
  | 'LIGNES'
  | 'TABLEAU'
  | 'DEPARTEMENT';

export const LIBELLES_TYPES: Record<TypeChamp, string> = {
  TEXTE: 'Texte',
  NOMBRE: 'Nombre',
  DATE: 'Date',
  LISTE: 'Liste de valeurs (un choix)',
  LISTE_MULTIPLE: 'Liste de valeurs (plusieurs choix)',
  TELEPHONE: 'Téléphone',
  EMAIL: 'Adresse e-mail',
  LIGNES: 'Plusieurs lignes (historique)',
  TABLEAU: 'Tableau (une ligne par élément, plusieurs cases)',
  DEPARTEMENT: 'Département',
};

/** Case d'une ligne de tableau (promotion : date, texte, nature…). */
export interface ColonneTableau {
  code: string;
  libelle: string;
  type: 'TEXTE' | 'DATE' | 'NOMBRE' | 'LISTE';
  options: OptionChamp[];
}

/** Valeur proposée d'une liste, avec les autres écritures reconnues à l'import. */
export interface OptionChamp {
  code: string;
  libelle: string;
  synonymes: string[];
}

/** « Si la rubrique X vaut l'une de ces valeurs » (valeurs vides : « si X est rempli »). */
export interface Condition {
  champ: string;
  valeurs: string[];
}

export interface ChampFiche {
  code: string;
  libelle: string;
  section: string;
  type: TypeChamp;
  /** Types d'agent pour qui la rubrique est obligatoire (vide : facultative pour tous). */
  obligatoirePour: string[];
  /** Obligatoire seulement si cette condition est remplie. */
  si: Condition | null;
  options: OptionChamp[];
  /** Liste : une valeur hors liste est acceptée (signalée « à vérifier »). */
  autreValeur: boolean;
  /** Autres titres de colonne reconnus à l'import (« SEXE » pour « Genre »…). */
  entetes: string[];
  aide: string;
  exemple: string;
  actif: boolean;
  /** Rubrique dont le système a besoin (nom, date de naissance, département) : ne se supprime pas. */
  systeme: boolean;
  /** Tableau : les cases de chaque ligne. */
  colonnes: ColonneTableau[];
  /**
   * Liste de référence d'une rubrique texte (ETABLISSEMENT, INSPECTION, LOCALITE, MATIERE, POSTE…) :
   * la valeur se choisit avec une recherche, une autre valeur reste possible.
   */
  referentiel: string | null;
}

/** Listes de référence possibles pour une rubrique texte. */
export const LISTES_REFERENCE = [
  'ETABLISSEMENT',
  'INSPECTION',
  'STRUCTURE',
  'LOCALITE',
  'MATIERE',
  'POSTE',
  'NIVEAU',
  'CYCLE',
];

export interface PieceExigee {
  code: string;
  libelle: string;
  /** Types d'agent pour qui la pièce est exigée (vide : facultative). */
  exigeePour: string[];
  si: Condition | null;
  /** Une pièce par unité de cette rubrique (nombre d'enfants, lignes de l'historique). */
  nombreSelon: string | null;
  actif: boolean;
}

/** Règle de cohérence : « si X vaut A, alors Y doit valoir B ou C ». */
export interface RegleCoherence {
  code: string;
  libelle: string;
  si: Condition;
  alors: Condition;
  actif: boolean;
}

export interface ConfigRecensement {
  version: 1;
  /** Révision des valeurs par défaut : une configuration enregistrée plus ancienne est mise à jour. */
  revision?: number;
  statuts: StatutAgent[];
  sections: Section[];
  champs: ChampFiche[];
  pieces: PieceExigee[];
  regles: RegleCoherence[];
  ageMinimum: number;
  /**
   * Âge de la retraite quand la catégorie de l'agent est inconnue. Vide (DG, 24/10/2026) : aucun âge
   * n'est supposé, l'agent sans catégorie n'est pas signalé « retraite atteinte » (sa catégorie manque).
   */
  ageRetraite: number | null;
  /**
   * Délais de carrière (DG, 24/10/2026) : promotion du fonctionnaire tous les 2 ans, avancement du
   * contractuel tous les 2 ans et 4 mois, à compter de la dernière promotion ou du dernier avancement.
   */
  delaiPromotionMois: number;
  delaiAvancementMois: number;
  /** Même téléphone pour ce nombre d'agents ou plus : signalé. */
  telephonePartage: number;
  /**
   * Recensement sur le terrain : une fiche créée par un DDEPPSA ou un établissement (agent absent
   * des bases injectées par la DGRHAS) est mise en contentieux, à vérifier puis décider par le DG.
   */
  contentieuxHorsBase: boolean;
}

/** Rubriques indispensables au système (recherche, doublons, périmètre). */
export const CHAMPS_SYSTEME = ['NOMS_PRENOMS', 'DATE_NAISSANCE', 'DEPARTEMENT'];
const CLE = 'RECENSEMENT_CONFIG';
/**
 * Révision des valeurs par défaut (2 : réunion du DG du 24/10/2026 ; 3 : en-têtes des bases de
 * l'enrôlement biométrique 2022-2023 — « MATRICULE », « REF. TEXTE D'INTEGRATION »…).
 */
const REVISION = 5;

/* ------------------------------ Valeurs par défaut ------------------------------ */

const o = (code: string, libelle: string, ...synonymes: string[]) => ({
  code,
  libelle,
  synonymes,
});
const TOUS = ['FONCTIONNAIRE', 'CONTRACTUEL', 'VOLONTAIRE', 'COMMUNAUTAIRE'];
const AGENTS_ETAT = ['FONCTIONNAIRE', 'CONTRACTUEL'];
const VOL_COM = ['VOLONTAIRE', 'COMMUNAUTAIRE'];

function c(
  section: string,
  code: string,
  libelle: string,
  type: TypeChamp,
  obligatoirePour: string[],
  autres: Partial<ChampFiche> = {},
): ChampFiche {
  return {
    code,
    libelle,
    section,
    type,
    obligatoirePour,
    si: null,
    options: [],
    autreValeur: false,
    entetes: [],
    aide: '',
    exemple: '',
    actif: true,
    systeme: CHAMPS_SYSTEME.includes(code),
    colonnes: [],
    referentiel: null,
    ...autres,
  };
}

const col = (
  code: string,
  libelle: string,
  type: ColonneTableau['type'] = 'TEXTE',
  options: OptionChamp[] = [],
): ColonneTableau => ({ code, libelle, type, options });

const DIPLOMES = [
  o('CEPE', 'CEPE'),
  // Même niveau, mais deux diplômes différents (DG, 24/10/2026) : on a l'un ou l'autre
  o('BEPC', 'BEPC', 'BEMG'),
  o('BET', 'BET', 'BEMT'),
  o(
    'BAC',
    'Baccalauréat',
    'BACCALAUREAT',
    'BAC A4',
    'BAC D',
    'BAC C',
    'BAC G2',
  ),
  o('CFEEN', 'CFEEN'),
  o('DEMA', 'DEMA'),
  o('DCAF', 'DCAF'),
  o('CAP_CEG', 'CAP CEG', 'CAPCEG'),
  o('CAPES', 'CAPES'),
  o('CAPEL', 'CAPEL'),
  o('BTS', 'BTS'),
  o('LICENCE', 'Licence'),
  o('MAITRISE', 'Maîtrise'),
  o('MASTER', 'Master'),
  o('DOCTORAT', 'Doctorat'),
];

const CYCLES = [
  o('PRESCOLAIRE', 'Préscolaire', 'PRESCO', 'PRESOLAIRE'),
  o('PRIMAIRE', 'Primaire', 'PRIM'),
  o('COLLEGE', 'Collège', 'CEG'),
  o('LYCEE', 'Lycée', 'LYC'),
  o('ADMINISTRATION', 'Administration', 'ADMINISTRATIF'),
  o(
    'ALPHABETISATION',
    'Alphabétisation',
    'ALPHA',
    'ALPHAB',
    'ALPHAB & RESCOL',
    'Alphabétisation et rescolarisation',
  ),
];

/** Nature du texte d'entrée : un fonctionnaire n'entre que par un arrêté ou un décret. */
export const NATURES_TEXTE = [
  o('ARRETE', 'Arrêté', 'ARRETE N', 'ARRETE NO'),
  o('DECRET', 'Décret', 'DECRET N'),
  o('NOTE_SERVICE', 'Note de service', 'NOTE', 'NOTE DE SERVICE N'),
];

/**
 * Natures des changements de grade et d'échelon (fiche de gestion des carrières remise par le DG) :
 * fonctionnaire — promotion (tous les 2 ans), reclassement, révision de la carrière administrative ;
 * contractuel — avancement (tous les 2 ans et 4 mois), titularisation, révision de la situation
 * administrative. L'intégration et l'engagement sont l'acte d'entrée, pas un changement.
 */
const NATURES_CARRIERE = [
  o('PROMOTION', 'Promotion (fonctionnaire)', 'PROMOTION ORDINAIRE'),
  o(
    'AVANCEMENT',
    'Avancement (contractuel)',
    'AVANCEMENT D ECHELON',
    'AVANCEMENT D’ECHELON',
    'AVANCEMENT ORDINAIRE',
  ),
  o(
    'EXCEPTIONNEL',
    'Promotion ou avancement exceptionnel',
    'PROMOTION EXCEPTIONNELLE',
    'AVANCEMENT EXCEPTIONNEL',
  ),
  o('RECLASSEMENT', 'Reclassement'),
  o('RCA', 'Révision de la carrière administrative', 'RCA'),
  o('TITULARISATION', 'Titularisation'),
  o('RSA', 'Révision de la situation administrative', 'RSA'),
  o('REINTEGRATION', 'Réintégration'),
];

const COLONNES_PROMOTIONS = [
  col('DATE', 'Date', 'DATE'),
  col('TEXTE', 'Acte (arrêté n°… du…)'),
  col('NATURE', 'Nature', 'LISTE', NATURES_CARRIERE),
  col('GRADE', 'Grade'),
  col('ECHELON', 'Échelon'),
];

const COLONNES_ENFANTS = [
  col('NOM', 'Noms et prénoms'),
  col('NAISSANCE', 'Date de naissance', 'DATE'),
  col('PERE', 'Noms et prénoms du père'),
  col('MERE', 'Noms et prénoms de la mère'),
];

const COLONNES_DIPLOMES = [
  col('DIPLOME', 'Diplôme', 'LISTE', DIPLOMES),
  col('SPECIALITE', 'Spécialité ou série'),
  col('ECOLE', 'École ou établissement'),
  col('ANNEE', 'Année d’obtention'),
];

const STATUTS_ACTIVITE = [
  o('ACTIF', 'À son poste', 'ACTIF', 'EN SERVICE', 'EN POSTE'),
  o(
    'STAGE',
    'En stage ou en formation',
    'STAGE',
    'EN STAGE',
    'FORMATION',
    'EN FORMATION',
  ),
  o('MISSION', 'En mission'),
  o('ABSENT', 'Absent de son poste', 'ABSENT', 'ABANDON DE POSTE'),
  o('SUSPENDU', 'Suspendu'),
];

function champsDefaut(): ChampFiche[] {
  return [
    // Identité
    c('IDENTITE', 'NOMS_PRENOMS', 'Noms et prénoms', 'TEXTE', TOUS, {
      entetes: ['NOMS ET PRENOMS', 'NOM ET PRENOMS', 'NOMS PRENOMS'],
      exemple: 'MOUKOKO Jean Pierre',
      aide: 'Le NOM tout en majuscules, puis les Prénoms (majuscule au début) : on voit ainsi où finit le nom.',
    }),
    c('IDENTITE', 'DATE_NAISSANCE', 'Date de naissance', 'DATE', TOUS, {
      entetes: ['DATE DE NAISSANCE', 'NE LE'],
      exemple: '15/03/1990',
    }),
    c('IDENTITE', 'LIEU_NAISSANCE', 'Lieu de naissance', 'TEXTE', TOUS, {
      exemple: 'Dolisie',
    }),
    c('IDENTITE', 'GENRE', 'Genre', 'LISTE', TOUS, {
      entetes: ['SEXE'],
      options: [
        o('M', 'Masculin', 'HOMME', 'MASCULIN'),
        o('F', 'Féminin', 'FEMME', 'FEMININ'),
      ],
      exemple: 'Masculin',
    }),
    c('IDENTITE', 'NATIONALITE', 'Nationalité', 'TEXTE', TOUS, {
      exemple: 'Congolaise',
    }),
    // Famille
    c(
      'FAMILLE',
      'SITUATION_MATRIMONIALE',
      'Situation matrimoniale',
      'LISTE',
      TOUS,
      {
        options: [
          o('CELIBATAIRE', 'Célibataire', 'SINGLE'),
          o('MARIE', 'Marié(e)', 'MARIEE', 'MARIE (E)', 'MARIE(E)', 'MARRIED'),
          o('DIVORCE', 'Divorcé(e)', 'DIVORCEE', 'DIVORCED'),
          o('VEUF', 'Veuf / veuve', 'VEUVE', 'WIDOWED'),
        ],
        aide: 'Marié(e) : l’acte de mariage est exigé.',
        exemple: 'Marié(e)',
      },
    ),
    c('FAMILLE', 'NOMBRE_ENFANTS', 'Nombre d’enfants', 'NOMBRE', TOUS, {
      aide: 'Un acte de naissance est exigé pour chaque enfant.',
      exemple: '2',
    }),
    c(
      'FAMILLE',
      'NOM_PERE',
      'Noms et prénoms du père de l’agent',
      'TEXTE',
      TOUS,
      {
        entetes: ['NOMS ET PRENOMS DU PERE', 'NOM DE PERE', 'NOM DU PERE'],
      },
    ),
    c(
      'FAMILLE',
      'NOM_MERE',
      'Noms et prénoms de la mère de l’agent',
      'TEXTE',
      TOUS,
      {
        entetes: [
          'NOMS ET PRENOMS DE LA MERE',
          'NOM DE MERE',
          'NOM DE LA MERE',
        ],
      },
    ),
    c('FAMILLE', 'ENFANTS', 'Enfants (une ligne chacun)', 'TABLEAU', [], {
      entetes: ['NOMS ET PRENOMS DES ENFANTS', 'ENFANTS'],
      colonnes: COLONNES_ENFANTS,
      aide: 'Pour chaque enfant : son père et sa mère (ils peuvent changer d’un enfant à l’autre). Son acte de naissance se dépose sur sa ligne (bouton « Déposer l’acte »), sans bloquer la fiche. Dans Excel : les enfants séparés par « ; », les cases par « | ».',
      exemple:
        'MOUKOKO Grâce | 04/06/2015 | MOUKOKO Jean Pierre | NGOMA Alice ; MOUKOKO Paul | 21/01/2019 | MOUKOKO Jean Pierre | NGOMA Alice',
    }),
    // Contacts
    c('CONTACTS', 'TELEPHONE_1', 'Téléphone 1', 'TELEPHONE', [], {
      entetes: ['TELEPHONE-1', 'TELEPHONE 1', 'TELEPHONE'],
      exemple: '06 123 45 67',
    }),
    c('CONTACTS', 'TELEPHONE_2', 'Téléphone 2', 'TELEPHONE', [], {
      entetes: ['TELEPHONE-2'],
    }),
    c('CONTACTS', 'ADRESSE', 'Adresse personnelle', 'TEXTE', [], {
      entetes: ['ADRESSE PERSONNELLE', 'ADRESSE'],
    }),
    c('CONTACTS', 'MAIL', 'Adresse e-mail', 'EMAIL', [], {
      entetes: ['MAIL', 'E-MAIL', 'EMAIL'],
    }),
    // Carrière
    c('CARRIERE', 'MATRICULE_SOLDE', 'Matricule solde', 'TEXTE', AGENTS_ETAT, {
      entetes: ['MATRICULE SOLDE', 'MATRICULE', 'MLE'],
      aide: 'Relevé sur le bulletin de solde (fonctionnaires, contractuels).',
      exemple: '179407Z',
    }),
    c('CARRIERE', 'INDICE_SOLDE', 'Indice solde', 'NOMBRE', AGENTS_ETAT, {
      entetes: ['INDICE SOLDE', 'INDICE'],
      exemple: '488',
    }),
    c(
      'CARRIERE',
      'DATE_RECRUTEMENT',
      'Date de recrutement / d’intégration',
      'DATE',
      TOUS,
      {
        entetes: [
          'DATE DE RECRUTEMENT POUR LES VOLONTAIRES ET COMMUNAUTAIRES',
          'DATE DE RECRUTEMENT',
          "DATE D'INTEGRATION",
        ],
        exemple: '01/10/2022',
      },
    ),
    c(
      'CARRIERE',
      'NATURE_TEXTE_RECRUTEMENT',
      'Nature du texte de recrutement',
      'LISTE',
      [],
      {
        options: NATURES_TEXTE,
        autreValeur: true,
        aide: 'Un fonctionnaire n’entre que par un arrêté ou un décret d’intégration. Rempli tout seul d’après le texte s’il commence par « Arrêté », « Décret » ou « Note ».',
        exemple: 'Arrêté',
      },
    ),
    c(
      'CARRIERE',
      'TEXTE_RECRUTEMENT',
      'Texte de recrutement ou d’affectation (référence)',
      'TEXTE',
      TOUS,
      {
        entetes: [
          "TEXTE DE RECRUTEMENT OU D'AFFECTATION",
          "TEXTE D'INTEGRATION",
          "REF. TEXTE D'INTEGRATION",
          "REFERENCE DU TEXTE D'INTEGRATION",
          'TEXTE DE RECRUTEMENT',
        ],
        aide: 'Sa référence complète, telle qu’elle est signée : « Arrêté n° … du … » (catégories II et III) ou « Décret n° … du … » (catégorie I). S’ils manquent, le système ajoute « Arrêté » ou « Décret » et la date de signature (date de recrutement / d’intégration). Le scan va dans les pièces.',
        exemple:
          'Arrêté n° 21996/MFPTSS/DGFP du 31/12/2025 ou Note de service n° 220/MEPPSA-CAB-DGRHAS-DRSC-SR du 15/10/2026',
      },
    ),
    c('CARRIERE', 'GRADE', 'Grade actuel', 'TEXTE', AGENTS_ETAT, {
      entetes: ['GRADE ACTUEL', 'GRADE'],
      exemple: 'Instituteur',
    }),
    c('CARRIERE', 'CATEGORIE', 'Catégorie', 'TEXTE', AGENTS_ETAT, {
      exemple: 'II',
    }),
    c('CARRIERE', 'ECHELLE', 'Échelle', 'TEXTE', AGENTS_ETAT, { exemple: '1' }),
    c('CARRIERE', 'ECHELON', 'Échelon', 'TEXTE', AGENTS_ETAT, { exemple: '3' }),
    c(
      'CARRIERE',
      'DATE_GRADE',
      'Date de la dernière promotion ou du dernier avancement',
      'DATE',
      AGENTS_ETAT,
      {
        entetes: [
          'DATE DU GRADE ACTUEL',
          'DATE DE GRADE',
          'DATE DE DERNIERE PROMOTION',
          'DATE DU DERNIER AVANCEMENT',
        ],
        aide: 'Fonctionnaire : dernière promotion (tous les 2 ans) ; contractuel : dernier avancement (tous les 2 ans et 4 mois). Le prochain en est calculé.',
      },
    ),
    c('CARRIERE', 'FONCTION', 'Fonction / profession', 'TEXTE', [], {
      referentiel: 'POSTE',
      entetes: ['FONCTION/PROFESSION', 'PROFESSION', 'FONCTION'],
      exemple: 'Enseignant',
    }),
    c(
      'CARRIERE',
      'PROMOTIONS',
      'Grade et échelon successifs (une ligne chacun)',
      'TABLEAU',
      ['FONCTIONNAIRE'],
      {
        entetes: [
          'GRADE ET ECHELON SUCCESSIFS',
          'AUTRES PROMOTIONS OU AVANCEMENTS',
        ],
        colonnes: COLONNES_PROMOTIONS,
        aide: 'Après l’intégration ou l’engagement, chaque changement de grade ou d’échelon : sa date, son acte, sa nature. Fonctionnaire : promotion, reclassement, révision de la carrière administrative ; contractuel : avancement, titularisation, révision de la situation administrative. Dans Excel, tout sur la ligne de l’agent : les lignes séparées par « ; », les cases par « | ».',
        exemple:
          '12/05/2018 | Arrêté n° 1234 du 12/05/2018 | Promotion | Instituteur | 3 ; 03/02/2022 | Arrêté n° 5678 du 03/02/2022 | Reclassement | Instituteur principal | 1',
      },
    ),
    // Formation
    c(
      'FORMATION',
      'DIPLOME_PRO',
      'Diplôme professionnel actuel',
      'LISTE',
      TOUS,
      {
        entetes: ['DIPLOME PROFESSIONNEL ACTUEL', 'DIPLOME'],
        options: DIPLOMES,
        autreValeur: true,
        exemple: 'CFEEN',
      },
    ),
    c('FORMATION', 'SPECIALITE', 'Spécialité', 'TEXTE', TOUS, {
      referentiel: 'MATIERE',
      aide: 'CFEEN : primaire ou préscolaire. Collège et lycée : la matière enseignée. Administratif : sa spécialité.',
      exemple: 'Mathématiques',
    }),
    c('FORMATION', 'CYCLE', 'Cycle', 'LISTE', VOL_COM, {
      options: CYCLES,
      exemple: 'Primaire',
    }),
    c('FORMATION', 'ECOLE_FORMATION', 'École de formation', 'TEXTE', VOL_COM, {
      exemple: 'ENI de Brazzaville',
      aide: 'L’école qui a délivré le diplôme professionnel actuel.',
    }),
    c(
      'FORMATION',
      'PROMOTION_FORMATION',
      'Année d’obtention',
      'TEXTE',
      VOL_COM,
      {
        entetes: [
          'PROMOTION / DATE DE FIN DE FORMATION',
          'DATE DE FIN DE FORMATION',
          "ANNEE D'OBTENTION",
        ],
        aide: 'Année d’obtention du diplôme professionnel actuel (fin de formation).',
        exemple: '2021',
      },
    ),
    c(
      'FORMATION',
      'AUTRES_DIPLOMES',
      'Autres diplômes (une ligne chacun)',
      'TABLEAU',
      TOUS,
      {
        entetes: ['AUTRES DIPLOMES (OUI/NON)', 'AUTRES DIPLOMES'],
        colonnes: COLONNES_DIPLOMES,
        aide: 'Tous les autres diplômes, du CEPE au doctorat, avec l’école et l’année s’ils sont connus (facultatifs). Dans Excel : les diplômes séparés par « ; », les cases par « | ».',
        exemple:
          'CEPE | | | 2008 ; BEPC | | | 2012 ; Baccalauréat | Série A4 | Lycée Savorgnan de Brazza | 2015',
      },
    ),
    // Poste
    c(
      'POSTE',
      'LIEU_SERVICE',
      'Lieu de service (établissement, structure)',
      'TEXTE',
      TOUS,
      {
        referentiel: 'ETABLISSEMENT',
        entetes: ['LIEU DE SERVICE'],
        exemple: 'École primaire de Mfilou',
      },
    ),
    // Ce que l'agent fait dans sa structure (DG, 26/10/2026) ; « Fonction / profession » est sa qualification
    c(
      'POSTE',
      'FONCTION_STRUCTURE',
      'Fonction dans la structure',
      'TEXTE',
      [],
      {
        entetes: [
          'FONCTION DANS LA STRUCTURE',
          'FONCTION OCCUPEE',
          'POSTE OCCUPE',
          'EMPLOI OCCUPE',
        ],
        aide: 'Ce que l’agent fait dans sa structure : chef de bureau, secrétaire, comptable, surveillant général… Sa qualification (instituteur, professeur…) est dans « Fonction / profession ».',
        exemple: 'Chef du bureau des mutations',
      },
    ),
    c(
      'POSTE',
      'NOTE_AFFECTATION',
      'Note d’affectation actuelle',
      'TEXTE',
      TOUS,
      {
        entetes: ["NOTE D'AFFECTATION ACTUELLE", "NOTE D'AFFECTATION"],
        exemple: 'Note n° 1038/MEPPSA-CAB du 15/10/2026',
      },
    ),
    c('POSTE', 'DATE_PRISE_SERVICE', 'Date de prise de service', 'DATE', TOUS, {
      exemple: '02/10/2026',
    }),
    c('POSTE', 'PRESENCE_POSTE', 'Présence au poste', 'LISTE', TOUS, {
      entetes: ['PRESENCE AU POSTE', 'PRESENCE AUPOSTE'],
      options: [o('OUI', 'Oui', 'PRESENT'), o('NON', 'Non', 'ABSENT')],
      aide: 'Oui : donnez la référence de l’attestation de présence au poste.',
      exemple: 'Oui',
    }),
    c(
      'POSTE',
      'REFERENCE_PRESENCE',
      'Attestation de présence au poste (n° et date)',
      'TEXTE',
      [],
      {
        si: { champ: 'PRESENCE_POSTE', valeurs: ['OUI'] },
        aide: 'Elle peut être délivrée à tout moment ; son scan va dans les pièces.',
        exemple: 'N° 045/DDEPPSA-NIARI du 02/10/2026',
      },
    ),
    c(
      'POSTE',
      'AFFECTATIONS_SUCCESSIVES',
      'Affectations successives (une ligne chacune)',
      'TABLEAU',
      [],
      {
        colonnes: [
          col('NOTE', 'Note (n° et date)'),
          col('DATE', 'Prise de service', 'DATE'),
          col('LIEU', 'Lieu de service'),
        ],
        aide: 'Une ligne par affectation. Dans Excel : les affectations séparées par « ; », les cases par « | ».',
        exemple:
          'Note n° 270 du 08/04/2019 | 02/05/2019 | EPP Mfilou ; Note n° 1038 du 15/10/2024 | 04/11/2024 | CEG Nkayi 2',
      },
    ),
    // Rattachement
    c(
      'RATTACHEMENT',
      'VILLE',
      'Ville / district / arrondissement',
      'TEXTE',
      TOUS,
      {
        referentiel: 'LOCALITE',
        entetes: [
          'VILLE/DISTRICT/ARRONDISSEMENT',
          'VILLE',
          'DISTRICT/ARRONDISSEMENT',
          'DISTRICT',
        ],
        exemple: 'Dolisie',
      },
    ),
    c('RATTACHEMENT', 'DIRECTION_GENERALE', 'Direction générale', 'TEXTE', []),
    c('RATTACHEMENT', 'DIRECTION_CENTRALE', 'Direction centrale', 'TEXTE', [], {
      referentiel: 'STRUCTURE',
    }),
    c('RATTACHEMENT', 'DEPARTEMENT', 'Département', 'DEPARTEMENT', TOUS, {
      exemple: 'Niari',
    }),
    c('RATTACHEMENT', 'INSPECTION', 'Inspection', 'TEXTE', TOUS, {
      referentiel: 'INSPECTION',
      entetes: [
        'CIRCONSCRIPTION/INSPECTION DEPARTEMENTALE',
        'CIRCONSCRIPTION',
        'INSPECTION DEPARTEMENTALE',
      ],
      exemple: 'Inspection primaire de Dolisie 1',
    }),
    // Situation
    c('SITUATION', 'POSITION', 'Position', 'LISTE', TOUS, {
      options: [
        o('ACTIVITE', 'En activité', 'EN SERVICE', 'ACTIVITE', 'ACTIF'),
        o('CONGE', 'En congé', 'CONGE'),
        o('DETACHEMENT', 'En détachement'),
        o('DISPONIBILITE', 'En disponibilité'),
        o('RETRAITE', 'Retraité(e)', 'RETRAITE', 'RETRAITEE'),
        o('DECEDE', 'Décédé(e)', 'DECEDEE'),
      ],
      exemple: 'En activité',
    }),
    c('SITUATION', 'DISPONIBILITE', 'Disponibilité', 'LISTE', TOUS, {
      options: [
        o('TEMPS_PLEIN', 'Temps plein'),
        o('TEMPS_PARTIEL', 'Temps partiel'),
      ],
      exemple: 'Temps plein',
    }),
    c('SITUATION', 'STATUT_ACTIVITE', 'Statut d’activité', 'LISTE', TOUS, {
      entetes: ["STATUT D'ACTIVITE"],
      options: STATUTS_ACTIVITE,
      autreValeur: true,
      aide: 'Le détail de ce que fait l’agent. La position est sa situation administrative ; un instituteur admis à l’ENS est « en activité » (position) mais « en stage ou en formation » (statut d’activité).',
      exemple: 'À son poste',
    }),
  ];
}

const pe = (
  code: string,
  libelle: string,
  exigeePour: string[],
  autres: Partial<PieceExigee> = {},
): PieceExigee => ({
  code,
  libelle,
  exigeePour,
  si: null,
  nombreSelon: null,
  actif: true,
  ...autres,
});

export function configDefaut(): ConfigRecensement {
  return {
    version: 1,
    revision: REVISION,
    statuts: [
      {
        code: 'FONCTIONNAIRE',
        libelle: 'Fonctionnaire',
        synonymes: ['FONCTIONNAIRE', 'TITULAIRE'],
        actif: true,
      },
      {
        code: 'CONTRACTUEL',
        libelle: 'Contractuel',
        synonymes: ['CONTRACTUEL', 'CONTRACTUELLE'],
        actif: true,
      },
      {
        code: 'VOLONTAIRE',
        libelle: 'Volontaire',
        synonymes: ['VOLONTAIRE', 'ENSEIGNANT VOLONTAIRE'],
        actif: true,
      },
      {
        code: 'COMMUNAUTAIRE',
        libelle: 'Communautaire',
        synonymes: ['COMMUNAUTAIRE'],
        actif: true,
      },
    ],
    sections: [
      { code: 'IDENTITE', libelle: 'Identité' },
      { code: 'FAMILLE', libelle: 'Situation de famille' },
      { code: 'CONTACTS', libelle: 'Contacts' },
      { code: 'CARRIERE', libelle: 'Statut et carrière' },
      { code: 'FORMATION', libelle: 'Formation et diplômes', colonnes: 5 },
      { code: 'POSTE', libelle: 'Poste et affectations' },
      { code: 'RATTACHEMENT', libelle: 'Rattachement' },
      { code: 'SITUATION', libelle: 'Position et activité' },
    ],
    champs: champsDefaut(),
    pieces: [
      pe('ACTE_NAISSANCE', 'Acte de naissance', TOUS),
      pe('CNI', 'CNI ou autre pièce d’identité valide', TOUS),
      pe('PHOTO', 'Photo d’identité en couleur', TOUS),
      pe('ACTE_MARIAGE', 'Acte de mariage', TOUS, {
        si: { champ: 'SITUATION_MATRIMONIALE', valeurs: ['MARIE'] },
      }),
      pe('ACTE_NAISSANCE_ENFANT', 'Acte de naissance d’un enfant', TOUS, {
        nombreSelon: 'NOMBRE_ENFANTS',
      }),
      pe(
        'BULLETIN_SOLDE',
        'Bulletin de solde récent (3 mois au plus)',
        AGENTS_ETAT,
      ),
      pe(
        'TEXTE_RECRUTEMENT',
        'Note ou contrat de recrutement ou d’affectation',
        TOUS,
      ),
      pe(
        'ARRETE_GRADE',
        'Arrêté de la dernière promotion, de l’avancement ou du reclassement',
        AGENTS_ETAT,
      ),
      pe(
        'ARRETE_PROMOTION',
        'Arrêté de promotion ou d’avancement',
        ['FONCTIONNAIRE'],
        {
          nombreSelon: 'PROMOTIONS',
        },
      ),
      pe('ATTESTATION_PRESENCE', 'Attestation de présence au poste', TOUS),
      pe('NOTE_AFFECTATION_ANCIENNE', 'Note d’une affectation précédente', [], {
        nombreSelon: 'AFFECTATIONS_SUCCESSIVES',
      }),
      pe('DIPLOME', 'Diplôme professionnel', []),
    ],
    regles: [
      {
        code: 'DIPLOME_SUPERIEUR_PRIMAIRE',
        libelle:
          'Licence, master, CAPES… avec le cycle préscolaire ou primaire',
        si: {
          champ: 'DIPLOME_PRO',
          valeurs: [
            'LICENCE',
            'MAITRISE',
            'MASTER',
            'DOCTORAT',
            'CAPES',
            'CAPEL',
            'CAP_CEG',
          ],
        },
        alors: {
          champ: 'CYCLE',
          valeurs: ['COLLEGE', 'LYCEE', 'ADMINISTRATION'],
        },
        actif: true,
      },
      {
        code: 'CFEEN_SECONDAIRE',
        libelle: 'CFEEN avec un cycle autre que préscolaire ou primaire',
        si: { champ: 'DIPLOME_PRO', valeurs: ['CFEEN'] },
        alors: {
          champ: 'CYCLE',
          valeurs: ['PRESCOLAIRE', 'PRIMAIRE', 'ALPHABETISATION'],
        },
        actif: true,
      },
      {
        code: 'RETRAITE_ENCORE_ACTIF',
        libelle: 'Retraité ou décédé encore noté « à son poste »',
        si: { champ: 'POSITION', valeurs: ['RETRAITE', 'DECEDE'] },
        alors: { champ: 'STATUT_ACTIVITE', valeurs: ['ABSENT', 'SUSPENDU'] },
        actif: true,
      },
    ],
    ageMinimum: 18,
    ageRetraite: null,
    delaiPromotionMois: 24,
    delaiAvancementMois: 28,
    telephonePartage: 3,
    contentieuxHorsBase: true,
  };
}

/** Place la rubrique « code » juste après « apres » (ou avant « avant »), si elles existent. */
/** Rubriques par défaut absentes d'une configuration enregistrée, placées après celle qui les précède. */
function ajouterManquantes(champs: ChampFiche[], defaut: ChampFiche[]) {
  let l = [...champs];
  defaut.forEach((d, i) => {
    if (l.some((x) => x.code === d.code)) return;
    l.push(d);
    if (i > 0) l = placer(l, d.code, { apres: defaut[i - 1].code });
  });
  return l;
}

function placer(
  champs: ChampFiche[],
  code: string,
  ou: { apres?: string; avant?: string },
) {
  const x = champs.find((c) => c.code === code);
  const repere = ou.apres ?? ou.avant;
  if (!x || !repere || !champs.some((c) => c.code === repere)) return champs;
  const reste = champs.filter((c) => c !== x);
  const i = reste.findIndex((c) => c.code === repere);
  reste.splice(ou.apres ? i + 1 : i, 0, x);
  return reste;
}

/**
 * Configuration enregistrée avant une révision des valeurs par défaut : elle reçoit les nouvelles
 * rubriques et les rubriques revues (libellé, cases, valeurs, aide), en gardant ce que le DG a réglé
 * (rubrique obligatoire ou non, active ou non, en-têtes reconnus).
 */
export function mettreAJour(
  c: ConfigRecensement,
  depuis: number,
): ConfigRecensement {
  if (depuis >= REVISION) return { ...c, revision: REVISION };
  const defaut = configDefaut();
  // Révisions 3 et 4 : chaque rubrique reçoit les en-têtes reconnus par défaut et les autres
  // écritures de ses valeurs (« PRESOLAIRE »…) ; ceux du DG sont gardés
  if (depuis >= 2)
    return {
      ...c,
      revision: REVISION,
      // Révision 5 : les rubriques ajoutées depuis (« Fonction dans la structure ») viennent à leur place
      champs: ajouterManquantes(c.champs, defaut.champs).map((x) => {
        const d = defaut.champs.find((y) => y.code === x.code);
        return d
          ? {
              ...x,
              entetes: [...new Set([...(x.entetes ?? []), ...d.entetes])],
              options: x.options.map((o) => {
                const od = d.options.find((y) => y.code === o.code);
                return od
                  ? {
                      ...o,
                      synonymes: [
                        ...new Set([...o.synonymes, ...od.synonymes]),
                      ],
                    }
                  : o;
              }),
            }
          : x;
      }),
    };
  const parCode = new Map(defaut.champs.map((x) => [x.code, x]));
  // Révision 2 (DG, 24/10/2026)
  const revues = [
    'NOMS_PRENOMS',
    'NOM_PERE',
    'NOM_MERE',
    'ENFANTS',
    'DIPLOME_PRO',
    'TEXTE_RECRUTEMENT',
    'DATE_GRADE',
    'PROMOTIONS',
    'SPECIALITE',
    'ECOLE_FORMATION',
    'PROMOTION_FORMATION',
    'AUTRES_DIPLOMES',
    'PRESENCE_POSTE',
    'STATUT_ACTIVITE',
  ];
  let champs = c.champs.map((x): ChampFiche => {
    const d = parCode.get(x.code);
    if (!d || !revues.includes(x.code)) return x;
    return {
      ...x,
      libelle: d.libelle,
      type: d.type,
      colonnes: d.colonnes,
      options: d.options,
      autreValeur: d.autreValeur,
      aide: d.aide,
      exemple: d.exemple,
      entetes: [...new Set([...(x.entetes ?? []), ...d.entetes])],
    };
  });
  for (const [code, ou] of [
    ['NATURE_TEXTE_RECRUTEMENT', { avant: 'TEXTE_RECRUTEMENT' }],
    ['REFERENCE_PRESENCE', { apres: 'PRESENCE_POSTE' }],
  ] as const)
    if (!champs.some((x) => x.code === code)) {
      champs.push(parCode.get(code)!);
      champs = placer(champs, code, ou);
    }
  // Parents de l'agent avant ses enfants ; le diplôme actuel sur une ligne (diplôme, spécialité,
  // cycle, école, année), puis les autres diplômes
  champs = placer(champs, 'ENFANTS', { apres: 'NOM_MERE' });
  for (const [code, apres] of [
    ['SPECIALITE', 'DIPLOME_PRO'],
    ['CYCLE', 'SPECIALITE'],
    ['ECOLE_FORMATION', 'CYCLE'],
    ['PROMOTION_FORMATION', 'ECOLE_FORMATION'],
    ['AUTRES_DIPLOMES', 'PROMOTION_FORMATION'],
  ])
    champs = placer(champs, code, { apres });
  const regleDefaut = new Map(defaut.regles.map((r) => [r.code, r]));
  return {
    ...c,
    revision: REVISION,
    champs,
    sections: c.sections.map((x) =>
      x.code === 'FORMATION' && !x.colonnes ? { ...x, colonnes: 5 } : x,
    ),
    regles: c.regles.map((r) =>
      r.code === 'RETRAITE_ENCORE_ACTIF'
        ? {
            ...r,
            libelle: regleDefaut.get(r.code)!.libelle,
            alors: regleDefaut.get(r.code)!.alors,
          }
        : r,
    ),
    // L'âge de 60 ans supposé pour une catégorie inconnue est retiré (DG, 24/10/2026)
    ageRetraite: c.ageRetraite === 60 ? null : c.ageRetraite,
    delaiPromotionMois: c.delaiPromotionMois ?? defaut.delaiPromotionMois,
    delaiAvancementMois: c.delaiAvancementMois ?? defaut.delaiAvancementMois,
  };
}

@Injectable()
export class ConfigRecensementService {
  private cache: ConfigRecensement | null = null;

  constructor(
    @InjectRepository(Parametre) private readonly repo: Repository<Parametre>,
    private readonly params: ParametresService,
  ) {}

  get(): ConfigRecensement {
    if (this.cache) return this.cache;
    let c: ConfigRecensement = configDefaut();
    try {
      const brut = this.params.get(CLE);
      if (brut) {
        const enregistree = JSON.parse(brut) as Partial<ConfigRecensement>;
        c = mettreAJour(
          { ...c, ...enregistree, version: 1 },
          enregistree.revision ?? 1,
        );
      }
    } catch {
      c = configDefaut();
    }
    // Configuration enregistrée avant les tableaux : les historiques connus deviennent des tableaux
    const defauts = new Map(configDefaut().champs.map((x) => [x.code, x]));
    c.champs = c.champs.map((x) => {
      const d = defauts.get(x.code);
      if (x.type === 'LIGNES' && d?.type === 'TABLEAU')
        return {
          ...x,
          type: 'TABLEAU',
          colonnes: d.colonnes,
          aide: d.aide,
          exemple: d.exemple,
        };
      // Rubriques qui reçoivent leur liste de référence (configuration enregistrée avant les listes)
      return {
        ...x,
        colonnes: x.colonnes ?? [],
        referentiel:
          x.referentiel === undefined
            ? (d?.referentiel ?? null)
            : x.referentiel,
      };
    });
    this.cache = c;
    return c;
  }

  async enregistrer(brut: unknown): Promise<ConfigRecensement> {
    const c = valider(brut);
    await this.repo.save({
      cle: CLE,
      valeur: JSON.stringify(c),
      description:
        'Configuration du recensement (fiche de renseignements, pièces, contrôles)',
    });
    await this.params.charger();
    this.cache = null;
    return this.get();
  }

  statut(code: string | null | undefined) {
    return this.get().statuts.find((s) => s.code === code) ?? null;
  }

  /** Type d'agent d'après le texte d'un fichier (« FONCTIONNAIRE », « Volontaire »…). */
  statutDepuisTexte(v: unknown): StatutAgent | null {
    const k = cleCompacte(v);
    if (!k) return null;
    const actifs = this.get().statuts.filter((s) => s.actif);
    return (
      actifs.find((s) =>
        [s.code, s.libelle, ...s.synonymes].some((x) => cleCompacte(x) === k),
      ) ??
      actifs.find((s) =>
        [s.code, s.libelle, ...s.synonymes].some(
          (x) => cleCompacte(x).length >= 5 && k.startsWith(cleCompacte(x)),
        ),
      ) ??
      null
    );
  }
}

/* ------------------------------ Contrôle ------------------------------ */

const texte = (v: unknown, nom: string, max = 200) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new BadRequestException(`${nom} : ne peut pas rester vide.`);
  if (s.length > max)
    throw new BadRequestException(`${nom} : ${max} caractères au plus.`);
  return s;
};
const libre = (v: unknown, max = 500) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const code = (v: unknown, nom: string) => {
  const s = normaliser(v)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (!s || s.length > 40)
    throw new BadRequestException(`${nom} : code manquant ou trop long.`);
  return s;
};
const entier = (v: unknown, nom: string, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new BadRequestException(
      `${nom} : nombre entier entre ${min} et ${max} attendu.`,
    );
  return n;
};
const liste = (v: unknown, max = 50): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => libre(x, 120))
    .filter(Boolean)
    .slice(0, max);
const uniques = <T extends { code: string }>(xs: T[], quoi: string) => {
  const vus = new Set<string>();
  for (const x of xs) {
    if (vus.has(x.code))
      throw new BadRequestException(
        `Deux ${quoi} ont le même code « ${x.code} ».`,
      );
    vus.add(x.code);
  }
};

export function valider(brut: unknown): ConfigRecensement {
  if (!brut || typeof brut !== 'object')
    throw new BadRequestException('Configuration attendue.');
  const b = brut as Record<string, unknown>;
  const tableau = (k: string) =>
    Array.isArray(b[k]) ? (b[k] as Record<string, unknown>[]) : [];

  const statuts = tableau('statuts').map((x, i): StatutAgent => {
    const lib = texte(x?.libelle, `Type d’agent n° ${i + 1}`, 60);
    return {
      code: code(x?.code || lib, `Type d’agent « ${lib} »`),
      libelle: lib,
      synonymes: liste(x?.synonymes, 20),
      actif: x?.actif !== false,
    };
  });
  if (!statuts.some((s) => s.actif))
    throw new BadRequestException('Il faut au moins un type d’agent actif.');
  uniques(statuts, 'types d’agent');
  const codesStatuts = new Set(statuts.map((s) => s.code));
  const statutsDe = (v: unknown) =>
    liste(v, 20).filter((s) => codesStatuts.has(s));

  const sections = tableau('sections').map((x, i): Section => {
    const lib = texte(x?.libelle, `Section n° ${i + 1}`, 80);
    const colonnes = Number(x?.colonnes);
    return {
      code: code(x?.code || lib, `Section « ${lib} »`),
      libelle: lib,
      ...(Number.isInteger(colonnes) && colonnes >= 1 && colonnes <= 6
        ? { colonnes }
        : {}),
    };
  });
  if (!sections.length)
    throw new BadRequestException('Il faut au moins une section.');
  uniques(sections, 'sections');
  const codesSections = new Set(sections.map((s) => s.code));

  const condition = (v: unknown, nom: string): Condition | null => {
    const x = v as Record<string, unknown> | null;
    if (!x || !x.champ) return null;
    return {
      champ: code(x.champ, nom),
      valeurs: liste(x.valeurs, 50).map((s) => code(s, nom)),
    };
  };

  const champs = tableau('champs').map((x, i): ChampFiche => {
    const lib = texte(x?.libelle, `Rubrique n° ${i + 1}`, 120);
    const type = String(x?.type) as TypeChamp;
    if (!(type in LIBELLES_TYPES))
      throw new BadRequestException(`Rubrique « ${lib} » : type inconnu.`);
    const section = enTexte(x?.section);
    if (!codesSections.has(section))
      throw new BadRequestException(
        `Rubrique « ${lib} » : choisissez sa section.`,
      );
    const options = (
      Array.isArray(x?.options) ? (x.options as Record<string, unknown>[]) : []
    ).map((y, j) => {
      const ol = texte(
        y?.libelle,
        `Rubrique « ${lib} », valeur n° ${j + 1}`,
        80,
      );
      return {
        code: code(y?.code || ol, `Valeur « ${ol} »`),
        libelle: ol,
        synonymes: liste(y?.synonymes, 20),
      };
    });
    if ((type === 'LISTE' || type === 'LISTE_MULTIPLE') && !options.length)
      throw new BadRequestException(
        `Rubrique « ${lib} » : une liste a besoin d’au moins une valeur.`,
      );
    uniques(options, `valeurs de « ${lib} »`);
    const colonnes = (
      Array.isArray(x?.colonnes)
        ? (x.colonnes as Record<string, unknown>[])
        : []
    ).map((y, j): ColonneTableau => {
      const cl = texte(y?.libelle, `Rubrique « ${lib} », case n° ${j + 1}`, 80);
      const t = ['TEXTE', 'DATE', 'NOMBRE', 'LISTE'].includes(String(y?.type))
        ? (y.type as ColonneTableau['type'])
        : 'TEXTE';
      const opts = (
        Array.isArray(y?.options)
          ? (y.options as Record<string, unknown>[])
          : []
      ).map((z, k) => {
        const zl = texte(z?.libelle, `Case « ${cl} », valeur n° ${k + 1}`, 80);
        return {
          code: code(z?.code || zl, `Valeur « ${zl} »`),
          libelle: zl,
          synonymes: liste(z?.synonymes, 20),
        };
      });
      return {
        code: code(y?.code || cl, `Case « ${cl} »`),
        libelle: cl,
        type: t === 'LISTE' && !opts.length ? 'TEXTE' : t,
        options: opts,
      };
    });
    if (type === 'TABLEAU' && !colonnes.length)
      throw new BadRequestException(
        `Rubrique « ${lib} » : un tableau a besoin d’au moins une case.`,
      );
    uniques(colonnes, `cases de « ${lib} »`);
    const cd = code(x?.code || lib, `Rubrique « ${lib} »`);
    return {
      code: cd,
      libelle: lib,
      section,
      type,
      obligatoirePour: statutsDe(x?.obligatoirePour),
      si: condition(x?.si, `Condition de « ${lib} »`),
      options,
      autreValeur: x?.autreValeur === true,
      entetes: liste(x?.entetes, 20),
      aide: libre(x?.aide),
      exemple: libre(x?.exemple, 200),
      actif: CHAMPS_SYSTEME.includes(cd) ? true : x?.actif !== false,
      systeme: CHAMPS_SYSTEME.includes(cd),
      colonnes: type === 'TABLEAU' ? colonnes : [],
      referentiel:
        type === 'TEXTE' && LISTES_REFERENCE.includes(String(x?.referentiel))
          ? String(x.referentiel)
          : null,
    };
  });
  uniques(champs, 'rubriques');
  for (const s of CHAMPS_SYSTEME)
    if (!champs.some((x) => x.code === s))
      throw new BadRequestException(
        `La rubrique « ${configDefaut().champs.find((x) => x.code === s)?.libelle ?? s} » sert au système (recherche, doublons, département) : elle ne peut pas être supprimée.`,
      );
  const codesChamps = new Map(champs.map((x) => [x.code, x]));
  const verifierCondition = (cd: Condition | null, ou: string) => {
    if (!cd) return;
    const ch = codesChamps.get(cd.champ);
    if (!ch)
      throw new BadRequestException(
        `${ou} : la rubrique « ${cd.champ} » n’existe pas.`,
      );
    for (const v of cd.valeurs)
      if (ch.options.length && !ch.options.some((op) => op.code === v))
        throw new BadRequestException(
          `${ou} : « ${v} » n’est pas une valeur de « ${ch.libelle} ».`,
        );
  };
  for (const x of champs)
    verifierCondition(x.si, `Condition de « ${x.libelle} »`);

  const pieces = tableau('pieces').map((x, i): PieceExigee => {
    const lib = texte(x?.libelle, `Pièce n° ${i + 1}`, 120);
    const nombreSelon = x?.nombreSelon
      ? code(x.nombreSelon, `Pièce « ${lib} »`)
      : null;
    if (nombreSelon) {
      const ch = codesChamps.get(nombreSelon);
      if (
        !ch ||
        !['NOMBRE', 'LIGNES', 'LISTE_MULTIPLE', 'TABLEAU'].includes(ch.type)
      )
        throw new BadRequestException(
          `Pièce « ${lib} » : « une par… » doit désigner une rubrique « nombre » ou « plusieurs lignes ».`,
        );
    }
    return {
      code: code(x?.code || lib, `Pièce « ${lib} »`),
      libelle: lib,
      exigeePour: statutsDe(x?.exigeePour),
      si: condition(x?.si, `Condition de « ${lib} »`),
      nombreSelon,
      actif: x?.actif !== false,
    };
  });
  uniques(pieces, 'pièces');
  for (const x of pieces)
    verifierCondition(x.si, `Condition de « ${x.libelle} »`);

  const regles = tableau('regles').map((x, i): RegleCoherence => {
    const lib = texte(x?.libelle, `Règle de cohérence n° ${i + 1}`, 160);
    const si = condition(x?.si, `Règle « ${lib} »`);
    const alors = condition(x?.alors, `Règle « ${lib} »`);
    if (!si || !alors || !si.valeurs.length || !alors.valeurs.length)
      throw new BadRequestException(
        `Règle « ${lib} » : choisissez les rubriques et les valeurs (« si … alors … »).`,
      );
    verifierCondition(si, `Règle « ${lib} »`);
    verifierCondition(alors, `Règle « ${lib} »`);
    return {
      code: code(x?.code || lib, `Règle « ${lib} »`),
      libelle: lib,
      si,
      alors,
      actif: x?.actif !== false,
    };
  });
  uniques(regles, 'règles');

  return {
    version: 1,
    revision: REVISION,
    statuts,
    sections,
    champs,
    pieces,
    regles,
    ageMinimum: entier(b.ageMinimum, 'Âge minimum', 14, 40),
    // Vide : aucun âge supposé quand la catégorie de l'agent est inconnue
    ageRetraite:
      b.ageRetraite === null ||
      b.ageRetraite === undefined ||
      b.ageRetraite === ''
        ? null
        : entier(b.ageRetraite, 'Âge de la retraite', 45, 75),
    delaiPromotionMois: entier(
      b.delaiPromotionMois ?? 24,
      'Délai de promotion (mois)',
      6,
      120,
    ),
    delaiAvancementMois: entier(
      b.delaiAvancementMois ?? 28,
      'Délai d’avancement (mois)',
      6,
      120,
    ),
    telephonePartage: entier(b.telephonePartage, 'Téléphone partagé', 2, 50),
    contentieuxHorsBase: b.contentieuxHorsBase !== false,
  };
}
