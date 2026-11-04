/**
 * Demandes de prestations traitées dans leur propre module (DG, 02/11/2026), une à une, d'après le
 * document de la DGRHAS « Circuits d'approbation des demandes de prestation » (58 types) et le
 * « Formulaire de demande de prestation ». Les mutations gardent leur module.
 *
 * Chaque prestation est une DÉFINITION, lue par le moteur (moteur.ts) : l'acte délivré, les pièces
 * jointes, le niveau de décision, les renseignements propres à la demande, et le modèle de l'acte
 * sortant (provisoire, en attendant les modèles officiels). Le circuit (voie hiérarchique, puis
 * étapes à la DGRHAS) est celui du catalogue (Administration › Catalogue des prestations), sous le
 * même code. Introduire une nouvelle prestation : ajouter sa définition à PRESTATIONS (le test
 * definitions.spec.ts vérifie qu'elle est complète et que son modèle s'écrit).
 */

export type TypeChamp = 'texte' | 'zone' | 'departement' | 'liste' | 'date';

export interface ChampPrestation {
  cle: string;
  libelle: string;
  type: TypeChamp;
  obligatoire?: boolean;
  /** Explication courte sous le champ (le jargon de la DGRHAS, dit simplement). */
  aide?: string;
  exemple?: string;
  /** `acte` : le texte de l'option dans l'acte (« masculin|féminin » si besoin). */
  options?: { valeur: string; libelle: string; acte?: string }[];
}

/** Modèle de l'acte sortant (repères : voir moteur.ts). */
export interface ModeleActe {
  /** Titre (« Note de service portant affectation »). */
  titre: string;
  /**
   * En-tête : ministère et DGRHAS, direction départementale, primature (décret), ou la structure
   * qui a décidé (certificat du lieu de service).
   */
  entete: 'DGRHAS' | 'DDEPPSA' | 'PRIMATURE' | 'STRUCTURE';
  /** Ce qui précède « DÉCIDE : » ou « DÉCRÈTE : » (visas). */
  preambule: string[];
  /** Aucune pour un certificat ou une attestation (« Je soussigné… certifie que… »). */
  formule: 'DÉCIDE' | 'DÉCRÈTE' | null;
  /**
   * ARTICLES (« Article 1er : … »), TEXTE (paragraphes : certificats, attestations) ou LETTRE
   * (soit-transmis, lettre de transmission : destinataire, objet, appel, puis le tableau des
   * pièces jointes, écrit tout seul d'après le dossier).
   */
  forme: 'ARTICLES' | 'TEXTE' | 'LETTRE';
  /** Lettre : à qui, objet, formule d'appel (repères permis, `{param:…}` surtout). */
  lettre?: { destinataire: string; objet: string; appel: string };
  articles: string[];
  ampliations: string[];
  /**
   * Soit-transmis écrit comme les modèles de la DGRHAS (04/11/2026) : « Transmission d’une (01)
   * demande de … », ou de plusieurs, avec le tableau des agents (transmission collective).
   */
  transmission?: TransmissionModele;
}

/** Colonnes du tableau d'une transmission collective (après « N° » et « Noms et prénoms »). */
export type ColonneTransmission =
  | 'GRADE'
  | 'FONCTION'
  | 'TEXTE_RECRUTEMENT'
  | 'TEXTE_PROMOTION'
  | 'NOTE_NOMINATION'
  | 'DATE_PRISE_SERVICE'
  | 'MATRICULE'
  | 'STRUCTURE'
  | 'DEPARTEMENT';

export interface TransmissionModele {
  /** Ce qui suit « demande(s) » : « de prise en charge en solde » (repères permis). */
  demande: string;
  /** Après l'identité de l'agent, avant « en service à » (« intégré par l'arrêté… »). */
  apresIdentite?: string;
  /** À la fin de la phrase (« , depuis le 12/09/2025 »). */
  suite?: string;
  /**
   * Toute la phrase après « pour compétence, », quand elle ne suit pas le modèle commun (capital
   * décès : la demande vient de l'ayant droit).
   */
  corps?: string;
  colonnes: ColonneTransmission[];
}

export interface PieceExigee {
  libelle: string;
  /** Sans elle, la demande n'est pas envoyée. */
  obligatoire?: boolean;
  aide?: string;
}

export interface DefinitionPrestation {
  /** Même code que dans le catalogue (circuit). */
  code: string;
  /** N° dans le document de la DGRHAS. */
  numero: number;
  libelle: string;
  /** Famille, pour ranger les démarches. */
  famille:
    | 'AFFECTATION'
    | 'NOMINATION'
    | 'RECTIFICATIF'
    | 'CERTIFICAT'
    | 'ATTESTATION'
    | 'AUTORISATION'
    | 'CONGE'
    | 'CESSATION'
    | 'POSITION'
    | 'CARRIERE'
    | 'SOLDE'
    | 'PRIME'
    | 'RAPPEL'
    | 'SOCIAL';
  /** Réservée aux femmes (congé de maternité) ou aux hommes (congé de paternité), d'après la fiche. */
  pour?: 'F' | 'M';
  /** Dates dans l'ordre : `avant` ne peut pas être après `apres` (début et fin d'un congé…). */
  ordreDates?: { avant: string; apres: string }[];
  /** Pour qui, en une phrase. */
  pourQui: string;
  /** Acte délivré (document de la DGRHAS). */
  acte: string;
  /** Niveau de décision, écrit comme dans le document. */
  niveauDecision: string;
  /** Qui signe l'acte (repères permis : « Le {decideur.poste} » pour le lieu de service). */
  signataire: string;
  /** Objet proposé (modifiable). */
  objet: string;
  champs: ChampPrestation[];
  /** La première est indispensable à l'envoi (la demande manuscrite, sauf exception du document). */
  pieces: PieceExigee[];
  acteModele: ModeleActe;
}

const DEMANDE: PieceExigee = {
  libelle: 'Demande manuscrite et formulaire de demande',
  obligatoire: true,
  aide: 'La lettre écrite et signée par l’agent, enregistrée au registre de sa structure.',
};
const INTEGRATION: PieceExigee = {
  libelle: 'Texte d’intégration à la Fonction publique',
  obligatoire: true,
  aide: 'L’arrêté ou le décret qui a fait de l’agent un fonctionnaire.',
};
const PRESENCE: PieceExigee = {
  libelle: 'Attestation de présence au poste',
  obligatoire: true,
};
const PREMIERE_PRISE: PieceExigee = {
  libelle: 'Premier certificat de prise de service',
  obligatoire: true,
  aide: 'Celui du tout premier poste de l’agent.',
};
const BULLETIN: PieceExigee = {
  libelle: 'Photocopie du bulletin de solde récent',
  obligatoire: true,
};
const CV: PieceExigee = { libelle: 'Curriculum vitae', obligatoire: true };

/** Repères communs des modèles d'acte. */
/**
 * Dernière ligne avant les articles (DG, 03/11/2026) : le signataire est en bas de l'acte, on
 * n'écrit plus « Le Ministre… DÉCIDE ».
 */
const VU_DEMANDE =
  'Au vu de la demande de {f:l’intéressé|l’intéressée} et des avis :';
const EFFET =
  'La présente note de service prend effet à compter de sa date de signature.';
const DDEPPSA_DE =
  'Direction départementale de l’enseignement préscolaire, primaire, secondaire et de l’alphabétisation du département de';
const AMPLIATIONS = [
  '{f:Intéressé|Intéressée}',
  '[[DDEPPSA {agent.departement}]]',
  '[[{agent.lieuService}]]',
  'DGRHAS',
  'Archives',
];
const NOTE_MINISTRE = {
  entete: 'DGRHAS' as const,
  preambule: [VU_DEMANDE],
  formule: null,
  forme: 'ARTICLES' as const,
  ampliations: AMPLIATIONS,
};
/** Certificat ou attestation signé par le responsable du lieu de service. */
const CERTIFICAT_LIEU = {
  entete: 'STRUCTURE' as const,
  preambule: [],
  formule: null,
  forme: 'TEXTE' as const,
  ampliations: [
    '{f:Intéressé|Intéressée}',
    '[[DDEPPSA {agent.departement}]]',
    'Archives',
  ],
};
/** Attestation de la DGRHAS (le DG atteste). */
const ATTESTATION_DGRHAS = {
  entete: 'DGRHAS' as const,
  preambule: [],
  formule: null,
  forme: 'TEXTE' as const,
  ampliations: ['{f:Intéressé|Intéressée}', 'Archives'],
};
const LE_DG =
  'Le Directeur général des ressources humaines et de l’administration scolaire';
const EN_FOI_CERTIFICAT =
  'En foi de quoi, le présent certificat lui est délivré pour servir et valoir ce que de droit.';
const EN_FOI_ATTESTATION =
  'En foi de quoi, la présente attestation lui est délivrée pour servir et valoir ce que de droit.';
const JE_SOUSSIGNE = 'Je soussigné(e), {decideur.poste} ({decideur.nom}),';
const SIGNE_LIEU = 'Le {decideur.poste}';
const AFFECTATIONS: PieceExigee = {
  libelle: 'Notes d’affectation',
  obligatoire: true,
};
const PRISE: PieceExigee = {
  libelle: 'Certificat de prise de service',
  obligatoire: true,
};
const TEXTE_INTEGRATION_OU_ENGAGEMENT: PieceExigee = {
  libelle: 'Texte d’intégration ou d’engagement',
  obligatoire: true,
  aide: 'L’arrêté ou le décret d’intégration (fonctionnaire), ou le contrat d’engagement (contractuel).',
};
const NOTE_MIN: PieceExigee = {
  libelle: 'Note d’affectation ministérielle',
  obligatoire: true,
};
const NOTE_DEP: PieceExigee = {
  libelle: 'Note d’affectation départementale',
  obligatoire: true,
};
const DEBUT: ChampPrestation = {
  cle: 'dateDebut',
  libelle: 'Du',
  type: 'date',
  obligatoire: true,
};
const FIN: ChampPrestation = {
  cle: 'dateFin',
  libelle: 'Au (inclus)',
  type: 'date',
  obligatoire: true,
};
const PERIODE = [{ avant: 'dateDebut', apres: 'dateFin' }];
const AFFECT_NOMINATION: PieceExigee = {
  libelle: 'Notes d’affectation ou de nomination',
  obligatoire: true,
};
const EN_FOI_AUTORISATION =
  'En foi de quoi, la présente autorisation lui est délivrée pour servir et valoir ce que de droit.';
const REPRISE_APRES =
  'À l’issue de ce congé, {f:l’intéressé|l’intéressée} reprendra service et produira un certificat de reprise de service.';
/** Pièces communes des congés (n° 19 à 22). */
const PIECES_CONGE: PieceExigee[] = [
  DEMANDE,
  {
    libelle: 'Texte d’intégration ou d’engagement',
    obligatoire: true,
    aide: 'L’arrêté ou le décret d’intégration (fonctionnaire), ou le contrat d’engagement (contractuel).',
  },
  AFFECT_NOMINATION,
  { libelle: 'Certificat de prise de service', obligatoire: true },
  PRESENCE,
];
/** Soit-transmis (ou lettre de transmission) à la Fonction publique, signé au Cabinet. */
const LETTRE_FP = {
  entete: 'DGRHAS' as const,
  preambule: [],
  formule: null,
  forme: 'LETTRE' as const,
  ampliations: ['{f:Intéressé|Intéressée}', 'DGRHAS', 'Archives'],
};
const A_LA_FP = {
  destinataire: '{param:SOIT_TRANSMIS_DESTINATAIRE}',
  appel: '{param:SOIT_TRANSMIS_APPEL}',
};
const AU_BUDGET = {
  destinataire: '{param:SOIT_TRANSMIS_BUDGET_DESTINATAIRE}',
  appel: '{param:SOIT_TRANSMIS_BUDGET_APPEL}',
};
const SIGNE_CABINET = '{param:SIGNATAIRE_LISTE_TITRE}';
/** Colonnes des tableaux des modèles de la DGRHAS (transmissions de plusieurs demandes). */
const COLS_BASE: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const COLS_RECRUTEMENT: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'TEXTE_RECRUTEMENT',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const COLS_NOMINATION: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'NOTE_NOMINATION',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const COLS_PROMOTION: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'TEXTE_PROMOTION',
  'DATE_PRISE_SERVICE',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const COLS_STATUT: ColonneTransmission[] = [
  'GRADE',
  'FONCTION',
  'TEXTE_PROMOTION',
  'MATRICULE',
  'STRUCTURE',
  'DEPARTEMENT',
];
const PIECES_JOINTES =
  'Vous trouverez ci-joint les pièces du dossier, énumérées dans le tableau ci-dessous.';
const DDEPPSA_DU =
  'la Direction départementale de l’enseignement préscolaire, primaire, secondaire et de l’alphabétisation du département de';
/** Pièces des primes et indemnités (n° 46 à 53, à quelques variantes près). */
const PIECES_PRIME = (
  prise: PieceExigee,
  ...autres: PieceExigee[]
): PieceExigee[] => [
  DEMANDE,
  TEXTE_INTEGRATION_OU_ENGAGEMENT,
  AFFECT_NOMINATION,
  prise,
  PRESENCE,
  BULLETIN,
  ...autres,
];
/** Soit-transmis au Budget d'un dossier de prime : le texte ne change que par le nom de la prime. */
const SOIT_TRANSMIS_PRIME = (
  prime: string,
  suite = '',
  demande = `de mandatement de la ${prime}`,
  colonnes: ColonneTransmission[] = COLS_BASE,
) => ({
  ...LETTRE_FP,
  titre: 'Soit-transmis',
  lettre: {
    ...AU_BUDGET,
    objet: prime.charAt(0).toUpperCase() + prime.slice(1),
  },
  articles: [
    `J’ai l’honneur de vous transmettre, pour compétence, le dossier ${/^[aeiouéè]/i.test(prime) ? 'd’' : 'de '}${prime} de {agent}{enService}${suite}.`,
    PIECES_JOINTES,
  ],
  transmission: { demande, suite, colonnes },
});
const A_COMPTER_DU: ChampPrestation = {
  cle: 'dateDebut',
  libelle: 'À compter du (facultatif)',
  type: 'date',
};
const DATE_REPRISE: ChampPrestation = {
  cle: 'dateReprise',
  libelle: 'Date de reprise de service',
  type: 'date',
  obligatoire: true,
};

const CYCLES = [
  { valeur: 'PRESCOLAIRE', libelle: 'Préscolaire' },
  { valeur: 'PRIMAIRE', libelle: 'Primaire' },
  { valeur: 'COLLEGE', libelle: 'Collège' },
  { valeur: 'LYCEE', libelle: 'Lycée' },
  { valeur: 'ALPHABETISATION', libelle: 'Alphabétisation' },
  { valeur: 'ADMINISTRATION', libelle: 'Administration' },
];

export const PRESTATIONS: DefinitionPrestation[] = [
  {
    code: 'AFFECTATION_NATIONALE',
    numero: 1,
    libelle: 'Affectation nationale',
    famille: 'AFFECTATION',
    pourQui:
      'Un agent intégré à la Fonction publique qui demande au ministère de l’affecter dans un département.',
    acte: 'Note de service',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande d’affectation',
    champs: [
      {
        cle: 'departementId',
        libelle: 'Département souhaité',
        type: 'departement',
        obligatoire: true,
        aide: 'Le département scolaire où l’agent demande à servir.',
      },
      {
        cle: 'cycle',
        libelle: 'Cycle',
        type: 'liste',
        options: CYCLES,
        aide: 'Le cycle où il enseignera (ou « Administration » pour un poste de bureau).',
      },
      {
        cle: 'lieuSouhaite',
        libelle: 'Lieu souhaité (facultatif)',
        type: 'texte',
        exemple: 'Ex. une ville, un établissement',
      },
      // Le texte en trois champs, sans rien écrire à la main (DG, 03/11/2026)
      {
        cle: 'natureTexteIntegration',
        libelle: 'Texte d’intégration : nature',
        type: 'liste',
        options: [
          { valeur: 'ARRETE', libelle: 'Arrêté' },
          { valeur: 'DECRET', libelle: 'Décret' },
        ],
        aide: 'Arrêté (catégories II et III) ou décret (catégorie I).',
      },
      {
        cle: 'numeroTexteIntegration',
        libelle: 'Texte d’intégration : numéro',
        type: 'texte',
        exemple: 'Ex. 4717/MFPTSS/DGFP',
      },
      {
        cle: 'dateTexteIntegration',
        libelle: 'Texte d’intégration : date de signature',
        type: 'date',
      },
    ],
    pieces: [DEMANDE, INTEGRATION],
    acteModele: {
      ...NOTE_MINISTRE,
      titre: 'Note de service portant affectation',
      articles: [
        `{agent}{enService}, est {f:affecté|affectée} à la ${DDEPPSA_DE} {champ:departementId}[[ ({champ:cycle|min})]].`,
        'Le Directeur départemental lui assigne son poste[[, en tenant compte du lieu souhaité ({champ:lieuSouhaite})]].',
        EFFET,
      ],
    },
  },
  {
    code: 'AFFECTATION_DEPARTEMENTALE',
    numero: 2,
    libelle: 'Affectation départementale',
    famille: 'AFFECTATION',
    pourQui:
      'Un agent déjà affecté dans un département par le ministère, qui demande au directeur départemental son poste précis (école, inspection…).',
    acte: 'Note de service départementale',
    niveauDecision: 'DDEPPSA-Préfet',
    signataire: 'Le Préfet du département',
    objet: 'Demande d’affectation départementale',
    champs: [
      {
        cle: 'noteMinisterielle',
        libelle: 'Note d’affectation ou de mutation ministérielle (n° et date)',
        type: 'texte',
        obligatoire: true,
        aide: 'La note du ministère qui a envoyé l’agent dans ce département.',
        exemple: 'Ex. Note de service n° 0456/MEPPSA/CAB/DGRHAS du 05/09/2026',
      },
      {
        cle: 'lieuSouhaite',
        libelle: 'Établissement ou lieu souhaité',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. École primaire de …',
      },
      {
        cle: 'circonscription',
        libelle: 'Circonscription scolaire (inspection), si connue',
        type: 'texte',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      {
        libelle: 'Note d’affectation ou de mutation ministérielle',
        obligatoire: true,
      },
    ],
    acteModele: {
      entete: 'DDEPPSA',
      titre: 'Note de service départementale portant affectation',
      preambule: [
        'Vu la note d’affectation ou de mutation ministérielle ({champ:noteMinisterielle}) ;',
        VU_DEMANDE,
      ],
      formule: null,
      forme: 'ARTICLES',
      articles: [
        '{agent}{enService}, est {f:affecté|affectée} à {champ:lieuSouhaite}[[ (circonscription scolaire : {champ:circonscription})]][[, département de {agent.departement}]].',
        EFFET,
      ],
      ampliations: AMPLIATIONS,
    },
  },
  {
    code: 'ENROLEMENT_VOLONTAIRES',
    numero: 3,
    libelle: 'Affectation / enrôlement des enseignants volontaires',
    famille: 'AFFECTATION',
    pourQui:
      'Un diplômé d’une école de formation des enseignants qui demande à être enrôlé comme enseignant volontaire et affecté.',
    acte: 'Note de service',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande d’enrôlement comme enseignant volontaire',
    champs: [
      {
        cle: 'departementId',
        libelle: 'Département souhaité',
        type: 'departement',
        obligatoire: true,
      },
      {
        cle: 'cycle',
        libelle: 'Cycle',
        type: 'liste',
        options: CYCLES.filter((c) => c.valeur !== 'ADMINISTRATION'),
        obligatoire: true,
      },
      {
        cle: 'ecoleFormation',
        libelle: 'École de formation',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. ENI de Brazzaville',
      },
      {
        cle: 'diplome',
        libelle: 'Diplôme obtenu',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. CFEEN',
      },
    ],
    pieces: [
      DEMANDE,
      { libelle: 'Photocopie du diplôme légalisé', obligatoire: true },
      {
        libelle: 'Note d’admission au concours d’entrée à l’école de formation',
        obligatoire: true,
      },
      { libelle: 'Note de fin de formation', obligatoire: true },
      { libelle: 'Photocopie de l’acte de naissance', obligatoire: true },
      { libelle: 'Photocopie de la pièce d’identité', obligatoire: true },
    ],
    acteModele: {
      ...NOTE_MINISTRE,
      titre:
        'Note de service portant enrôlement et affectation d’un enseignant volontaire',
      articles: [
        '{agent}, titulaire du {champ:diplome}, {f:sorti|sortie} de {champ:ecoleFormation}, est {f:enrôlé|enrôlée} en qualité d’{f:enseignant volontaire|enseignante volontaire} du {champ:cycle|min}.',
        `{f:Il|Elle} est {f:mis|mise} à la disposition de la ${DDEPPSA_DE} {champ:departementId}, qui lui assigne son poste.`,
        EFFET,
      ],
    },
  },
  {
    code: 'NOMINATION_CHEFS',
    numero: 4,
    libelle:
      'Nomination des chefs de service, chefs de bureau, équipes de maîtrise',
    famille: 'NOMINATION',
    pourQui:
      'Un agent proposé à un poste de chef de service, de chef de bureau ou de membre d’une équipe de maîtrise (encadrement d’un service).',
    acte: 'Note de service',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande de nomination',
    champs: [
      {
        cle: 'poste',
        libelle: 'Poste sollicité',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'CHEF_SERVICE',
            libelle: 'Chef de service',
            acte: 'chef de service',
          },
          {
            valeur: 'CHEF_BUREAU',
            libelle: 'Chef de bureau',
            acte: 'chef de bureau',
          },
          {
            valeur: 'EQUIPE_MAITRISE',
            libelle: 'Membre d’une équipe de maîtrise',
            acte: 'membre de l’équipe de maîtrise',
          },
        ],
      },
      {
        cle: 'intitule',
        libelle: 'Service, bureau ou équipe concerné',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Service des examens et concours',
      },
      {
        cle: 'structure',
        libelle: 'Direction ou structure de rattachement',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. DDEPPSA de la Bouenza',
      },
    ],
    pieces: [
      DEMANDE,
      PRESENCE,
      PREMIERE_PRISE,
      INTEGRATION,
      {
        libelle: 'Certificat de prise ou de reprise de service',
        obligatoire: true,
      },
      BULLETIN,
      CV,
    ],
    acteModele: {
      ...NOTE_MINISTRE,
      titre: 'Note de service portant nomination',
      articles: [
        '{agent}{enService}, est {f:nommé|nommée} {acte:poste} : {champ:intitule}, {champ:structure}.',
        '{f:L’intéressé|L’intéressée} prend ses fonctions à compter de la date de signature de la présente note de service.',
      ],
    },
  },
  {
    code: 'NOMINATION_DIRECTEURS',
    numero: 5,
    libelle: 'Nomination des directeurs départementaux et centraux',
    famille: 'NOMINATION',
    pourQui:
      'Un agent proposé comme directeur départemental (DDEPPSA) ou directeur central. Le Premier ministre décide par décret : la DGRHAS prépare le projet de décret.',
    acte: 'Décret du Premier ministre',
    niveauDecision: 'Premier ministre',
    signataire: 'Le Premier ministre',
    objet: 'Proposition de nomination',
    champs: [
      {
        cle: 'poste',
        libelle: 'Poste',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'DIRECTEUR_DEPARTEMENTAL',
            libelle: 'Directeur départemental (DDEPPSA)',
            acte: 'directeur départemental|directrice départementale',
          },
          {
            valeur: 'DIRECTEUR_CENTRAL',
            libelle: 'Directeur central',
            acte: 'directeur central|directrice centrale',
          },
        ],
      },
      {
        cle: 'direction',
        libelle: 'Direction concernée',
        type: 'texte',
        obligatoire: true,
        aide: 'Pour un directeur départemental : le département. Pour un directeur central : le nom de la direction.',
        exemple: 'Ex. Direction départementale de la Likouala',
      },
    ],
    pieces: [
      DEMANDE,
      PRESENCE,
      PREMIERE_PRISE,
      INTEGRATION,
      { libelle: 'Certificat de reprise de service', obligatoire: true },
      BULLETIN,
      CV,
    ],
    acteModele: {
      entete: 'PRIMATURE',
      titre: 'Projet de décret portant nomination',
      preambule: [
        'Le Premier ministre, chef du Gouvernement, sur proposition du Ministre de l’Enseignement préscolaire, primaire, secondaire et de l’alphabétisation,',
      ],
      formule: 'DÉCRÈTE',
      forme: 'ARTICLES',
      articles: [
        '{agent}, est {f:nommé|nommée} {acte:poste} : {champ:direction}.',
        'Le présent décret sera enregistré et publié au Journal officiel de la République du Congo.',
      ],
      ampliations: [
        '{f:Intéressé|Intéressée}',
        'MEPPSA',
        'DGRHAS',
        'Journal officiel',
        'Archives',
      ],
    },
  },
  {
    code: 'RECTIFICATIF_NOTE',
    numero: 6,
    libelle: 'Rectificatif de note de service signée par le ministre',
    famille: 'RECTIFICATIF',
    pourQui:
      'Un agent dont le nom, le grade, le poste… est mal écrit dans une note de service déjà signée par le ministre : la DGRHAS prend une note rectificative.',
    acte: 'Note rectificative',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de rectificatif de note de service',
    champs: [
      {
        cle: 'noteACorriger',
        libelle: 'Note de service à corriger (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. n° 0456/MEPPSA/CAB/DGRHAS du 05/09/2026',
      },
      {
        cle: 'auLieuDe',
        libelle: 'Ce qui est écrit dans la note (l’erreur)',
        type: 'zone',
        obligatoire: true,
        exemple: 'Ex. MABIALA Jean, instituteur',
      },
      {
        cle: 'lire',
        libelle: 'Ce qu’il faut lire',
        type: 'zone',
        obligatoire: true,
        exemple: 'Ex. MABIALA Jean-Pierre, instituteur principal',
      },
    ],
    pieces: [
      DEMANDE,
      { libelle: 'Note de service à corriger', obligatoire: true },
      {
        libelle: 'Pièces justifiant la correction',
        obligatoire: true,
        aide: 'Acte de naissance, texte de promotion… ce qui prouve la bonne écriture.',
      },
    ],
    acteModele: {
      ...NOTE_MINISTRE,
      titre: 'Note de service rectificative',
      preambule: ['Vu la note de service {champ:noteACorriger} ;', VU_DEMANDE],
      articles: [
        'La note de service {champ:noteACorriger} est rectifiée ainsi qu’il suit, en ce qui concerne {agent} : au lieu de « {champ:auLieuDe} », lire « {champ:lire} ».',
        'Le reste sans changement.',
      ],
    },
  },
  {
    code: 'CERTIFICAT_PRISE_SERVICE',
    numero: 7,
    libelle: 'Certificat de prise de service',
    famille: 'CERTIFICAT',
    pourQui:
      'Un agent qui vient d’arriver à son poste (première affectation ou mutation) : son chef de service certifie la date à laquelle il a pris service.',
    acte: 'Certificat',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de certificat de prise de service',
    champs: [
      {
        cle: 'datePriseService',
        libelle: 'Date de prise de service',
        type: 'date',
        obligatoire: true,
        aide: 'Le jour où l’agent s’est présenté et a commencé à travailler.',
      },
      {
        cle: 'noteAffectation',
        libelle: 'Note d’affectation (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. n° 0456/MEPPSA/CAB/DGRHAS du 05/09/2026',
      },
    ],
    pieces: [DEMANDE, TEXTE_INTEGRATION_OU_ENGAGEMENT, AFFECTATIONS],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Certificat de prise de service',
      articles: [
        `${JE_SOUSSIGNE} certifie que {agent}, {f:affecté|affectée} par la note {champ:noteAffectation}, a pris service à {decideur.nom} le {champ:datePriseService}.`,
        EN_FOI_CERTIFICAT,
      ],
    },
  },
  {
    code: 'CERTIFICAT_REPRISE',
    numero: 8,
    libelle: 'Certificat de reprise de service',
    famille: 'CERTIFICAT',
    pourQui:
      'Un agent qui reprend son travail après une interruption : son chef de service certifie la date de la reprise.',
    acte: 'Certificat',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de certificat de reprise de service',
    champs: [
      DATE_REPRISE,
      {
        cle: 'motifInterruption',
        libelle: 'Après quoi ? (facultatif)',
        type: 'texte',
        exemple: 'Ex. une suspension',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECTATIONS,
      { libelle: 'Note de prise de service', obligatoire: true },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Certificat de reprise de service',
      articles: [
        `${JE_SOUSSIGNE} certifie que {agent}, a repris service à {decideur.nom} le {champ:dateReprise}[[, après {champ:motifInterruption}]].`,
        EN_FOI_CERTIFICAT,
      ],
    },
  },
  {
    code: 'REPRISE_CONGE',
    numero: 9,
    libelle: 'Certificat de reprise de service, de retour de congé',
    famille: 'CERTIFICAT',
    pourQui:
      'Un agent qui revient d’un congé (administratif, de maladie, de maternité…) : son chef de service certifie qu’il a repris le travail.',
    acte: 'Certificat',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de certificat de reprise de service après congé',
    ordreDates: [
      { avant: 'dateDebutConge', apres: 'dateFinConge' },
      { avant: 'dateFinConge', apres: 'dateReprise' },
    ],
    champs: [
      {
        cle: 'typeConge',
        libelle: 'Congé',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'ADMINISTRATIF',
            libelle: 'Congé administratif',
            acte: 'congé administratif',
          },
          {
            valeur: 'MALADIE',
            libelle: 'Congé de maladie',
            acte: 'congé de maladie',
          },
          {
            valeur: 'LONGUE_MALADIE',
            libelle: 'Congé de longue maladie',
            acte: 'congé de longue maladie',
          },
          {
            valeur: 'MATERNITE',
            libelle: 'Congé de maternité',
            acte: 'congé de maternité',
          },
          {
            valeur: 'PATERNITE',
            libelle: 'Congé de paternité',
            acte: 'congé de paternité',
          },
          { valeur: 'AUTRE', libelle: 'Autre congé', acte: 'congé' },
        ],
      },
      {
        cle: 'dateDebutConge',
        libelle: 'Début du congé',
        type: 'date',
        obligatoire: true,
      },
      {
        cle: 'dateFinConge',
        libelle: 'Fin du congé',
        type: 'date',
        obligatoire: true,
      },
      DATE_REPRISE,
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECTATIONS,
      PRISE,
      { libelle: 'Attestation de congé', obligatoire: true },
      { libelle: 'Certificat de cessation de service', obligatoire: true },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Certificat de reprise de service',
      articles: [
        `${JE_SOUSSIGNE} certifie que {agent}, en {acte:typeConge} du {champ:dateDebutConge} au {champ:dateFinConge}, a repris service à {decideur.nom} le {champ:dateReprise}.`,
        EN_FOI_CERTIFICAT,
      ],
    },
  },
  {
    code: 'REPRISE_STAGE',
    numero: 10,
    libelle: 'Certificat de reprise de service, de retour de stage',
    famille: 'CERTIFICAT',
    pourQui:
      'Un agent qui revient d’un stage ou d’une formation : son chef de service certifie qu’il a repris le travail.',
    acte: 'Certificat',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de certificat de reprise de service après stage',
    champs: [
      {
        cle: 'ecoleStage',
        libelle: 'École ou centre du stage',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. ENS de Brazzaville',
      },
      {
        cle: 'diplome',
        libelle: 'Diplôme ou attestation obtenu (facultatif)',
        type: 'texte',
        exemple: 'Ex. CAPES',
      },
      DATE_REPRISE,
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECTATIONS,
      PRISE,
      {
        libelle: 'Attestation de fin de formation ou diplôme légalisé',
        obligatoire: true,
      },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Certificat de reprise de service',
      articles: [
        `${JE_SOUSSIGNE} certifie que {agent}, de retour de stage ({champ:ecoleStage}[[, diplôme obtenu : {champ:diplome}]]), a repris service à {decideur.nom} le {champ:dateReprise}.`,
        EN_FOI_CERTIFICAT,
      ],
    },
  },
  {
    code: 'REPRISE_DESERTION',
    numero: 11,
    libelle:
      'Certificat de reprise de service à l’issue d’une désertion ou d’un abandon de poste',
    famille: 'CERTIFICAT',
    pourQui:
      'Un agent qui avait quitté son poste sans autorisation (désertion, abandon de poste) et qui revient : son chef de service certifie la reprise.',
    acte: 'Certificat',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de certificat de reprise de service',
    ordreDates: [{ avant: 'dateAbandon', apres: 'dateReprise' }],
    champs: [
      {
        cle: 'dateAbandon',
        libelle: 'Date de l’abandon de poste',
        type: 'date',
        obligatoire: true,
      },
      DATE_REPRISE,
      {
        cle: 'noteReutilisation',
        libelle:
          'Note de réutilisation, si le salaire a été suspendu (n° et date)',
        type: 'texte',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECTATIONS,
      {
        libelle:
          'Certificat de prise de service avant la désertion ou l’abandon de poste',
        obligatoire: true,
      },
      {
        libelle:
          'Attestation de présence au poste avant la désertion ou l’abandon de poste',
        obligatoire: true,
      },
      {
        libelle: 'Note de réutilisation en cas de suspension de salaire',
        aide: 'Seulement si le salaire a été suspendu.',
      },
      {
        libelle: 'Pièces justifiant la désertion ou l’abandon',
        obligatoire: true,
      },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Certificat de reprise de service',
      articles: [
        `${JE_SOUSSIGNE} certifie que {agent}, absent{f:|e} de son poste depuis le {champ:dateAbandon}, a repris service à {decideur.nom} le {champ:dateReprise}[[, en application de la note de réutilisation {champ:noteReutilisation}]].`,
        EN_FOI_CERTIFICAT,
      ],
    },
  },
  {
    code: 'ATTESTATION_PRESENCE',
    numero: 12,
    libelle: 'Attestation de présence au poste',
    famille: 'ATTESTATION',
    pourQui:
      'Un agent qui doit prouver qu’il est bien à son poste (dossier de carrière, bourse, banque…) : son chef de service l’atteste.',
    acte: 'Attestation',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande d’attestation de présence au poste',
    champs: [
      {
        cle: 'anneeScolaire',
        libelle: 'Année scolaire (facultatif)',
        type: 'texte',
        exemple: 'Ex. 2026-2027',
      },
    ],
    pieces: [
      DEMANDE,
      {
        libelle: 'Texte d’intégration ou d’engagement à la Fonction publique',
        obligatoire: true,
      },
      NOTE_MIN,
      NOTE_DEP,
      {
        libelle: 'Certificat de prise de service ou de reprise de service',
        obligatoire: true,
      },
      { libelle: 'Un bulletin récent (facultatif)' },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Attestation de présence au poste',
      articles: [
        `${JE_SOUSSIGNE} atteste que {agent}, est {f:présent|présente} à son poste et exerce effectivement ses fonctions à {decideur.nom}[[ au titre de l’année scolaire {champ:anneeScolaire}]].`,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'PRESENCE_STAGE',
    numero: 13,
    libelle:
      'Attestation de présence au poste pour les agents en stage ou en instance de réutilisation',
    famille: 'ATTESTATION',
    pourQui:
      'Un agent qui n’est pas à un poste parce qu’il est en stage, ou en attente d’être réutilisé (« en instance de réutilisation ») : la DGRHAS atteste qu’il reste un agent du ministère.',
    acte: 'Attestation',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande d’attestation de présence au poste',
    champs: [
      {
        cle: 'situation',
        libelle: 'Situation',
        type: 'liste',
        obligatoire: true,
        options: [
          { valeur: 'STAGE', libelle: 'En stage', acte: 'en stage' },
          {
            valeur: 'INSTANCE',
            libelle: 'En instance de réutilisation',
            acte: 'en instance de réutilisation',
          },
        ],
        aide: '« En instance de réutilisation » : l’agent attend une nouvelle affectation (après un stage, un détachement…).',
      },
      {
        cle: 'lieuStage',
        libelle: 'Lieu du stage (si en stage)',
        type: 'texte',
        exemple: 'Ex. ENS de Brazzaville',
      },
      {
        cle: 'texteSituation',
        libelle: 'Texte de mise en stage ou de mise en instance (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Arrêté n° 1234 du 12/03/2025',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      NOTE_MIN,
      NOTE_DEP,
      PRISE,
      { libelle: 'Un bulletin récent', obligatoire: true },
      {
        libelle: 'Pièces justifiant la mise en stage ou la réutilisation',
        obligatoire: true,
      },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Attestation de présence au poste',
      articles: [
        `${LE_DG} atteste que {agent}, est {acte:situation}[[ à {champ:lieuStage}]] en application du texte {champ:texteSituation}, et demeure {f:inscrit|inscrite} aux effectifs du Ministère de l’Enseignement préscolaire, primaire, secondaire et de l’alphabétisation.`,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'ATTESTATION_EMPLOYEUR',
    numero: 14,
    libelle: 'Attestation de l’employeur',
    famille: 'ATTESTATION',
    pourQui:
      'Un agent qui doit prouver qu’il travaille pour le ministère (banque, bailleur, consulat…) : la DGRHAS, son employeur, l’atteste.',
    acte: 'Attestation',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande d’attestation de l’employeur',
    champs: [
      {
        cle: 'datePremierePrise',
        libelle: 'Date de première prise de service (facultatif)',
        type: 'date',
      },
      {
        cle: 'destination',
        libelle: 'À remettre à (facultatif)',
        type: 'texte',
        exemple: 'Ex. une banque',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      PREMIERE_PRISE,
      PRESENCE,
      { libelle: 'Un bulletin récent', obligatoire: true },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Attestation de l’employeur',
      articles: [
        `${LE_DG} atteste que {agent}{enService}, est {f:employé|employée} par le Ministère de l’Enseignement préscolaire, primaire, secondaire et de l’alphabétisation[[ depuis le {champ:datePremierePrise}]].`,
        '[[La présente attestation est établie à la demande de {f:l’intéressé|l’intéressée}, pour être remise à {champ:destination}.]]',
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'CONGE_LONGUE_MALADIE',
    numero: 15,
    libelle: 'Attestation de congé de longue maladie',
    famille: 'ATTESTATION',
    pourQui:
      'Un agent gravement malade qui doit s’arrêter longtemps : le ministre lui accorde un congé de longue maladie, sur dossier médical.',
    acte: 'Attestation',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande de congé de longue maladie',
    champs: [
      {
        cle: 'dateDebut',
        libelle: 'À compter du',
        type: 'date',
        obligatoire: true,
      },
      {
        cle: 'duree',
        libelle: 'Durée demandée',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. six (6) mois',
        aide: 'Celle que propose le dossier médical.',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      NOTE_MIN,
      NOTE_DEP,
      PRISE,
      PRESENCE,
      {
        libelle: 'Dossier médical',
        obligatoire: true,
        aide: 'Sous pli fermé si besoin : il n’est vu que par ceux qui traitent la demande.',
      },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Attestation de congé de longue maladie',
      articles: [
        'Le Ministre de l’Enseignement préscolaire, primaire, secondaire et de l’alphabétisation atteste qu’un congé de longue maladie de {champ:duree} est accordé à {agent}{enService}, à compter du {champ:dateDebut}, au vu du dossier médical.',
        'À l’issue de ce congé, {f:l’intéressé|l’intéressée} produira un certificat de reprise de service.',
        EN_FOI_ATTESTATION,
      ],
      ampliations: AMPLIATIONS,
    },
  },
  {
    code: 'AUTORISATION_ABSENCE',
    numero: 16,
    libelle: 'Autorisation d’absence',
    famille: 'AUTORISATION',
    pourQui:
      'Un agent qui doit s’absenter quelques jours (raison familiale, santé, démarche…) : son chef de service l’autorise.',
    acte: 'Autorisation',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande d’autorisation d’absence',
    ordreDates: PERIODE,
    champs: [
      DEBUT,
      FIN,
      {
        cle: 'motif',
        libelle: 'Motif',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Obsèques d’un parent',
      },
    ],
    pieces: [DEMANDE],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Autorisation d’absence',
      articles: [
        `${JE_SOUSSIGNE} autorise {agent}, à s’absenter de son poste du {champ:dateDebut} au {champ:dateFin} inclus, pour le motif suivant : {champ:motif}.`,
        EN_FOI_AUTORISATION,
      ],
    },
  },
  {
    code: 'ABSENCE_ETRANGER',
    numero: 17,
    libelle: 'Autorisation d’absence pour voyage à l’étranger',
    famille: 'AUTORISATION',
    pourQui:
      'Un agent qui doit sortir du pays (soins, famille, mission personnelle…) : le ministre l’autorise, après avis de toute la hiérarchie.',
    acte: 'Autorisation',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande d’autorisation d’absence pour voyage à l’étranger',
    ordreDates: PERIODE,
    champs: [
      {
        cle: 'pays',
        libelle: 'Pays de destination',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Cameroun',
      },
      {
        cle: 'motif',
        libelle: 'Motif du voyage',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Soins médicaux',
      },
      DEBUT,
      FIN,
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      PREMIERE_PRISE,
      PRESENCE,
      { libelle: 'Un bulletin récent', obligatoire: true },
      {
        libelle: 'Pièces justifiant le voyage à l’étranger',
        obligatoire: true,
        aide: 'Invitation, rendez-vous médical, convocation…',
      },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Autorisation d’absence pour voyage à l’étranger',
      articles: [
        'Le Ministre de l’Enseignement préscolaire, primaire, secondaire et de l’alphabétisation autorise {agent}{enService}, à se rendre à l’étranger ({champ:pays}) du {champ:dateDebut} au {champ:dateFin} inclus, pour le motif suivant : {champ:motif}.',
        'À son retour, {f:l’intéressé|l’intéressée} reprendra service et produira un certificat de reprise de service.',
        EN_FOI_AUTORISATION,
      ],
      ampliations: AMPLIATIONS,
    },
  },
  {
    code: 'AUTORISATION_TUTELLE',
    numero: 18,
    libelle:
      'Autorisation de la tutelle (pour un concours ou un stage de formation)',
    famille: 'AUTORISATION',
    pourQui:
      'Un agent qui veut présenter un concours ou suivre un stage de formation : le ministère, son employeur (« la tutelle »), l’y autorise.',
    acte: 'Autorisation de la tutelle',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande d’autorisation de la tutelle',
    champs: [
      {
        cle: 'pourQuoi',
        libelle: 'Pour',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'CONCOURS',
            libelle: 'Présenter un concours',
            acte: 'à présenter le concours',
          },
          {
            valeur: 'STAGE',
            libelle: 'Suivre un stage de formation',
            acte: 'à suivre la formation',
          },
        ],
      },
      {
        cle: 'intitule',
        libelle: 'Concours ou formation',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. d’entrée à l’ENS, section lettres modernes',
      },
      {
        cle: 'ecole',
        libelle: 'École ou centre de formation',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. École normale supérieure de Brazzaville',
      },
      {
        cle: 'session',
        libelle: 'Session ou année (facultatif)',
        type: 'texte',
        exemple: 'Ex. 2027',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      { libelle: 'Texte de dernière promotion', obligatoire: true },
      { libelle: 'Première prise de service', obligatoire: true },
      {
        libelle: 'Note d’affectation ou de mutation dans le département',
        obligatoire: true,
      },
      {
        libelle: 'Trois copies de bulletins de solde récents',
        obligatoire: true,
      },
      PRISE,
      PRESENCE,
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Autorisation de la tutelle',
      articles: [
        `${LE_DG} autorise {agent}{enService}, {acte:pourQuoi} {champ:intitule} ({champ:ecole})[[, session {champ:session}]].`,
        'En cas d’admission, la mise en stage fera l’objet d’un acte distinct ; jusque-là, {f:l’intéressé|l’intéressée} demeure à son poste.',
        EN_FOI_AUTORISATION,
      ],
    },
  },
  {
    code: 'CONGE_ADMINISTRATIF',
    numero: 19,
    libelle: 'Congé administratif',
    famille: 'CONGE',
    pourQui:
      'Un agent qui prend son congé annuel (« congé administratif ») : son chef de service l’accorde et atteste les dates.',
    acte: 'Attestation',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de congé administratif',
    ordreDates: PERIODE,
    champs: [
      {
        cle: 'annee',
        libelle: 'Au titre de l’année (facultatif)',
        type: 'texte',
        exemple: 'Ex. 2025-2026',
      },
      DEBUT,
      FIN,
      {
        cle: 'lieuConge',
        libelle: 'Lieu où l’agent passera son congé (facultatif)',
        type: 'texte',
        exemple: 'Ex. Pointe-Noire',
      },
    ],
    pieces: PIECES_CONGE,
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Attestation de congé administratif',
      articles: [
        `${JE_SOUSSIGNE} atteste qu’un congé administratif[[ au titre de l’année {champ:annee}]] est accordé à {agent}, du {champ:dateDebut} au {champ:dateFin} inclus[[, à passer à {champ:lieuConge}]].`,
        REPRISE_APRES,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'CONGE_MALADIE',
    numero: 20,
    libelle: 'Congé de maladie',
    famille: 'CONGE',
    pourQui:
      'Un agent malade qui doit s’arrêter, sur avis d’un médecin : son chef de service accorde le congé de maladie.',
    acte: 'Attestation',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de congé de maladie',
    ordreDates: PERIODE,
    champs: [DEBUT, FIN],
    pieces: [
      ...PIECES_CONGE,
      BULLETIN,
      {
        libelle: 'Dossier médical',
        obligatoire: true,
        aide: 'Le certificat médical qui prescrit l’arrêt.',
      },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Attestation de congé de maladie',
      articles: [
        `${JE_SOUSSIGNE} atteste qu’un congé de maladie est accordé à {agent}, du {champ:dateDebut} au {champ:dateFin} inclus, au vu du dossier médical.`,
        REPRISE_APRES,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'CONGE_MATERNITE',
    numero: 21,
    libelle: 'Congé de maternité',
    famille: 'CONGE',
    pour: 'F',
    pourQui:
      'Une agente enceinte, avant et après l’accouchement : son chef de service accorde le congé de maternité.',
    acte: 'Attestation',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de congé de maternité',
    ordreDates: PERIODE,
    champs: [
      {
        cle: 'dateAccouchement',
        libelle: 'Date prévue de l’accouchement',
        type: 'date',
        obligatoire: true,
        aide: 'Celle du certificat de grossesse.',
      },
      DEBUT,
      FIN,
    ],
    pieces: [
      ...PIECES_CONGE,
      { libelle: 'Certificat de grossesse', obligatoire: true },
      { libelle: 'Fiche de pesée', obligatoire: true },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Attestation de congé de maternité',
      articles: [
        `${JE_SOUSSIGNE} atteste qu’un congé de maternité est accordé à {agent}, du {champ:dateDebut} au {champ:dateFin} inclus (accouchement prévu le {champ:dateAccouchement}).`,
        REPRISE_APRES,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'CONGE_PATERNITE',
    numero: 22,
    libelle: 'Congé de paternité',
    famille: 'CONGE',
    pour: 'M',
    pourQui:
      'Un agent dont l’enfant vient de naître : son chef de service accorde le congé de paternité.',
    acte: 'Attestation',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de congé de paternité',
    ordreDates: [...PERIODE, { avant: 'dateNaissance', apres: 'dateFin' }],
    champs: [
      {
        cle: 'dateNaissance',
        libelle: 'Date de naissance de l’enfant',
        type: 'date',
        obligatoire: true,
      },
      DEBUT,
      FIN,
    ],
    pieces: [
      ...PIECES_CONGE,
      { libelle: 'Déclaration de naissance', obligatoire: true },
    ],
    acteModele: {
      ...CERTIFICAT_LIEU,
      titre: 'Attestation de congé de paternité',
      articles: [
        `${JE_SOUSSIGNE} atteste qu’un congé de paternité est accordé à {agent}, du {champ:dateDebut} au {champ:dateFin} inclus, à l’occasion de la naissance de son enfant le {champ:dateNaissance}.`,
        REPRISE_APRES,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'CONGE_EXPECTATIVE',
    numero: 24,
    libelle:
      'Congé d’expectative après un détachement ou un préavis de départ à la retraite',
    famille: 'CONGE',
    pourQui:
      'Un agent qui n’a plus de poste en attendant la suite (« expectative ») : à la fin d’un détachement, en attendant d’être réintégré, ou après son préavis de retraite, en attendant son départ.',
    acte: 'Attestation',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de congé d’expectative',
    ordreDates: [{ avant: 'dateDebut', apres: 'dateFin' }],
    champs: [
      {
        cle: 'motif',
        libelle: 'Après',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'DETACHEMENT',
            libelle: 'Un détachement',
            acte: 'à l’issue de son détachement',
          },
          {
            valeur: 'RETRAITE',
            libelle: 'Un préavis de départ à la retraite',
            acte: 'dans l’attente de son départ à la retraite',
          },
        ],
      },
      {
        cle: 'texteJustificatif',
        libelle: 'Note de détachement ou lettre de préavis (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Lettre de préavis n° 123 du 02/01/2026',
      },
      { ...DEBUT, libelle: 'À compter du' },
      { ...FIN, libelle: 'Jusqu’au (facultatif)', obligatoire: false },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECT_NOMINATION,
      PRISE,
      PRESENCE,
      BULLETIN,
      {
        libelle: 'Note justifiant le détachement ou lettre de préavis',
        obligatoire: true,
      },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Attestation de congé d’expectative',
      articles: [
        `${LE_DG} atteste qu’un congé d’expectative est accordé à {agent}{enService}, {acte:motif} ({champ:texteJustificatif}), à compter du {champ:dateDebut}[[ jusqu’au {champ:dateFin}]].`,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'CESSATION_SERVICE',
    numero: 25,
    libelle: 'Cessation de service',
    famille: 'CESSATION',
    pourQui:
      'Un agent qui quitte son poste (départ en stage, mutation, détachement…) : son chef de service constate la date à laquelle il cesse d’y travailler.',
    acte: 'Note de service',
    niveauDecision: 'Lieu de service',
    signataire: SIGNE_LIEU,
    objet: 'Demande de cessation de service',
    champs: [
      {
        cle: 'dateCessation',
        libelle: 'Date de cessation de service',
        type: 'date',
        obligatoire: true,
      },
      {
        cle: 'motif',
        libelle: 'Motif',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'STAGE',
            libelle: 'Départ en stage',
            acte: 'départ en stage',
          },
          { valeur: 'MUTATION', libelle: 'Mutation', acte: 'mutation' },
          {
            valeur: 'DETACHEMENT',
            libelle: 'Détachement',
            acte: 'détachement',
          },
          {
            valeur: 'DISPONIBILITE',
            libelle: 'Mise en disponibilité',
            acte: 'mise en disponibilité',
          },
          { valeur: 'AUTRE', libelle: 'Autre motif', acte: 'convenance' },
        ],
      },
      {
        cle: 'texteMotif',
        libelle: 'Texte qui justifie la cessation (n° et date, facultatif)',
        type: 'texte',
        exemple: 'Ex. Note de mutation n° 0456 du 05/09/2026',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECT_NOMINATION,
      PRISE,
      PRESENCE,
      { libelle: 'Pièces justifiant la cessation', obligatoire: true },
    ],
    acteModele: {
      entete: 'STRUCTURE',
      titre: 'Note de service portant cessation de service',
      preambule: [VU_DEMANDE],
      formule: null,
      forme: 'ARTICLES',
      articles: [
        '{agent}, en service à {decideur.nom}, cesse ses fonctions le {champ:dateCessation}, pour motif de {acte:motif}[[ ({champ:texteMotif})]].',
        'La présente note de service tient lieu de certificat de cessation de service.',
      ],
      ampliations: CERTIFICAT_LIEU.ampliations,
    },
  },
  {
    code: 'CESSATION_RETRAITE',
    numero: 26,
    libelle: 'Cessation d’activités (pour la retraite)',
    famille: 'CESSATION',
    pourQui:
      'Un agent qui part à la retraite : la DGRHAS certifie la date à laquelle il cesse ses activités.',
    acte: 'Certificat',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de certificat de cessation d’activités',
    champs: [
      {
        cle: 'dateCessation',
        libelle: 'Date de cessation d’activités',
        type: 'date',
        obligatoire: true,
      },
      {
        cle: 'lettrePreavis',
        libelle: 'Lettre de préavis (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. n° 123 du 02/01/2026',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECT_NOMINATION,
      PRISE,
      PRESENCE,
      { libelle: 'Lettre de préavis', obligatoire: true },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Certificat de cessation d’activités',
      articles: [
        `${LE_DG} certifie que {agent}{enService}, {f:admis|admise} à faire valoir ses droits à la retraite (lettre de préavis {champ:lettrePreavis}), cesse ses activités le {champ:dateCessation}.`,
        EN_FOI_CERTIFICAT,
      ],
    },
  },
  {
    code: 'DETACHEMENT',
    numero: 33,
    libelle: 'Détachement de l’enseignant actif',
    famille: 'POSITION',
    pourQui:
      'Un enseignant en activité appelé à travailler pour un autre employeur (autre ministère, organisme, projet…) : il est « détaché », c’est-à-dire qu’il quitte son poste tout en restant agent du ministère.',
    acte: 'Note de service',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande de détachement',
    champs: [
      {
        cle: 'organisme',
        libelle: 'Administration ou organisme d’accueil',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Ministère de la Santé',
      },
      {
        cle: 'fonction',
        libelle: 'Fonction à y occuper (facultatif)',
        type: 'texte',
        exemple: 'Ex. chargé d’études',
      },
      {
        cle: 'duree',
        libelle: 'Durée (facultatif)',
        type: 'texte',
        exemple: 'Ex. deux (2) ans renouvelables',
      },
    ],
    pieces: [
      DEMANDE,
      PRESENCE,
      {
        libelle: 'Texte d’intégration ou d’engagement à la Fonction publique',
        obligatoire: true,
      },
      {
        libelle:
          'Certificat de prise ou reprise de service de l’année en cours',
        obligatoire: true,
      },
      AFFECTATIONS,
      BULLETIN,
      {
        libelle: 'Pièces justifiant le besoin de détachement',
        obligatoire: true,
        aide: 'La lettre de l’organisme d’accueil qui demande l’agent.',
      },
    ],
    acteModele: {
      ...NOTE_MINISTRE,
      titre: 'Note de service portant détachement',
      articles: [
        '{agent}{enService}, est {f:détaché|détachée} auprès de {champ:organisme}[[ pour y exercer les fonctions de {champ:fonction}]][[, pour une durée de {champ:duree}]].',
        EFFET,
      ],
    },
  },
  {
    code: 'REUTILISATION_FORMATION',
    numero: 34,
    libelle: 'Réutilisation après formation',
    famille: 'POSITION',
    pourQui:
      'Un agent qui revient d’une formation (école, stage) et demande un nouveau poste : on dit qu’il est « réutilisé ». Il propose trois départements.',
    acte: 'Note de service',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande de réutilisation après formation',
    champs: [
      {
        cle: 'diplome',
        libelle: 'Diplôme obtenu',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. CAPES',
      },
      {
        cle: 'ecole',
        libelle: 'École de formation',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. ENS de Brazzaville',
      },
      {
        cle: 'departement1',
        libelle: '1er département souhaité',
        type: 'departement',
        obligatoire: true,
        aide: 'La note affecte l’agent dans ce département.',
      },
      {
        cle: 'departement2',
        libelle: '2e département souhaité',
        type: 'departement',
        obligatoire: true,
      },
      {
        cle: 'departement3',
        libelle: '3e département souhaité',
        type: 'departement',
        obligatoire: true,
      },
    ],
    pieces: [
      {
        ...DEMANDE,
        libelle:
          'Demande manuscrite et formulaire de demande avec trois départements au choix',
      },
      {
        libelle: 'Attestation de présence au poste après la formation',
        obligatoire: true,
      },
      INTEGRATION,
      PRISE,
      {
        libelle: 'Arrêté de mise en stage ou autorisation de concourir',
        obligatoire: true,
      },
      BULLETIN,
      {
        libelle: 'Certificat de cessation de service avant la formation',
        obligatoire: true,
      },
      { libelle: 'Note d’admission au concours', obligatoire: true },
      {
        libelle:
          'Attestation de fin de formation légalisée de l’école ou diplôme légalisé',
        obligatoire: true,
      },
      {
        libelle: 'Certificat de reprise de service après la formation',
        obligatoire: true,
      },
    ],
    acteModele: {
      ...NOTE_MINISTRE,
      titre: 'Note de service portant réutilisation',
      articles: [
        `{agent}, titulaire du {champ:diplome} obtenu à {champ:ecole}, est {f:réutilisé|réutilisée} et {f:mis|mise} à la disposition de ${DDEPPSA_DU} {champ:departement1}.`,
        'Le Directeur départemental lui assigne son poste.',
        EFFET,
      ],
    },
  },
  {
    code: 'REUTILISATION_RELEVE',
    numero: 35,
    libelle:
      'Réutilisation d’un agent relevé de ses fonctions ou remis à la disposition du MEPPSA',
    famille: 'POSITION',
    pourQui:
      'Un agent qui a perdu son poste de responsabilité (« relevé de ses fonctions ») ou qu’une autre administration rend au ministère (« remis à la disposition du MEPPSA ») : il demande un nouveau poste.',
    acte: 'Note de service',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande de réutilisation',
    champs: [
      {
        cle: 'situation',
        libelle: 'Situation',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'RELEVE',
            libelle: 'Relevé de ses fonctions',
            acte: 'relevé de ses fonctions|relevée de ses fonctions',
          },
          {
            valeur: 'REMIS',
            libelle: 'Remis à la disposition du MEPPSA',
            acte: 'remis à la disposition du MEPPSA|remise à la disposition du MEPPSA',
          },
        ],
      },
      {
        cle: 'noteSituation',
        libelle:
          'Note de service qui l’a relevé ou remis à disposition (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. n° 0456/MEPPSA/CAB du 05/09/2026',
      },
      {
        cle: 'dernierPoste',
        libelle: 'Dernier poste occupé',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Directeur du CEG de …',
      },
      {
        cle: 'departementId',
        libelle: 'Département souhaité',
        type: 'departement',
        obligatoire: true,
      },
    ],
    pieces: [
      DEMANDE,
      PRESENCE,
      INTEGRATION,
      { libelle: 'Note de nomination ou de détachement', obligatoire: true },
      {
        libelle:
          'Certificat de prise de service après nomination ou détachement',
        obligatoire: true,
      },
      {
        libelle:
          'Note de service relevant l’agent de ses fonctions ou le remettant à la disposition du MEPPSA',
        obligatoire: true,
      },
      {
        libelle: 'Certificat de cessation de service au dernier poste',
        obligatoire: true,
      },
      BULLETIN,
    ],
    acteModele: {
      ...NOTE_MINISTRE,
      titre: 'Note de service portant réutilisation',
      articles: [
        `{agent}, {acte:situation} par la note de service {champ:noteSituation} (dernier poste : {champ:dernierPoste}), est {f:réutilisé|réutilisée} et {f:mis|mise} à la disposition de ${DDEPPSA_DU} {champ:departementId}.`,
        'Le Directeur départemental lui assigne son poste.',
        EFFET,
      ],
    },
  },
  {
    code: 'REMISE_DISPOSITION_FP',
    numero: 36,
    libelle: 'Remise à la disposition de la Fonction publique',
    famille: 'POSITION',
    pourQui:
      'Un agent que le ministère rend à la Fonction publique (qui pourra le placer dans une autre administration).',
    acte: 'Note de service',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande de remise à la disposition de la Fonction publique',
    champs: [
      {
        cle: 'motif',
        libelle: 'Motif',
        type: 'zone',
        obligatoire: true,
        exemple: 'Ex. reconversion dans l’administration générale',
      },
    ],
    pieces: [
      DEMANDE,
      PRESENCE,
      PREMIERE_PRISE,
      INTEGRATION,
      { libelle: 'Arrêté de dernière promotion', obligatoire: true },
      {
        libelle: 'Pièces pouvant justifier la remise à la Fonction publique',
        obligatoire: true,
      },
      AFFECTATIONS,
      BULLETIN,
    ],
    acteModele: {
      ...NOTE_MINISTRE,
      titre:
        'Note de service portant remise à la disposition de la Fonction publique',
      articles: [
        '{agent}{enService}, est {f:remis|remise} à la disposition du Ministère de la Fonction publique, pour le motif suivant : {champ:motif}.',
        EFFET,
      ],
    },
  },
  {
    code: 'CHANGEMENT_STATUT',
    numero: 37,
    libelle: 'Changement de statut contractuel / fonctionnaire',
    famille: 'CARRIERE',
    pourQui:
      'Un agent contractuel qui demande à devenir fonctionnaire : la DGRHAS transmet le projet de texte à la Fonction publique, qui décide.',
    acte: 'Soit-transmis du projet de texte à la Fonction publique',
    niveauDecision: 'DGRHAS',
    signataire: SIGNE_CABINET,
    objet: 'Demande de changement de statut',
    champs: [
      {
        cle: 'texteEngagement',
        libelle: 'Texte d’engagement (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Contrat n° 123 du 01/10/2015',
      },
      {
        cle: 'texteTitularisation',
        libelle: 'Texte de titularisation (n° et date, facultatif)',
        type: 'texte',
      },
    ],
    pieces: [
      DEMANDE,
      PRESENCE,
      PREMIERE_PRISE,
      {
        libelle: 'Texte d’engagement à la Fonction publique',
        obligatoire: true,
      },
      { libelle: 'Texte de titularisation', obligatoire: true },
      BULLETIN,
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: {
        ...A_LA_FP,
        objet: 'Projet de texte portant changement de statut',
      },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, le projet de texte portant changement de statut, de contractuel à fonctionnaire, de {agent}{enService}, {f:engagé|engagée} par le texte {champ:texteEngagement}[[ et {f:titularisé|titularisée} par le texte {champ:texteTitularisation}]].',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de changement de statut',
        suite:
          ', {f:engagé|engagée} par le texte {champ:texteEngagement}[[ et {f:titularisé|titularisée} par le texte {champ:texteTitularisation}]]',
        colonnes: COLS_STATUT,
      },
    },
  },
  {
    code: 'AVANCEMENT',
    numero: 38,
    libelle:
      'Avancement (contractuels), promotion (fonctionnaires), RSA, RCA, reclassement, titularisation',
    famille: 'CARRIERE',
    pourQui:
      'Un agent dont la carrière doit évoluer : avancement (contractuel), promotion (fonctionnaire), révision de sa situation, reconstitution de sa carrière, reclassement ou titularisation. La DGRHAS transmet le projet d’arrêté à la Fonction publique.',
    acte: 'Soit-transmis du projet d’arrêté à la Fonction publique',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: SIGNE_CABINET,
    objet: 'Demande d’avancement ou de promotion',
    champs: [
      {
        cle: 'nature',
        libelle: 'Nature de la demande',
        type: 'liste',
        obligatoire: true,
        aide: 'RSA : corriger une situation administrative mal établie. RCA : refaire la carrière après un diplôme ou une formation. Reclassement : passer dans le corps de son nouveau diplôme.',
        options: [
          {
            valeur: 'AVANCEMENT',
            libelle: 'Avancement (contractuel)',
            acte: 'avancement',
          },
          {
            valeur: 'PROMOTION',
            libelle: 'Promotion (fonctionnaire)',
            acte: 'promotion',
          },
          {
            valeur: 'RSA',
            libelle: 'Révision de la situation administrative (RSA)',
            acte: 'révision de la situation administrative',
          },
          {
            valeur: 'RCA',
            libelle: 'Reconstitution de carrière administrative (RCA)',
            acte: 'reconstitution de carrière administrative',
          },
          {
            valeur: 'RECLASSEMENT',
            libelle: 'Reclassement',
            acte: 'reclassement',
          },
          {
            valeur: 'TITULARISATION',
            libelle: 'Titularisation',
            acte: 'titularisation',
          },
        ],
      },
      {
        cle: 'situationActuelle',
        libelle: 'Situation actuelle (grade, catégorie, échelle, échelon)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Instituteur, catégorie II, échelle 1, 3e échelon',
      },
      {
        cle: 'situationDemandee',
        libelle: 'Situation demandée',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Instituteur, catégorie II, échelle 1, 4e échelon',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      PREMIERE_PRISE,
      PRESENCE,
      { libelle: 'Un bulletin récent', obligatoire: true },
      {
        libelle: 'Certificat de prise de service au poste actuel',
        obligatoire: true,
      },
      { libelle: 'Texte de dernière promotion', obligatoire: true },
      {
        libelle: 'Diplôme (RCA et reclassement)',
        aide: 'Seulement pour une RCA ou un reclassement.',
      },
      {
        libelle: 'Arrêté de mise en stage (RCA)',
        aide: 'Seulement pour une RCA.',
      },
      {
        libelle: 'Autorisation de concourir (RCA)',
        aide: 'Seulement pour une RCA.',
      },
      { libelle: 'Texte d’engagement (RSA)', aide: 'Seulement pour une RSA.' },
      {
        libelle: 'Texte de titularisation (RSA)',
        aide: 'Seulement pour une RSA.',
      },
      {
        libelle: 'Certificat de reprise de service après la formation',
        aide: 'Après une formation.',
      },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: { ...A_LA_FP, objet: 'Projet d’arrêté portant {acte:nature}' },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, le projet d’arrêté portant {acte:nature} de {agent}{enService}, de la situation « {champ:situationActuelle} » à la situation « {champ:situationDemandee} ».',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de {acte:nature}',
        suite:
          ', de la situation « {champ:situationActuelle} » à la situation « {champ:situationDemandee} »',
        colonnes: COLS_STATUT,
      },
    },
  },
  {
    code: 'AVANCEMENT_EXCEPTIONNEL',
    numero: 39,
    libelle: 'Avancement à titre exceptionnel',
    famille: 'CARRIERE',
    pourQui:
      'Un agent proposé pour avancer plus vite que la règle, pour un mérite particulier : la DGRHAS transmet la proposition à la Fonction publique.',
    acte: 'Lettre de transmission à la Fonction publique',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: SIGNE_CABINET,
    objet: 'Demande d’avancement à titre exceptionnel',
    champs: [
      {
        cle: 'motif',
        libelle: 'Motif (mérite, acte exceptionnel…)',
        type: 'zone',
        obligatoire: true,
      },
      {
        cle: 'situationDemandee',
        libelle: 'Situation proposée',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Instituteur principal, 1er échelon',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      AFFECT_NOMINATION,
      PREMIERE_PRISE,
      PRESENCE,
      { libelle: 'Extrait ou copie d’acte de naissance', obligatoire: true },
      { libelle: 'Texte de dernière promotion', obligatoire: true },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Lettre de transmission',
      lettre: { ...A_LA_FP, objet: 'Avancement à titre exceptionnel' },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, la proposition d’avancement à titre exceptionnel de {agent}{enService}, au motif suivant : {champ:motif}.',
        'La situation proposée est : {champ:situationDemandee}.',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'd’avancement à titre exceptionnel',
        suite:
          ', au motif suivant : {champ:motif} (situation proposée : {champ:situationDemandee})',
        colonnes: COLS_STATUT,
      },
    },
  },
  {
    code: 'RECTIFICATIF_INTEGRATION',
    numero: 40,
    libelle: 'Rectificatif de texte d’intégration',
    famille: 'RECTIFICATIF',
    pourQui:
      'Un agent dont le texte d’intégration (ou d’engagement) contient une erreur (nom, date de naissance, diplôme…) : la DGRHAS transmet la demande de rectificatif à la Fonction publique.',
    acte: 'Soit-transmis à la Fonction publique',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: SIGNE_CABINET,
    objet: 'Demande de rectificatif de texte d’intégration',
    champs: [
      {
        cle: 'texteARectifier',
        libelle: 'Texte à rectifier (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Arrêté n° 1234 du 12/03/2025',
      },
      {
        cle: 'auLieuDe',
        libelle: 'Ce qui est écrit (l’erreur)',
        type: 'zone',
        obligatoire: true,
      },
      {
        cle: 'lire',
        libelle: 'Ce qu’il faut lire',
        type: 'zone',
        obligatoire: true,
      },
    ],
    pieces: [
      DEMANDE,
      {
        libelle: 'Texte d’intégration ou d’engagement à rectifier',
        obligatoire: true,
      },
      { libelle: 'Copie d’acte de naissance', obligatoire: true },
      { libelle: 'Copie légalisée du diplôme', obligatoire: true },
      {
        libelle: 'Photocopie de la pièce d’identité valide',
        obligatoire: true,
      },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: {
        ...A_LA_FP,
        objet: 'Rectificatif du texte {champ:texteARectifier}',
      },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, la demande de rectificatif du texte {champ:texteARectifier}, en ce qui concerne {agent} : au lieu de « {champ:auLieuDe} », lire « {champ:lire} ».',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de rectificatif de texte d’intégration',
        suite:
          ', pour le texte {champ:texteARectifier} : au lieu de « {champ:auLieuDe} », lire « {champ:lire} »',
        colonnes: COLS_RECRUTEMENT,
      },
    },
  },
  {
    code: 'PROMOTION_APTITUDE',
    numero: 41,
    libelle: 'Promotion sur liste d’aptitude',
    famille: 'CARRIERE',
    pourQui:
      'Un agent inscrit sur une liste d’aptitude (liste des agents jugés aptes à passer au grade supérieur) : la DGRHAS transmet le projet d’arrêté de promotion à la Fonction publique. Le document ne demande pas de lettre manuscrite.',
    acte: 'Soit-transmis d’un projet d’arrêté à la Fonction publique',
    niveauDecision: 'DGRHAS',
    signataire: SIGNE_CABINET,
    objet: 'Promotion sur liste d’aptitude',
    champs: [
      {
        cle: 'liste',
        libelle: 'Liste d’aptitude (année ou référence)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. liste d’aptitude 2026',
      },
      {
        cle: 'grade',
        libelle: 'Grade visé',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Instituteur principal',
      },
    ],
    pieces: [
      INTEGRATION,
      AFFECTATIONS,
      PREMIERE_PRISE,
      PRESENCE,
      { libelle: 'Extrait ou copie d’acte de naissance', obligatoire: true },
      { libelle: 'Texte de dernière promotion', obligatoire: true },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: {
        ...A_LA_FP,
        objet: 'Projet d’arrêté portant promotion sur liste d’aptitude',
      },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, le projet d’arrêté portant promotion de {agent}{enService}, au grade de {champ:grade}, au titre de la {champ:liste}.',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de promotion sur liste d’aptitude',
        suite: ', au grade de {champ:grade}, au titre de la {champ:liste}',
        colonnes: COLS_STATUT,
      },
    },
  },
  {
    code: 'CERTIFICAT_SERVICES_FAITS',
    numero: 42,
    libelle: 'Certificat des services faits',
    famille: 'SOLDE',
    pourQui:
      'Un agent à qui l’État doit de l’argent pour un travail effectué (heures, cours, intérim…) : le certificat atteste que ce travail a bien été fait, pour qu’il soit payé.',
    acte: 'Certificat',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: 'Le Ministre',
    objet: 'Demande de certificat des services faits',
    ordreDates: [{ avant: 'dateDebut', apres: 'dateFin' }],
    champs: [
      {
        cle: 'nature',
        libelle: 'Services effectués',
        type: 'texte',
        obligatoire: true,
        exemple:
          'Ex. les cours de mathématiques en classe de 3e (6 heures par semaine)',
      },
      DEBUT,
      FIN,
      {
        cle: 'montant',
        libelle: 'Sommes dues (facultatif)',
        type: 'texte',
        exemple: 'Ex. 450 000 FCFA',
        aide: 'Celles de l’état des sommes dues joint.',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECTATIONS,
      PRISE,
      PRESENCE,
      {
        libelle: 'Emploi du temps contresigné par le responsable immédiat',
        obligatoire: true,
      },
      { libelle: 'État des sommes dues', obligatoire: true },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Certificat des services faits',
      articles: [
        'Le Ministre de l’Enseignement préscolaire, primaire, secondaire et de l’alphabétisation certifie que {agent}{enService}, a effectivement assuré {champ:nature}, du {champ:dateDebut} au {champ:dateFin}[[, ouvrant droit au paiement de {champ:montant}]].',
        EN_FOI_CERTIFICAT,
      ],
    },
  },
  {
    code: 'PRISE_EN_CHARGE_SOLDE',
    numero: 42,
    libelle: 'Prise en charge en solde',
    famille: 'SOLDE',
    pourQui:
      'Un agent qui travaille mais n’est pas encore payé : la DGRHAS demande au Budget de le mettre sur la liste de paie (« prise en charge en solde »).',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prise en charge en solde',
    champs: [
      {
        cle: 'datePriseService',
        libelle: 'Date de prise de service',
        type: 'date',
        obligatoire: true,
      },
      {
        cle: 'banque',
        libelle: 'Banque (facultatif)',
        type: 'texte',
        exemple: 'Ex. BGFI Bank',
        aide: 'Celle du relevé d’identité bancaire joint.',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      AFFECT_NOMINATION,
      PRISE,
      PRESENCE,
      { libelle: 'Photocopie de la pièce d’identité', obligatoire: true },
      { libelle: 'Copie ou extrait d’acte de naissance', obligatoire: true },
      { libelle: 'Relevé d’identité bancaire', obligatoire: true },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: { ...AU_BUDGET, objet: 'Prise en charge en solde' },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, le dossier de prise en charge en solde de {agent}{enService}, en service depuis le {champ:datePriseService}[[ (banque : {champ:banque})]].',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de prise en charge en solde',
        apresIdentite:
          '[[, {f:intégré|intégrée} ou {f:engagé|engagée} dans la Fonction publique par {agent.texteRecrutement}]]',
        suite: ', depuis le {champ:datePriseService}',
        colonnes: COLS_RECRUTEMENT,
      },
    },
  },
  {
    code: 'DOMICILIATION_SALAIRE',
    numero: 43,
    libelle: 'Domiciliation de salaire',
    famille: 'SOLDE',
    pourQui:
      'Un agent qui veut que son salaire soit versé dans une banque (souvent demandé par la banque pour un prêt) : la DGRHAS l’atteste.',
    acte: 'Attestation',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande d’attestation de domiciliation de salaire',
    champs: [
      {
        cle: 'banque',
        libelle: 'Banque',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. BGFI Bank',
      },
      {
        cle: 'agence',
        libelle: 'Agence (facultatif)',
        type: 'texte',
        exemple: 'Ex. Brazzaville centre-ville',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      AFFECT_NOMINATION,
      PRISE,
      PRESENCE,
      BULLETIN,
      { libelle: 'Relevé d’identité bancaire', obligatoire: true },
    ],
    acteModele: {
      ...ATTESTATION_DGRHAS,
      titre: 'Attestation de domiciliation de salaire',
      articles: [
        `${LE_DG} atteste que le salaire de {agent}{enService}, est domicilié auprès de {champ:banque}[[, agence {champ:agence}]], au vu du relevé d’identité bancaire joint.`,
        EN_FOI_ATTESTATION,
      ],
    },
  },
  {
    code: 'CHANGEMENT_REGLEMENT',
    numero: 44,
    libelle: 'Changement de mode de règlement',
    famille: 'SOLDE',
    pourQui:
      'Un agent qui veut que son salaire soit payé autrement (autre banque…) : la DGRHAS transmet la demande au Budget.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de changement de mode de règlement',
    champs: [
      {
        cle: 'ancienneBanque',
        libelle: 'Banque actuelle (facultatif)',
        type: 'texte',
        exemple: 'Ex. Banque A',
      },
      {
        cle: 'nouvelleBanque',
        libelle: 'Nouvelle banque',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Banque B, agence de Dolisie',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECT_NOMINATION,
      PRISE,
      {
        libelle: 'Attestation de non redevance',
        obligatoire: true,
        aide: 'Délivrée par l’ancienne banque : l’agent ne lui doit plus rien.',
      },
      {
        libelle: 'Relevé d’identité bancaire de la nouvelle banque',
        obligatoire: true,
      },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: { ...AU_BUDGET, objet: 'Changement de mode de règlement' },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, la demande de changement de mode de règlement du salaire de {agent}{enService}, qui sera désormais versé auprès de {champ:nouvelleBanque}[[ (au lieu de {champ:ancienneBanque})]].',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de changement de mode de règlement (MDR)',
        colonnes: COLS_RECRUTEMENT,
      },
    },
  },
  {
    code: 'RECTIFICATIF_IDENTITE',
    numero: 45,
    libelle:
      'Rectificatif de nom/prénom/grade, changement d’identité, de code de service ou de situation matrimoniale sur le bulletin de solde',
    famille: 'RECTIFICATIF',
    pourQui:
      'Un agent dont le bulletin de solde (fiche de paie) porte une erreur, ou dont la situation a changé (mariage, nouveau service…) : la DGRHAS transmet la correction au Budget. Le document ne demande pas de lettre manuscrite.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Rectificatif sur le bulletin de solde',
    champs: [
      {
        cle: 'nature',
        libelle: 'Ce qui est à corriger',
        type: 'liste',
        obligatoire: true,
        options: [
          {
            valeur: 'NOM',
            libelle: 'Nom ou prénoms',
            acte: 'du nom ou des prénoms',
          },
          { valeur: 'GRADE', libelle: 'Grade', acte: 'du grade' },
          { valeur: 'IDENTITE', libelle: 'Identité', acte: 'de l’identité' },
          {
            valeur: 'CODE_SERVICE',
            libelle: 'Code de service',
            acte: 'du code de service',
          },
          {
            valeur: 'SITUATION_MATRIMONIALE',
            libelle: 'Situation matrimoniale',
            acte: 'de la situation matrimoniale',
          },
        ],
      },
      {
        cle: 'auLieuDe',
        libelle: 'Ce qui est écrit sur le bulletin',
        type: 'zone',
        obligatoire: true,
      },
      {
        cle: 'lire',
        libelle: 'Ce qu’il faut lire',
        type: 'zone',
        obligatoire: true,
      },
    ],
    pieces: [
      INTEGRATION,
      AFFECTATIONS,
      PRISE,
      PRESENCE,
      { libelle: 'Extrait ou copie d’acte de naissance', obligatoire: true },
      {
        libelle: 'Pièces justifiant le rectificatif',
        obligatoire: true,
        aide: 'Acte de mariage, texte de promotion, note d’affectation… selon le cas.',
      },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: { ...AU_BUDGET, objet: 'Rectificatif sur le bulletin de solde' },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, la demande de rectificatif {acte:nature} porté sur le bulletin de solde de {agent}{enService} : au lieu de « {champ:auLieuDe} », lire « {champ:lire} ».',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de rectificatif sur le bulletin de solde',
        suite:
          ' (rectificatif {acte:nature} : au lieu de « {champ:auLieuDe} », lire « {champ:lire} »)',
        colonnes: COLS_RECRUTEMENT,
      },
    },
  },
  {
    code: 'PRIME_DOCUMENTATION',
    numero: 46,
    libelle: 'Prime de documentation et matériel didactique',
    famille: 'PRIME',
    pourQui:
      'Un enseignant qui demande la prime versée pour l’achat de documents et de matériel pédagogique.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prime de documentation et matériel didactique',
    champs: [A_COMPTER_DU],
    pieces: PIECES_PRIME(PRISE),
    acteModele: SOIT_TRANSMIS_PRIME(
      'prime de documentation et matériel didactique',
      '[[, à compter du {champ:dateDebut}]]',
    ),
  },
  {
    code: 'PRIME_HINTERLAND',
    numero: 47,
    libelle: 'Prime d’affectation dans l’hinterland',
    famille: 'PRIME',
    pourQui:
      'Un agent affecté dans l’hinterland (zone de l’intérieur du pays, rurale ou éloignée) : il demande la prime liée à ce poste.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prime d’affectation dans l’hinterland',
    champs: [
      {
        cle: 'localite',
        libelle: 'Localité d’affectation',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Mbon',
      },
      {
        cle: 'dateAffectation',
        libelle: 'En poste depuis le',
        type: 'date',
        obligatoire: true,
      },
    ],
    pieces: PIECES_PRIME(PRISE),
    acteModele: SOIT_TRANSMIS_PRIME(
      'prime d’affectation dans l’hinterland',
      ', en poste à {champ:localite} depuis le {champ:dateAffectation}',
    ),
  },
  {
    code: 'PRIME_MULTIGRADE',
    numero: 48,
    libelle: 'Prime de classe multigrade',
    famille: 'PRIME',
    pourQui:
      'Un enseignant qui tient une classe multigrade (plusieurs niveaux dans la même salle, ex. CP1 et CP2 ensemble).',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prime de classe multigrade',
    champs: [
      {
        cle: 'classes',
        libelle: 'Niveaux tenus ensemble',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. CP1 et CP2',
      },
      {
        cle: 'anneeScolaire',
        libelle: 'Année scolaire',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. 2026-2027',
      },
    ],
    pieces: PIECES_PRIME(PRISE, {
      libelle: 'Emploi du temps authentifié par le directeur de l’école',
      obligatoire: true,
    }),
    acteModele: SOIT_TRANSMIS_PRIME(
      'prime de classe multigrade',
      ', qui tient une classe multigrade ({champ:classes}) au titre de l’année scolaire {champ:anneeScolaire}',
    ),
  },
  {
    code: 'PRIME_FIDELITE',
    numero: 49,
    libelle: 'Prime de fidélité (ou de maintien au poste)',
    famille: 'PRIME',
    pourQui:
      'Un agent resté longtemps au même poste : il demande la prime de fidélité (aussi appelée prime de maintien au poste).',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prime de fidélité',
    champs: [
      {
        cle: 'depuis',
        libelle: 'Au même poste depuis le',
        type: 'date',
        obligatoire: true,
      },
    ],
    pieces: PIECES_PRIME(PREMIERE_PRISE),
    acteModele: SOIT_TRANSMIS_PRIME(
      'prime de fidélité (maintien au poste)',
      ', au même poste depuis le {champ:depuis}',
    ),
  },
  {
    code: 'PRIME_ENRACINEMENT',
    numero: 50,
    libelle: 'Prime d’enracinement',
    famille: 'PRIME',
    pourQui:
      'Un agent installé durablement dans une localité difficile (il s’y « enracine ») : il demande la prime d’enracinement.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prime d’enracinement',
    champs: [
      {
        cle: 'localite',
        libelle: 'Localité',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Mbon',
      },
      {
        cle: 'depuis',
        libelle: 'Installé depuis le',
        type: 'date',
        obligatoire: true,
      },
    ],
    pieces: PIECES_PRIME(PREMIERE_PRISE),
    acteModele: SOIT_TRANSMIS_PRIME(
      'prime d’enracinement',
      ', en poste à {champ:localite} depuis le {champ:depuis}',
    ),
  },
  {
    code: 'PRIME_PLETHORE',
    numero: 51,
    libelle: 'Prime de pléthore',
    famille: 'PRIME',
    pourQui:
      'Un enseignant dont la classe a trop d’élèves (« pléthore ») : il demande la prime de pléthore.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prime de pléthore',
    champs: [
      {
        cle: 'classe',
        libelle: 'Classe',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. CM2 A',
      },
      {
        cle: 'effectif',
        libelle: 'Nombre d’élèves',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. 95',
      },
    ],
    pieces: PIECES_PRIME(
      {
        libelle: 'Certificat de prise ou de reprise de service',
        obligatoire: true,
      },
      {
        libelle:
          'Liste des élèves authentifiée par le chef d’établissement scolaire',
        obligatoire: true,
      },
      {
        libelle:
          'Emploi du temps authentifié par le chef d’établissement scolaire',
        obligatoire: true,
      },
    ),
    acteModele: SOIT_TRANSMIS_PRIME(
      'prime de pléthore',
      ', titulaire de la classe {champ:classe} ({champ:effectif} élèves)',
    ),
  },
  {
    code: 'PRIME_RISQUE_SANTE',
    numero: 52,
    libelle: 'Prime de risque et santé',
    famille: 'PRIME',
    pourQui:
      'Un agent exposé à un risque pour sa santé dans son travail : il demande la prime de risque et santé.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de prime de risque et santé',
    champs: [
      {
        cle: 'risque',
        libelle: 'Nature du risque (facultatif)',
        type: 'texte',
        exemple: 'Ex. travail de laboratoire',
      },
    ],
    pieces: PIECES_PRIME(PRISE),
    acteModele: SOIT_TRANSMIS_PRIME(
      'prime de risque et santé',
      '[[ (risque : {champ:risque})]]',
    ),
  },
  {
    code: 'INDEMNITE_FONCTION',
    numero: 53,
    libelle: 'Indemnité de fonction',
    famille: 'PRIME',
    pourQui:
      'Un agent nommé à un poste de responsabilité (directeur d’école, chef de service…) : il demande l’indemnité attachée à cette fonction.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande d’indemnité de fonction',
    champs: [
      {
        cle: 'fonction',
        libelle: 'Fonction exercée',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. directeur d’école',
      },
      {
        cle: 'texteNomination',
        libelle: 'Texte de nomination (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Note de service n° 0456 du 05/09/2026',
      },
      {
        cle: 'datePriseFonction',
        libelle: 'Date de prise de fonction',
        type: 'date',
        obligatoire: true,
      },
    ],
    pieces: PIECES_PRIME({
      libelle: 'Certificat de prise de service après la nomination',
      obligatoire: true,
    }),
    acteModele: SOIT_TRANSMIS_PRIME(
      'l’indemnité de fonction',
      ', {f:nommé|nommée} {champ:fonction} par le texte {champ:texteNomination} et en fonction depuis le {champ:datePriseFonction}',
      'de mandatement de l’indemnité de fonction',
      COLS_NOMINATION,
    ),
  },
  {
    code: 'RAPPEL_INDEMNITE',
    numero: 54,
    libelle: 'Rappel de l’indemnité de fonction',
    famille: 'RAPPEL',
    pourQui:
      'Un agent qui n’a pas touché son indemnité de fonction pendant une période : il en demande le rappel (le paiement de ce qui est dû). La DGRHAS transmet le projet d’arrêté à la Fonction publique.',
    acte: 'Soit-transmis du projet d’arrêté à la Fonction publique',
    niveauDecision: 'DGRHAS-Ministre',
    signataire: SIGNE_CABINET,
    objet: 'Demande de rappel de l’indemnité de fonction',
    ordreDates: [{ avant: 'dateDebut', apres: 'dateFin' }],
    champs: [
      {
        cle: 'fonction',
        libelle: 'Fonction exercée',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. directeur d’école',
      },
      {
        cle: 'texteNomination',
        libelle: 'Texte de nomination (n° et date)',
        type: 'texte',
        obligatoire: true,
      },
      { ...DEBUT, libelle: 'Période non payée : du' },
      { ...FIN, libelle: 'au (facultatif)', obligatoire: false },
    ],
    pieces: [
      DEMANDE,
      { libelle: 'Texte de nomination', obligatoire: true },
      {
        libelle: 'Certificat de prise de service, après nomination',
        obligatoire: true,
      },
      BULLETIN,
      PRESENCE,
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: {
        ...A_LA_FP,
        objet: 'Projet d’arrêté portant rappel de l’indemnité de fonction',
      },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, le projet d’arrêté portant rappel de l’indemnité de fonction de {agent}{enService}, {f:nommé|nommée} {champ:fonction} par le texte {champ:texteNomination}, pour la période du {champ:dateDebut}[[ au {champ:dateFin}]].',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de rappel de l’indemnité de fonction',
        suite:
          ', {f:nommé|nommée} {champ:fonction} par le texte {champ:texteNomination}, pour la période du {champ:dateDebut}[[ au {champ:dateFin}]]',
        colonnes: COLS_NOMINATION,
      },
    },
  },
  {
    code: 'RAPPEL_SOLDE',
    numero: 55,
    libelle: 'Rappel de solde d’activités',
    famille: 'RAPPEL',
    pourQui:
      'Un agent qui a travaillé des mois sans être payé (au début de sa carrière, souvent) : il demande le rappel de ce salaire.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de rappel de solde d’activités',
    ordreDates: [{ avant: 'datePriseService', apres: 'datePremierSalaire' }],
    champs: [
      {
        cle: 'datePriseService',
        libelle: 'Date de première prise de service',
        type: 'date',
        obligatoire: true,
      },
      {
        cle: 'datePremierSalaire',
        libelle: 'Date du premier salaire perçu (facultatif)',
        type: 'date',
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECTATIONS,
      PRESENCE,
      PREMIERE_PRISE,
      { libelle: 'Photocopie du premier bulletin de solde', obligatoire: true },
    ],
    acteModele: SOIT_TRANSMIS_PRIME(
      'rappel de solde d’activités',
      ', en service depuis le {champ:datePriseService}[[ et {f:payé|payée} seulement à partir du {champ:datePremierSalaire}]]',
      'de mandatement de rappel de solde d’activité',
      COLS_RECRUTEMENT,
    ),
  },
  {
    code: 'RAPPEL_PROMOTIONS',
    numero: 56,
    libelle: 'Rappel des promotions',
    famille: 'RAPPEL',
    pourQui:
      'Un agent promu dont le salaire n’a pas encore suivi sa promotion : il demande le rappel (la différence due depuis la promotion).',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de rappel des promotions',
    champs: [
      {
        cle: 'textePromotion',
        libelle: 'Texte de la dernière promotion (n° et date)',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. Arrêté n° 1234 du 12/03/2025',
      },
      {
        cle: 'dateEffet',
        libelle: 'Date d’effet de la promotion',
        type: 'date',
        obligatoire: true,
      },
    ],
    pieces: [
      DEMANDE,
      TEXTE_INTEGRATION_OU_ENGAGEMENT,
      AFFECT_NOMINATION,
      PRESENCE,
      {
        libelle: 'Certificat de prise de service au poste actuel',
        obligatoire: true,
      },
      { libelle: 'Texte de dernière promotion', obligatoire: true },
      {
        libelle:
          'Photocopie du bulletin de solde relatif à la situation précédente',
        obligatoire: true,
      },
      {
        libelle:
          'Photocopie du bulletin de solde de la situation de sa dernière promotion',
        obligatoire: true,
      },
    ],
    acteModele: SOIT_TRANSMIS_PRIME(
      'rappel de promotion',
      ', {f:promu|promue} par le texte {champ:textePromotion} avec effet au {champ:dateEffet}',
      'de mandatement de rappel de promotion',
      COLS_PROMOTION,
    ),
  },
  {
    code: 'ALLOCATIONS_FAMILIALES',
    numero: 57,
    libelle: 'Allocations familiales',
    famille: 'SOCIAL',
    pourQui:
      'Un agent qui a des enfants à charge : il demande les allocations familiales, versées avec son salaire.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande d’allocations familiales',
    champs: [
      {
        cle: 'nombreEnfants',
        libelle: 'Nombre d’enfants à charge',
        type: 'texte',
        obligatoire: true,
        exemple: 'Ex. 3',
      },
      {
        cle: 'enfants',
        libelle: 'Nom et date de naissance de chaque enfant',
        type: 'zone',
        obligatoire: true,
        exemple: 'Ex. MABIALA Grâce, née le 12/03/2018',
      },
    ],
    pieces: [
      DEMANDE,
      INTEGRATION,
      {
        libelle: 'Notes d’affectation ministérielle et départementale',
        obligatoire: true,
      },
      PRISE,
      PRESENCE,
      {
        libelle: 'Autorisation maritale (pour les dames)',
        aide: 'Seulement pour une agente mariée.',
      },
      {
        libelle: 'Certificat de vie et d’entretien des enfants',
        obligatoire: true,
      },
      {
        libelle: 'Extraits d’actes de naissance légalisés des enfants',
        obligatoire: true,
      },
      {
        libelle:
          'Photocopies légalisées des originaux d’actes de naissance des enfants',
        obligatoire: true,
      },
    ],
    acteModele: SOIT_TRANSMIS_PRIME(
      'allocations familiales',
      ', pour {champ:nombreEnfants} enfant(s) à charge',
      'de paiement des allocations familiales',
    ),
  },
  {
    code: 'CAPITAL_DECES',
    numero: 58,
    libelle: 'Capital décès',
    famille: 'SOCIAL',
    pourQui:
      'La famille d’un agent décédé : un héritier (« ayant droit ») demande le capital décès. L’agent à choisir est la personne décédée ; l’héritier se présente dans la demande.',
    acte: 'Soit-transmis au Budget',
    niveauDecision: 'DGRHAS',
    signataire: LE_DG,
    objet: 'Demande de capital décès',
    champs: [
      {
        cle: 'dateDeces',
        libelle: 'Date du décès',
        type: 'date',
        obligatoire: true,
      },
      {
        cle: 'ayantDroit',
        libelle: 'Nom et prénoms de l’héritier qui fait la demande',
        type: 'texte',
        obligatoire: true,
        aide: 'Celui que désigne le jugement d’hérédité.',
      },
      {
        cle: 'lien',
        libelle: 'Lien avec la personne décédée',
        type: 'liste',
        obligatoire: true,
        options: [
          { valeur: 'CONJOINT', libelle: 'Conjoint(e)', acte: 'conjoint(e)' },
          { valeur: 'ENFANT', libelle: 'Enfant', acte: 'enfant' },
          { valeur: 'PARENT', libelle: 'Père ou mère', acte: 'père ou mère' },
          { valeur: 'AUTRE', libelle: 'Autre héritier', acte: 'héritier' },
        ],
      },
      {
        cle: 'telephone',
        libelle: 'Téléphone de l’héritier (facultatif)',
        type: 'texte',
      },
    ],
    pieces: [
      DEMANDE,
      { libelle: 'Acte de décès', obligatoire: true },
      { libelle: 'Procès-verbal du conseil de famille', obligatoire: true },
      {
        libelle: 'Jugement d’hérédité (délivré au tribunal)',
        obligatoire: true,
      },
      {
        libelle:
          'Certificat de non appel ni d’opposition (direction des impôts)',
        obligatoire: true,
      },
      {
        libelle: 'Certificat de cessation de paiement du défunt',
        obligatoire: true,
      },
      {
        libelle: 'Carte nationale d’identité de l’héritier',
        obligatoire: true,
      },
      {
        libelle: 'Certificat de célibat ou acte de mariage (pour les mariés)',
        obligatoire: true,
      },
      {
        libelle:
          'Extrait(s) d’acte(s) de naissance de l’(des) enfant(s) du défunt',
        aide: 'S’il a des enfants.',
      },
      {
        libelle:
          'Certificat(s) de vie et d’entretien de l’(des) enfant(s) du défunt',
        aide: 'S’il a des enfants.',
      },
      {
        libelle: 'Texte d’intégration à la Fonction publique du défunt',
        obligatoire: true,
      },
      { libelle: 'Photocopie du bulletin de solde', obligatoire: true },
    ],
    acteModele: {
      ...LETTRE_FP,
      titre: 'Soit-transmis',
      lettre: {
        ...AU_BUDGET,
        objet: 'Capital décès de feu {agent.nomComplet}',
      },
      articles: [
        'J’ai l’honneur de vous transmettre, pour compétence, le dossier de capital décès de feu {agent.nomComplet}[[, {agent.grade}]][[, matricule {agent.matricule}]][[, en service à {agent.lieuService}]], {f:décédé|décédée} le {champ:dateDeces}, au profit de {champ:ayantDroit}, {acte:lien} {f:du défunt|de la défunte}.',
        PIECES_JOINTES,
      ],
      transmission: {
        demande: 'de paiement du capital décès',
        corps:
          'la demande de paiement du capital décès, formulée par {champ:ayantDroit}, {acte:lien} de feu {agent.nomComplet}[[, précédemment {agent.grade}]][[, matricule de solde n° {agent.matricule}]], {f:décédé|décédée} le {champ:dateDeces}.',
        colonnes: COLS_BASE,
      },
      ampliations: ['Ayant droit', 'DGRHAS', 'Archives'],
    },
  },
];

export const CODES_PRESTATIONS = new Set(PRESTATIONS.map((p) => p.code));

export const definition = (code: string) =>
  PRESTATIONS.find((p) => p.code === code);
