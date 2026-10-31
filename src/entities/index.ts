import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/* ============================ Utilisateurs ============================ */

export const ROLES = [
  'ADMIN',
  'AGENT',
  'CHEF_SERVICE',
  'DIRECTEUR',
  'DG',
  'DDEPPSA',
  'CABINET',
  /** Chef du bureau d'études : contrôle du traitement, au même niveau que la DRSC. */
  'BUREAU_ETUDES',
  /**
   * Chef du secrétariat du DG : reçoit les dossiers accordés et les notes validées pour imprimer
   * (fiche individuelle, pièces jointes, note) avant l'envoi à la signature du ministre.
   */
  'SECRETARIAT',
  /**
   * Responsable d'une structure hors DGRHAS (établissement, inspection, service, direction
   * centrale ou générale) : vise et donne son avis sur les demandes de son circuit.
   */
  'STRUCTURE',
] as const;
export type Role = (typeof ROLES)[number];

@Entity('utilisateur')
export class Utilisateur {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column() email: string;
  @Column() nom: string;
  /** Initiales affichées dans la traçabilité des lignes (ex. « HM »). */
  @Column({ type: 'varchar', length: 10, nullable: true }) initiales:
    string | null;
  @Column({ type: 'varchar' }) role: Role;
  /** Département pour un utilisateur DDEPPSA. */
  @Column({ type: 'int', nullable: true }) departementId: number | null;
  /** Structure de l'organigramme où il travaille (vise et donne son avis à cette étape). */
  @Index() @Column({ type: 'int', nullable: true }) structureId: number | null;
  /** Délégation pendant une absence : ce collègue agit à sa place jusqu'à la date de fin. */
  @Column({ type: 'uuid', nullable: true }) delegueId: string | null;
  @Column({ type: 'date', nullable: true }) delegationFin: string | null;
  @Column({ select: false }) motDePasseHash: string;
  /**
   * Code personnel de 12 caractères demandé à la connexion (avec l'e-mail et le mot de passe).
   * Chiffré (l'administrateur et le DG peuvent le relire), jamais renvoyé avec le compte.
   */
  @Column({ type: 'varchar', nullable: true, select: false }) codeChiffre:
    string | null;
  @Column({ type: 'timestamptz', nullable: true }) codeCreeLe: Date | null;
  @Column({ default: true }) actif: boolean;
  /**
   * Version des sessions : chaque jeton porte la version du moment où il a été donné.
   * L'augmenter ferme toutes les sessions ouvertes (mot de passe ou code changé, « déconnecter »).
   */
  @Column({ type: 'int', default: 0, select: false }) versionSession: number;
  /** Échecs de connexion d'affilée (remis à zéro à la connexion réussie). */
  @Column({ type: 'int', default: 0, select: false }) echecsConnexion: number;
  /** Heure du dernier échec : les échecs comptent sur une fenêtre de 15 minutes. */
  @Column({ type: 'timestamptz', nullable: true, select: false })
  dernierEchec: Date | null;
  /** Trop d'échecs : connexion refusée jusqu'à cette heure. */
  @Column({ type: 'timestamptz', nullable: true }) bloqueJusqua: Date | null;
  @CreateDateColumn() creeLe: Date;
}

@Entity('journal')
export class Journal {
  @PrimaryGeneratedColumn() id: number;
  @Index() @CreateDateColumn() date: Date;
  @Column({ type: 'uuid', nullable: true }) utilisateurId: string | null;
  @Column({ type: 'varchar', nullable: true }) utilisateurNom: string | null;
  @Column() action: string;
  @Column({ type: 'varchar', nullable: true }) entite: string | null;
  @Column({ type: 'varchar', nullable: true }) entiteId: string | null;
  @Column({ type: 'jsonb', nullable: true }) details: unknown;
}

@Entity('parametre')
export class Parametre {
  @PrimaryColumn() cle: string;
  @Column({ type: 'text' }) valeur: string;
  @Column({ type: 'varchar', nullable: true }) description: string | null;
}

/* ============================ Référentiels ============================ */

@Entity('departement')
export class Departement {
  @PrimaryGeneratedColumn() id: number;
  @Index({ unique: true }) @Column() code: string;
  @Column() nom: string;
  @Column() article: string;
  @Column({ type: 'int' }) ordre: number;
}

@Entity('regle_diplome')
export class RegleDiplome {
  @PrimaryColumn() code: string;
  @Column() libelle: string;
  @Column() cycle: string;
  @Column() typeNote: string;
  /** Grade donné par le diplôme (liste des grades). */
  @Column({ type: 'varchar', nullable: true }) gradeCode: string | null;
  /** Façons dont le diplôme est écrit dans les fichiers Excel (ex. « BAC A4 »). */
  @Column({ type: 'jsonb', default: () => "'[]'" }) ecritures: string[];
  /**
   * Autres grades possibles avec ce diplôme (DG, 31/10/2026) : le grade ci-dessus reste celui par
   * défaut ; un de ceux-ci se choisit à la demande, personne par personne.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" }) gradesAutres: string[];
  /* Copie des valeurs du grade, tenue à jour automatiquement (lecture rapide). */
  @Column({ type: 'varchar', nullable: true }) grade: string | null;
  @Column({ type: 'varchar', nullable: true }) gradeLibelle: string | null;
  @Column({ type: 'varchar', nullable: true }) categorie: string | null;
  @Column({ type: 'int', nullable: true }) echelle: number | null;
  @Column({ type: 'int', nullable: true }) echelon: number | null;
  @Column({ type: 'int', nullable: true }) indice: number | null;
}

/** Grade choisi pour une personne (copie de la classification du grade). */
export interface GradeChoisi {
  code: string;
  abreviation: string;
  libelle: string;
  categorie: string | null;
  echelle: number | null;
  echelon: number | null;
  indice: number | null;
  par: string;
  le: string;
}

/** Grade de la fonction publique et sa classification. */
@Entity('grade')
export class Grade {
  @PrimaryColumn() code: string;
  /** Abréviation imprimée sur les notes (ex. « Inst »). */
  @Column() abreviation: string;
  @Column() libelle: string;
  @Column({ type: 'varchar', nullable: true }) categorie: string | null;
  @Column({ type: 'int', nullable: true }) echelle: number | null;
  @Column({ type: 'int', nullable: true }) echelon: number | null;
  /** Indice au recrutement : salaire brut = indice × point indiciaire. */
  @Column({ type: 'int', nullable: true }) indice: number | null;
}

/* ============================ Recrutement ============================= */

/** Paquet = un envoi de textes par la FP, reconnu à sa date de réception (types et quotas mélangés). */
@Entity('paquet_reception')
export class PaquetReception {
  @PrimaryGeneratedColumn() id: number;
  /** Ordre d'arrivée (1er paquet, 2e paquet…). */
  @Index({ unique: true }) @Column({ type: 'int' }) numero: number;
  @Index() @Column({ type: 'date', nullable: true }) dateReception:
    string | null;
  /** Référence du soit-transmis de la FP, si connue. */
  @Column({ type: 'varchar', nullable: true }) reference: string | null;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  @CreateDateColumn() creeLe: Date;
}

/**
 * Lot de réception : dans un paquet, les textes d'un même quota et d'un même type
 * (Arrêtés, Décrets PM, Décrets PR). Chaque couple quota + type a sa numérotation (rang).
 */
@Entity('lot_publication')
export class LotPublication {
  @PrimaryGeneratedColumn() id: number;
  /** N° technique unique (adresses des pages) ; l'agent voit le libellé. */
  @Index({ unique: true }) @Column({ type: 'int' }) numero: number;
  @Index() @Column({ type: 'int', nullable: true }) paquetId: number | null;
  /** ARRETE, DECRET_PM ou DECRET_PR (lot rangé par date) ; ARRETE ou DECRET (lot du fichier). */
  @Column({ type: 'varchar', nullable: true }) typeTexte: string | null;
  /**
   * Lot de publication écrit dans la base de la DGRHAS (« VIII », DG 30/10/2026) : les arrêtés et
   * les décrets ont chacun leur numérotation ; tous les quotas (MEPPSA, Autres) y sont réunis.
   */
  @Column({ type: 'int', nullable: true }) numeroFichier: number | null;
  /** Lot déjà traité (à la main ou dans le système) : plus proposé à l'affectation. */
  @Column({ type: 'boolean', default: false }) archive: boolean;
  @Column({ type: 'int', nullable: true }) quota: number | null;
  /** Lot du quota « Autres ». */
  @Column({ type: 'boolean', default: false }) autres: boolean;
  /** N° du lot dans son quota et son type : « Arrêtés quota 2024 — lot 3 ». */
  @Column({ type: 'int', nullable: true }) rang: number | null;
  @Column({ type: 'date', nullable: true }) dateReception: string | null;
  /** Date de signature appliquée par défaut aux arrêtés du lot (ex. 31/12/2025). */
  @Column({ type: 'date', nullable: true }) dateSignatureArretes: string | null;
  @Column({ type: 'date', nullable: true }) dateSignatureDecrets: string | null;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** Une personne recrutée (ligne de la base générale). */
@Entity('agent')
export class Agent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column() cle: string;
  /** MEPPSA (liste du ministère) ou QUOTA_AUTRES. */
  @Column() feuille: string;
  @Column({ type: 'int', nullable: true }) quota: number | null;
  @Column({ type: 'int', nullable: true }) numeroOrdre: number | null;
  @Column({ type: 'int', nullable: true }) numeroListe: number | null;
  @Column() nomComplet: string;
  @Index() @Column() nomNormalise: string;
  @Column({ type: 'date', nullable: true }) dateNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) dateNaissanceBrute:
    string | null;
  @Column({ type: 'varchar', nullable: true }) lieuNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) diplomeBrut: string | null;
  @Column({ type: 'varchar', nullable: true }) diplomeCode: string | null;
  @Column({ type: 'varchar', nullable: true }) departementBrut: string | null;
  @ManyToOne(() => Departement, { nullable: true, eager: true })
  @JoinColumn({ name: 'departementId' })
  departement: Departement | null;
  @Column({ type: 'int', nullable: true }) departementId: number | null;
  @Column({ type: 'varchar', nullable: true }) source: string | null;
  @Column({ type: 'varchar', nullable: true }) cycleBrut: string | null;
  @Column({ type: 'varchar', nullable: true }) lotCommission: string | null;
  /** Colonnes ajoutées à la base du lot 8 (DG, 30/10/2026). */
  @Column({ type: 'varchar', nullable: true }) qualification: string | null;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  @Column({ type: 'varchar', nullable: true }) statut: string | null;
  @Column({ type: 'varchar', nullable: true }) transmission: string | null;
  @Column({ type: 'varchar', nullable: true }) parapheur: string | null;
  @Column({ type: 'varchar', nullable: true }) lieuServiceBrut: string | null;
  @Column({ type: 'varchar', nullable: true }) origineBrute: string | null;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  /* ---- Retour Fonction Publique ---- */
  @Column({ type: 'varchar', nullable: true }) typeTexte:
    'ARRETE' | 'DECRET' | null;
  @Column({ type: 'varchar', nullable: true }) numeroTexte: string | null;
  /** Date de signature propre à ce texte (sinon celle du lot). */
  @Column({ type: 'date', nullable: true }) dateSignatureTexte: string | null;
  @Column({ type: 'date', nullable: true }) dateReception: string | null;
  @ManyToOne(() => LotPublication, { nullable: true, eager: true })
  @JoinColumn({ name: 'lotPublicationId' })
  lotPublication: LotPublication | null;
  @Column({ type: 'int', nullable: true }) lotPublicationId: number | null;
  /** Statut contractuel imposé par l'arrêté (null = calcul automatique par l'âge). */
  @Column({ type: 'boolean', nullable: true }) contractuelForce: boolean | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) anomalies: string[];
  /** Anomalies vérifiées à la main : elles ne reviennent pas à la réimportation du fichier. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  anomaliesVerifiees: string[];
  /**
   * Grade choisi à la demande parmi les autres grades possibles de son diplôme (sinon le grade
   * par défaut du diplôme) : copie de la classification, tenue à jour avec le grade.
   */
  @Column({ type: 'jsonb', nullable: true }) gradeChoisi: GradeChoisi | null;
  /**
   * Ajoutée à la main dans la base des recrutés (DG, 31/10/2026) : liste des oubliés, contrôlée
   * avant d'entrer dans une note. A_CONTROLER, DEJA_AFFECTE (hors des notes), PAS_AFFECTE.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  oubli: 'A_CONTROLER' | 'DEJA_AFFECTE' | 'PAS_AFFECTE' | null;
  @Column({ type: 'varchar', nullable: true }) oubliPar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) oubliLe: Date | null;
  /* ---- Saisie dans le système (au lieu du fichier Excel) ---- */
  /** IMPORT = ligne du fichier Excel ; SAISIE = fiche enregistrée dans le système. */
  @Column({ type: 'varchar', default: 'IMPORT' }) origineFiche:
    'IMPORT' | 'SAISIE';
  /** Fiche saisie : à contrôler (relecture du dossier), contrôlée, puis validée par le DG. */
  @Column({ type: 'varchar', nullable: true }) etatFiche:
    'A_CONTROLER' | 'CONTROLEE' | 'VALIDEE' | null;
  @Column({ type: 'varchar', nullable: true }) saisiePar: string | null;
  @Column({ type: 'varchar', nullable: true }) controleePar: string | null;
  @Column({ type: 'varchar', nullable: true }) valideePar: string | null;
  /** Date de dépôt du dossier : l'âge minimum (18 ans) s'apprécie à cette date. */
  @Column({ type: 'date', nullable: true }) dateDepot: string | null;
  /** Au-delà de l'âge maximum : dossier en contentieux, décidé par le DG. */
  @Column({ type: 'varchar', nullable: true }) contentieuxAge:
    'EN_ATTENTE' | 'APPROUVE' | 'REJETE' | null;
  @Column({ type: 'varchar', nullable: true }) contentieuxPar: string | null;
  /** Département attribué par une répartition automatique du quota « Autres ». */
  @Column({ type: 'uuid', nullable: true }) repartitionId: string | null;
  /** Fiche corrigée après son envoi à la Fonction Publique (à signaler à la FP). */
  @Column({ type: 'boolean', default: false }) rectifiee: boolean;
  /** Remarque du contrôleur quand il renvoie la fiche pour correction. */
  @Column({ type: 'text', nullable: true }) remarqueControle: string | null;
  /**
   * Nature du lot de la commission : VOLONTAIRE (un seul diplôme professionnel),
   * COMMUNAUTAIRE (diplômes du cycle mélangés) ou MIXTE (volontaires et communautaires
   * du même cycle). Vide pour les fiches anciennes : déduite du statut.
   */
  @Column({ type: 'varchar', nullable: true }) lotNature:
    'VOLONTAIRE' | 'COMMUNAUTAIRE' | 'MIXTE' | null;
  /**
   * Dossier validé mis à part (budget ou quota dépassé) : quota d'où il vient. Il passe
   * au quota suivant, où il part en priorité.
   */
  @Column({ type: 'int', nullable: true }) reporteDe: number | null;
  @Column({ type: 'text', nullable: true }) reportMotif: string | null;
  @Column({ type: 'varchar', nullable: true }) reportePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) reporteLe: Date | null;
  /**
   * Fiche de la base du personnel (volontaire ou communautaire) choisie à la saisie : la personne
   * présentée par la commission est déjà connue, elle n'est pas ressaisie (DG, 23/10/2026).
   */
  @Index() @Column({ type: 'int', nullable: true }) agentRecenseId:
    number | null;
  /** Vague du volontaire présenté (les anciennes vagues sont recrutées d'abord). */
  @Column({ type: 'int', nullable: true }) vagueNumero: number | null;
  /** Membre de la commission qui a apporté le dossier (sur une de ses places). */
  @Index() @Column({ type: 'uuid', nullable: true }) membreCommissionId:
    string | null;
  /** N° de la transmission à la Fonction Publique (1ère, 2ème…), propre à chaque quota. */
  @Index() @Column({ type: 'int', nullable: true }) transmissionNumero:
    number | null;
  /**
   * Dossier mis de côté après son envoi (la FP le dit incomplet) : n° de la
   * transmission d'où il sort, pour pouvoir l'y rattacher une fois corrigé.
   */
  @Column({ type: 'int', nullable: true }) transmissionOrigine: number | null;
  @Column({ type: 'text', nullable: true }) misDeCoteMotif: string | null;
  @Column({ type: 'varchar', nullable: true }) misDeCotePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) misDeCoteLe: Date | null;
  @Column({ type: 'date', nullable: true }) transmisLe: string | null;
  /** Texte de la FP enregistré dans le système : protégé lors d'un import Excel. */
  @Column({ type: 'varchar', nullable: true }) textePointePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) textePointeLe: Date | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/* ============================ Affectations ============================ */

export const STATUTS_AFFECTATION = ['A_TRAITER', 'EXCLU', 'AFFECTE'] as const;

@Entity('affectation')
export class Affectation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @OneToOne(() => Agent, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agentId' })
  agent: Agent;
  @Index({ unique: true }) @Column() agentId: string;
  @Index() @Column({ type: 'int' }) lotPublicationId: number;
  @Column() typeNote: string;
  @ManyToOne(() => Departement, { nullable: true, eager: true })
  @JoinColumn({ name: 'departementId' })
  departement: Departement | null;
  @Column({ type: 'int', nullable: true }) departementId: number | null;
  @Column({ type: 'varchar', nullable: true }) structure: string | null;
  @Column({ type: 'varchar', nullable: true }) etablissement: string | null;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  @Column({ type: 'varchar', nullable: true }) obs: string | null;
  /** Origine interne (recommandation) — non imprimée sur la note. */
  @Column({ type: 'text', nullable: true }) origine: string | null;
  @Column({ type: 'varchar', default: 'A_TRAITER' }) statut: string;
  @Column({ type: 'text', nullable: true }) motifExclusion: string | null;
  @Column({ type: 'uuid', nullable: true }) noteId: string | null;
  @Column({ type: 'varchar', nullable: true }) traitePar: string | null;
  /**
   * Personne affectée (note signée) reportée dans la base du personnel, à la demande (DG,
   * 30/10/2026) : les recrutés restent à part tant qu'on ne les a pas déportés.
   */
  @Column({ type: 'timestamptz', nullable: true }) deporteLe: Date | null;
  @Column({ type: 'varchar', nullable: true }) deportePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/**
 * Recommandation : demande de changer ce que la règle donne naturellement (autre département,
 * autre établissement…), pour une affectation, une mutation ou un enrôlement (DG, 23/10/2026).
 * Circuit : le chef de service la propose, le directeur donne son avis, le DG décide.
 */
@Entity('recommandation')
export class Recommandation {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** AFFECTATION, MUTATION ou ENROLEMENT. */
  @Index()
  @Column({ type: 'varchar', default: 'AFFECTATION' })
  operation: string;
  @ManyToOne(() => Affectation, {
    eager: true,
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'affectationId' })
  affectation: Affectation | null;
  @Column({ type: 'uuid', nullable: true }) affectationId: string | null;
  /** Demande de mutation concernée. */
  @Index() @Column({ type: 'uuid', nullable: true }) demandeId: string | null;
  /** Dossier d'enrôlement concerné. */
  @Index() @Column({ type: 'uuid', nullable: true }) enroleId: string | null;
  /** Nom de la personne (affiché sans relire son dossier). */
  @Column({ type: 'varchar', nullable: true }) personne: string | null;
  /** AVIS_DIRECTEUR (proposée par un chef de service) puis DECISION_DG. */
  @Column({ type: 'varchar', default: 'DECISION_DG' }) etape: string;
  @Column({ type: 'jsonb', nullable: true }) avisDirecteur: {
    avis: 'FAVORABLE' | 'DEFAVORABLE';
    motif: string;
    par: string;
    le: string;
  } | null;
  /** Nouvelles valeurs proposées. */
  @Column({ type: 'varchar', nullable: true }) typeNote: string | null;
  @Column({ type: 'int', nullable: true }) departementId: number | null;
  @Column({ type: 'varchar', nullable: true }) structure: string | null;
  @Column({ type: 'varchar', nullable: true }) etablissement: string | null;
  /** Qui recommande (ex. « S/C Conseiller X »). */
  @Column({ type: 'text' }) origine: string;
  @Column({ type: 'text', nullable: true }) motif: string | null;
  @Column({ type: 'varchar', default: 'EN_ATTENTE' }) statut:
    'EN_ATTENTE' | 'VALIDEE' | 'REJETEE';
  @Column({ type: 'jsonb', nullable: true }) avant: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'varchar', nullable: true }) soumisPar: string | null;
  @Column({ type: 'varchar', nullable: true }) decidePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) dateDecision: Date | null;
  @Column({ type: 'text', nullable: true }) commentaireDecision: string | null;
  @CreateDateColumn() creeLe: Date;
}

/* ========================== Notes de service ========================== */

export const STATUTS_NOTE = [
  'BROUILLON',
  'SOUMISE',
  'VALIDEE',
  'SIGNEE',
] as const;
export type StatutNote = (typeof STATUTS_NOTE)[number];

@Entity('note_service')
export class NoteService {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() module: 'AFFECTATION' | 'MUTATION' | 'ENROLEMENT' | 'NOMINATION';
  /** Affectation : type de note ; mutation : groupe de cycles. */
  @Column() typeNote: string;
  @Column({ type: 'varchar', nullable: true }) motif: string | null;
  @Column({ type: 'int', nullable: true }) lotPublicationId: number | null;
  /**
   * Notes d'affectation : autres lots réunis dans cette note (DG, 26/10/2026 : une seule note
   * pour les lots 7 et 8 au lieu de deux). Mêmes type de note et colonnes ; le lot principal reste
   * lotPublicationId.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" }) lotsFusionnes: number[];
  /**
   * Quotas couverts par une note d'affectation (MEPPSA, AUTRES_AVEC, AUTRES_SANS) ; vide : tous.
   * « Je traite le quota MEPPSA et le quota Autres avec département » (DG, 30/10/2026).
   */
  @Column({ type: 'jsonb', default: () => "'[]'" }) groupes: string[];
  /** Note d'enrôlement : campagne d'où viennent les volontaires. */
  @Column({ type: 'int', nullable: true }) campagneId: number | null;
  @Column() anneeScolaire: string;
  @Column({ type: 'int', default: 1 }) rang: number;
  @Column({ type: 'varchar', nullable: true }) numero: string | null;
  @Column({ type: 'date', nullable: true }) dateSignature: string | null;
  @Column({ type: 'varchar', default: 'BROUILLON' }) statut: StatutNote;
  @Column({ type: 'text' }) introduction: string;
  /** Contenu figé lors de la validation par le DG. */
  @Column({ type: 'jsonb', nullable: true }) contenu: unknown;
  @Column({ type: 'text', nullable: true }) commentaire: string | null;
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @Column({ type: 'varchar', nullable: true }) soumisePar: string | null;
  @Column({ type: 'varchar', nullable: true }) valideePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) valideeLe: Date | null;
  /**
   * Avis de conformité donnés après la validation du DG, avant l'impression pour la signature :
   * le chef de bureau, le chef de service et le directeur lisent la note et disent si elle est conforme.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  conformite: AvisConformite[];
  /** À qui le DG a ordonné d'imprimer la version pour la signature : DIRECTEUR ou SECRETARIAT. */
  @Column({ type: 'varchar', nullable: true }) impressionPour: string | null;
  @Column({ type: 'varchar', nullable: true }) impressionOrdonneePar:
    string | null;
  @Column({ type: 'timestamptz', nullable: true })
  impressionOrdonneeLe: Date | null;
  /** Scan PDF de la note signée par le ministre (archives) : c'est lui qui clôture l'opération. */
  @Column({ type: 'varchar', nullable: true }) scanFichier: string | null;
  @Column({ type: 'varchar', nullable: true }) scanNom: string | null;
  @Column({ type: 'timestamptz', nullable: true }) scanLe: Date | null;
  @Column({ type: 'varchar', nullable: true }) scanPar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/** Avis de conformité d'un niveau (chef de bureau, chef de service, directeur) sur une note validée. */
export interface AvisConformite {
  niveau: 'BUREAU' | 'SERVICE' | 'DIRECTION';
  par: string;
  le: string;
  conforme: boolean;
  remarque: string | null;
}

/* ============================== Mutations ============================= */

/** Une étape du circuit d'une demande. */
export interface EtapeCircuit {
  /** EXTERNE (voie hiérarchique) ou INTERNE (DGRHAS). */
  phase: 'EXTERNE' | 'INTERNE';
  structureId: number | null;
  type: string;
  sigle: string;
  nom: string;
  /** Date d'arrivée du dossier à cette étape. */
  arriveeLe: string | null;
  visaPar: string | null;
  visaLe: string | null;
  avis: 'FAVORABLE' | 'REJET' | null;
  motivation: string | null;
  /** Avis porté sur le formulaire papier (cachet), recopié par la DGRHAS. */
  surPapier?: boolean;
  /** Étape franchie sans avis (structure absente, demande importée…). */
  sautee?: string | null;
}

@Entity('demande_mutation')
export class DemandeMutation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column() cle: string;
  @Column({ type: 'int' }) numeroEnregistrement: number;
  @Column({ type: 'date', nullable: true }) dateEnregistrement: string | null;
  @Column() nomComplet: string;
  @Column({ type: 'varchar', length: 1, default: 'M' }) genre: 'M' | 'F';
  @Column({ type: 'varchar', nullable: true }) grade: string | null;
  @Column({ type: 'int', nullable: true }) echelon: number | null;
  @Column({ type: 'varchar', nullable: true }) gradeBrut: string | null;
  @Column({ type: 'varchar', nullable: true }) matricule: string | null;
  @Column({ type: 'varchar', default: 'FONCTIONNAIRE' }) typeAgent:
    'FONCTIONNAIRE' | 'FINALISTE';
  @Column({ type: 'varchar', default: 'ENSEIGNANT' }) statutAgent:
    'ENSEIGNANT' | 'PERSONNEL_ADMINISTRATIF';
  @ManyToOne(() => Departement, { nullable: true, eager: true })
  @JoinColumn({ name: 'departementOrigineId' })
  departementOrigine: Departement | null;
  @Column({ type: 'int', nullable: true }) departementOrigineId: number | null;
  @Column({ type: 'varchar', nullable: true }) lieuService: string | null;
  @Column({ type: 'varchar', nullable: true }) cycle: string | null;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  @Column({ type: 'date', nullable: true }) datePriseService: string | null;
  @Column({ type: 'int', nullable: true }) dureeMois: number | null;
  @ManyToOne(() => Departement, { nullable: true, eager: true })
  @JoinColumn({ name: 'departementSolliciteId' })
  departementSollicite: Departement | null;
  @Column({ type: 'int', nullable: true }) departementSolliciteId:
    number | null;
  @Column({ type: 'varchar', nullable: true }) lieuSollicite: string | null;
  @Column() motif: string;
  @Column({ type: 'text', nullable: true }) justificatif: string | null;
  @Column({ type: 'varchar', nullable: true }) justificatifFichier:
    string | null;
  @Column({ type: 'uuid', nullable: true }) permutationAvecId: string | null;
  @Column({ type: 'text', nullable: true }) origine: string | null;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  @Column({ type: 'varchar', nullable: true }) avisDdeppsa:
    'FAVORABLE' | 'DEFAVORABLE' | null;
  @Column({ type: 'text', nullable: true }) avisDdeppsaCommentaire:
    string | null;
  @Column({ type: 'varchar', nullable: true }) avisDdeppsaPar: string | null;
  @Column({ type: 'varchar', nullable: true }) avisDgrhas:
    'FAVORABLE' | 'DEFAVORABLE' | null;
  @Column({ type: 'text', nullable: true }) avisDgrhasCommentaire:
    string | null;
  @Column({ type: 'varchar', nullable: true }) avisDgrhasPar: string | null;
  @Column({ type: 'varchar', nullable: true }) instructionMinistre:
    'ACCORDEE' | 'REFUSEE' | null;
  @Column({ type: 'text', nullable: true }) instructionCommentaire:
    string | null;
  @Column({ type: 'varchar', nullable: true }) instructionPar: string | null;
  /**
   * Rattachement à la base du personnel (DG, 31/10/2026) : MATRICULE, NOM (rattachée sûrement),
   * MANUEL (choisie), CREEE (fiche créée depuis la demande), A_VERIFIER (plusieurs fiches
   * possibles), INTROUVABLE, SANS_FICHE (laissée sans fiche). Jamais bloquant.
   */
  @Index() @Column({ type: 'varchar', nullable: true }) rattachement:
    string | null;
  @Column({ type: 'boolean', default: false }) retiree: boolean;
  @Column({ type: 'text', nullable: true }) motifRetrait: string | null;
  @Column({ type: 'uuid', nullable: true }) noteId: string | null;
  /* ----- Circuit d'approbation ----- */
  /** Type de prestation (catalogue) : mutation pour raisons de santé, permutation… */
  @Column({ type: 'varchar', nullable: true }) typePrestation: string | null;
  /** Objet de la demande (« Mutation à Brazzaville », « Congé administratif 2026 »). */
  @Column({ type: 'varchar', nullable: true }) objet: string | null;
  /** Période demandée (congé, autorisation d'absence…), reprise sur l'acte délivré. */
  @Column({ type: 'date', nullable: true }) dateDebut: string | null;
  @Column({ type: 'date', nullable: true }) dateFin: string | null;
  /** Fiche du personnel de l'agent (demande déposée par son chef, ou retrouvée). */
  @Index() @Column({ type: 'int', nullable: true }) agentId: number | null;
  /** PORTAIL (faite par l'agent en ligne), SAISIE (dossier papier saisi), IMPORT (fichier Excel). */
  @Column({ type: 'varchar', default: 'SAISIE' }) canal: string;
  /** Structure où travaille l'agent (point de départ du circuit). */
  @Column({ type: 'int', nullable: true }) structureOrigineId: number | null;
  /** Établissement écrit par l'agent s'il n'est pas dans la liste. */
  @Column({ type: 'varchar', nullable: true }) structureOrigineTexte:
    string | null;
  /** Téléphone laissé par l'agent pour être joint (portail). */
  @Column({ type: 'varchar', nullable: true }) telephone: string | null;
  /** Code de suivi donné à l'agent (portail), avec le n° d'enregistrement. */
  @Column({ type: 'varchar', nullable: true, select: false }) codeSuivi:
    string | null;
  /** Étapes du circuit : visa, avis (FAVORABLE ou REJET), motivation, dates. */
  @Column({ type: 'jsonb', nullable: true }) circuit: EtapeCircuit[] | null;
  /** Étape en cours (index dans le circuit) ; null quand la décision est prise. */
  @Column({ type: 'int', nullable: true }) etapeCourante: number | null;
  /** Qui décide : DDEPPSA (mutation dans le département) ou DGRHAS. */
  @Column({ type: 'varchar', nullable: true }) decideur: string | null;
  /** ACCORDEE, REJETEE ou EN_INSTANCE. */
  @Column({ type: 'varchar', nullable: true }) decision: string | null;
  @Column({ type: 'text', nullable: true }) decisionMotivation: string | null;
  @Column({ type: 'varchar', nullable: true }) decisionPar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decisionLe: Date | null;
  /** Dossier accordé confié au secrétariat du DG pour imprimer la fiche et les pièces jointes. */
  @Column({ type: 'timestamptz', nullable: true })
  envoyeSecretariatLe: Date | null;
  @Column({ type: 'varchar', nullable: true }) envoyeSecretariatPar:
    string | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) anomalies: string[];
  @Column({ type: 'varchar', nullable: true }) saisiePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/* ============================== Pilotage ============================== */

/** Enveloppe accordée par la Fonction Publique pour un quota (ou le quota « Autres »). */
@Entity('enveloppe')
export class Enveloppe {
  /** Année du quota (« 2026 ») ou « AUTRES ». */
  @PrimaryColumn() perimetre: string;
  /** Incidence annuelle autorisée (masse salariale), en FCFA. */
  @Column({ type: 'bigint', default: 0 }) montantAnnuel: string;
  @Column({ type: 'int', nullable: true }) placesCatI: number | null;
  @Column({ type: 'int', nullable: true }) placesCatII: number | null;
  @Column({ type: 'int', nullable: true }) placesCatIII: number | null;
  @Column({ type: 'varchar', nullable: true }) modifiePar: string | null;
  @UpdateDateColumn() modifieLe: Date;
}

/** Membre de la commission de recrutement et nombre de dossiers qu'il peut apporter (par quota). */
@Entity('membre_commission')
export class MembreCommission {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'int' }) quota: number;
  @Column() nom: string;
  @Column({ type: 'varchar', nullable: true }) fonction: string | null;
  @Column({ type: 'int', default: 0 }) places: number;
  @Column({ type: 'varchar', nullable: true }) modifiePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/**
 * Deux fiches déclarées « deux personnes différentes » (DG, 31/10/2026) : la paire n'est plus
 * proposée comme doublon probable. `a` < `b` (identifiants en texte) ; `base` : RECRUTES,
 * PERSONNEL, VOLONTAIRES, ENROLES.
 */
@Entity('doublon_distinct')
@Index(['base', 'a', 'b'], { unique: true })
export class DoublonDistinct {
  @PrimaryGeneratedColumn() id: number;
  @Column() base: string;
  @Column() a: string;
  @Column() b: string;
  @Column({ type: 'text', nullable: true }) motif: string | null;
  @Column({ type: 'varchar', nullable: true }) par: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** Répartition automatique du quota « Autres » sans département, validée par le DG. */
@Entity('repartition')
export class Repartition {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** Nombre de personnes demandé par département (id -> nombre). */
  @Column({ type: 'jsonb' }) quotas: Record<string, number>;
  @Column({ type: 'int' }) personnes: number;
  @Column({ type: 'varchar', nullable: true }) validePar: string | null;
  @Column({ type: 'boolean', default: false }) annulee: boolean;
  @CreateDateColumn() creeLe: Date;
}

/**
 * Bénéficiaire du quota (structure qui reçoit des places : ministre, syndicats, commission,
 * directions…). À ne pas confondre avec l'origine d'un dossier (qui l'a apporté).
 */
@Entity('beneficiaire')
export class Beneficiaire {
  @PrimaryGeneratedColumn() id: number;
  @Index({ unique: true }) @Column() nom: string;
  @Column({ type: 'int', default: 0 }) ordre: number;
  @Column({ type: 'boolean', default: true }) actif: boolean;
  /** La commission de recrutement : ses places se répartissent entre ses membres. */
  @Column({ type: 'boolean', default: false }) commission: boolean;
}

/** Places du quota réajusté par le DG : un bénéficiaire, un cycle, un nombre de places. */
@Entity('place_beneficiaire')
export class PlaceBeneficiaire {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() perimetre: string;
  @Column({ type: 'int' }) beneficiaireId: number;
  @Column() cycle: string;
  @Column({ type: 'int' }) places: number;
}

/* ===================== Circuits d'approbation des demandes ===================== */

/**
 * Structure de l'organigramme : établissement, inspection, DDEPPSA (départements scolaires),
 * service, direction centrale, direction générale (administration centrale), et les
 * bureaux, services et directions internes de la DGRHAS.
 */
@Entity('structure')
export class Structure {
  @PrimaryGeneratedColumn() id: number;
  /** MINISTERE, CABINET, DIRECTION_GENERALE, INSPECTION_GENERALE, ORGANISME_TUTELLE, DIRECTION_CENTRALE, SERVICE, BUREAU, DDEPPSA, INSPECTION, ETABLISSEMENT ; et la DGRHAS (DGRHAS, DIRECTION_DGRHAS, SERVICE_DGRHAS, BUREAU_DGRHAS). Niveau : TYPES_STRUCTURE. */
  @Index() @Column() type: string;
  @Column() nom: string;
  @Index() @Column() sigle: string;
  /** Code de la structure dans le référentiel (« PRI-HBI », « INS-DOLISIE-1 ») : il ne change pas. */
  @Index() @Column({ type: 'varchar', nullable: true }) code: string | null;
  /** Structure au-dessus (l'inspection d'une école, le DDEPPSA d'une inspection…). */
  @Index() @Column({ type: 'int', nullable: true }) parentId: number | null;
  @Column({ type: 'int', nullable: true }) departementId: number | null;
  /** Cycle d'une inspection ou d'une école : PRESCOLAIRE, PRIMAIRE, COLLEGE, LYCEE, ALPHABETISATION. */
  @Column({ type: 'varchar', nullable: true }) cycle: string | null;
  /**
   * Localisation physique (DG, 23/10/2026) : district en zone rurale, commune ou arrondissement en
   * ville ; on s'arrête là (ni village ni quartier).
   */
  @Column({ type: 'varchar', nullable: true }) typeLocalite: string | null;
  @Column({ type: 'varchar', nullable: true }) localite: string | null;
  /** Responsable en poste (fiche du personnel) : le proviseur, le chef de service… Vide : poste vacant. */
  @Column({ type: 'int', nullable: true }) responsableId: number | null;
  /** Le responsable n'assure qu'un intérim. */
  @Column({ type: 'boolean', default: false }) responsableInterim: boolean;
  /**
   * Emploi du temps propre à l'école (DG, 28/10/2026) : jours de cours, créneaux de la journée,
   * heures d'un enseignant par semaine. Vide : les réglages généraux (Administration › Paramètres).
   */
  @Column({ type: 'jsonb', nullable: true }) reglagesEdt: {
    jours?: number[];
    creneaux?: string;
    heuresEnseignant?: number;
  } | null;
  @Column({ type: 'boolean', default: true }) actif: boolean;
  /** Rang parmi les structures du même niveau (flèches « monter / descendre »). */
  @Column({ type: 'int', default: 0 }) ordre: number;
  @CreateDateColumn() creeLe: Date;
}

/**
 * Valeur d'un référentiel (Administration › Référentiels) : localités, cycles, niveaux, matières,
 * programmes (heures et coefficient par niveau et matière), postes, types de bâtiments et de salles…
 * Les listes servent aux champs « à choisir » de l'application (une autre valeur reste possible).
 */
@Entity('referentiel')
@Index(['type', 'code'], { unique: true })
export class Referentiel {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() type: string;
  @Column() code: string;
  @Column() libelle: string;
  @Index() @Column() libelleNormalise: string;
  /** Rattachement : cycle d'un niveau ou d'une matière, département d'une localité… */
  @Index() @Column({ type: 'varchar', nullable: true }) parent: string | null;
  @Index() @Column({ type: 'int', nullable: true }) departementId:
    number | null;
  /** Valeurs propres au type (heures et coefficient d'un programme, âge de retraite d'une catégorie…). */
  @Column({ type: 'jsonb', default: () => "'{}'" }) donnees: Record<
    string,
    unknown
  >;
  @Column({ type: 'boolean', default: true }) actif: boolean;
  @Column({ type: 'int', default: 0 }) ordre: number;
  /** SAISIE (ajouté dans l'application) ou ANCIEN_SYSTEME (repris de l'ancien SGRH). */
  @Column({ type: 'varchar', default: 'SAISIE' }) source: string;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/** Type de prestation (catalogue des circuits d'approbation) : mutation, congé, attestation… */
@Entity('type_prestation')
export class TypePrestation {
  @PrimaryColumn() code: string;
  /** N° dans le document « Circuits d'approbation des demandes de prestation ». */
  @Column({ type: 'int' }) numero: number;
  @Column() libelle: string;
  /** Acte délivré : note de service, attestation, certificat… */
  @Column({ type: 'varchar', nullable: true }) acte: string | null;
  /** Pièces jointes exigées (cases à cocher dans le formulaire). */
  @Column({ type: 'jsonb', default: () => "'[]'" }) pieces: string[];
  /** Le circuit passe-t-il par la voie hiérarchique hors DGRHAS (inspection, DDEPPSA…) ? */
  @Column({ type: 'boolean', default: true }) circuitExterne: boolean;
  /** Étapes internes à la DGRHAS, dans l'ordre (sigles : « BMP », « SR », « DRSC », « DGRHAS »). */
  @Column({ type: 'jsonb', default: () => "'[]'" }) etapesInternes: string[];
  /** LIEU_SERVICE, DDEPPSA, DGRHAS, PREMIER_MINISTRE (la décision du Ministre est sa signature). */
  @Column({ default: 'DGRHAS' }) decision: string;
  /** Texte du niveau de décision, tel que dans le document (ex. « DGRHAS-Ministre »). */
  @Column({ type: 'varchar', nullable: true }) decisionTexte: string | null;
  /** Motif de mutation correspondant (types de mutation seulement). */
  @Column({ type: 'varchar', nullable: true }) motifMutation: string | null;
  /** Ouvert aux demandes (au départ : les mutations seulement). */
  @Column({ type: 'boolean', default: false }) actif: boolean;
  @Column({ type: 'int', default: 0 }) ordre: number;
}

/** Pièce jointe d'une demande de mutation (demande manuscrite scannée, pièces justificatives). */
@Entity('piece_demande')
export class PieceDemande {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) demandeId: string;
  /** Pièce exigée à laquelle répond le fichier (« Dossier médical »…), ou « Autre pièce ». */
  @Column() libelle: string;
  @Column() nomOrigine: string;
  @Column() fichier: string;
  @Column() mime: string;
  @Column({ type: 'int' }) taille: number;
  @Column({ type: 'varchar', nullable: true }) ajoutePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** Alerte d'une demande : envoyée aux structures du circuit (et lue par chacun). */
@Entity('alerte')
export class Alerte {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'uuid' }) demandeId: string;
  /** NOUVELLE, A_TRAITER, INSTRUCTION, DECISION */
  @Column() type: string;
  @Column({ type: 'text' }) texte: string;
  /** Structures destinataires (leurs comptes voient l'alerte). */
  @Column({ type: 'jsonb', default: () => "'[]'" }) structures: number[];
  @Index() @CreateDateColumn() creeLe: Date;
}

@Entity('alerte_lue')
export class AlerteLue {
  @PrimaryColumn({ type: 'int' }) alerteId: number;
  @PrimaryColumn({ type: 'uuid' }) utilisateurId: string;
  @CreateDateColumn() lueLe: Date;
}

/** Instruction d'un supérieur à l'étape en cours : « à traiter en urgence, pour demain »… */
@Entity('instruction_demande')
export class InstructionDemande {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'uuid' }) demandeId: string;
  /** Étape (index dans le circuit) à qui elle s'adresse. */
  @Column({ type: 'int' }) etape: number;
  @Column({ type: 'text' }) texte: string;
  @Column({ type: 'date', nullable: true }) echeance: string | null;
  @Column({ type: 'varchar', nullable: true }) par: string | null;
  @Column({ type: 'varchar', nullable: true }) parStructure: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** Origine possible d'un dossier (liste tenue par le DG) : « Cabinet du Ministre », « Primature »… */
@Entity('origine_dossier')
export class OrigineDossier {
  @PrimaryGeneratedColumn() id: number;
  @Index({ unique: true }) @Column() libelle: string;
  @Column({ type: 'int', default: 0 }) ordre: number;
  @Column({ type: 'boolean', default: true }) actif: boolean;
  /** Bénéficiaire du quota dont l'origine consomme les places (ex. « CSECC » → Syndicats). */
  @Column({ type: 'int', nullable: true }) beneficiaireId: number | null;
}

/**
 * Personne recrutée une année précédente (compilations 2019-2023, listes de volontaires…),
 * importée seulement pour repérer les doublons d'une année à l'autre.
 */
@Entity('ancien_recrute')
export class AncienRecrute {
  @PrimaryGeneratedColumn() id: number;
  @Column() nomComplet: string;
  @Index() @Column() nomNormalise: string;
  @Column({ type: 'date', nullable: true }) dateNaissance: string | null;
  @Column({ type: 'int', nullable: true }) annee: number | null;
  /** Nom du fichier (et de la feuille) d'où vient la ligne. */
  @Index() @Column() source: string;
  @Column({ type: 'varchar', nullable: true }) diplome: string | null;
  @Column({ type: 'varchar', nullable: true }) importePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** Pièce jointe d'un dossier : scan du texte de la FP (légalisé ou non). */
@Entity('piece_jointe')
export class PieceJointe {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) agentId: string;
  /** TEXTE : arrêté ou décret scanné ; AUTRE : autre pièce du dossier. */
  @Column({ type: 'varchar', default: 'TEXTE' }) nature: string;
  @Column({ type: 'boolean', default: false }) legalise: boolean;
  /** Nom d'origine du fichier ; le fichier est rangé sous un nom neutre (uuid). */
  @Column() nomOrigine: string;
  @Column() fichier: string;
  @Column({ type: 'varchar' }) mime: string;
  @Column({ type: 'int' }) taille: number;
  @Column({ type: 'varchar', nullable: true }) ajoutePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/**
 * Note d'affectation où une personne figure, connue hors du système : notes signées sur
 * papier, reprises du fichier « Contrôle des affectations » (colonnes « Ref affectation »).
 * Sert à ne pas l'affecter une deuxième fois et à repérer les doubles affectations.
 */
@Entity('reference_note')
@Index(['agentId', 'brut'], { unique: true })
export class ReferenceNote {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) agentId: string;
  /** Tel qu'écrit dans le fichier : « 270 du 08/04/2026 BZ ». */
  @Column() brut: string;
  /** N° de la note (« 270 »), si lisible. */
  @Index() @Column({ type: 'varchar', nullable: true }) numero: string | null;
  @Column({ type: 'date', nullable: true }) date: string | null;
  @Column({ type: 'varchar', nullable: true }) lieuAffectation: string | null;
  @Column({ type: 'varchar', nullable: true }) service: string | null;
  @Column({ type: 'varchar', nullable: true }) lieuService: string | null;
  /** Fichier d'où vient la référence (réimporter le même fichier remplace ses références). */
  @Index() @Column() source: string;
  @Column({ type: 'varchar', nullable: true }) importePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/* ========================= Enrôlement des volontaires ========================= */

/**
 * Campagne d'enrôlement (ex. « Enrôlement 2026 ») : les finalistes des écoles professionnelles
 * deviennent enseignants volontaires (bourse, contrat de 5 ans). Le quota est fixé par la DGRHAS.
 * Rien ne part à la Fonction Publique : tout se décide ici, jusqu'à la note de service.
 */
@Entity('campagne_enrolement')
export class CampagneEnrolement {
  @PrimaryGeneratedColumn() id: number;
  @Index({ unique: true }) @Column({ type: 'int' }) annee: number;
  /** Année scolaire proposée pour les notes (ex. « 2026-2027 »). */
  @Column() anneeScolaire: string;
  /** Nombre de volontaires à retenir (0 : pas encore fixé) ; somme des places par cycle quand elles sont fixées. */
  @Column({ type: 'int', default: 0 }) quota: number;
  /** Enveloppe de bourses de la campagne, en FCFA (0 : pas fixée) : on ne peut pas la dépasser. */
  @Column({ type: 'bigint', default: 0 }) enveloppe: string;
  /** Places prévues par cycle (Préscolaire, Primaire, Collège, Lycée, Administration). */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  placesParCycle: Record<string, number>;
  /** Bourse versée à chaque volontaire, selon son cycle, en FCFA. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  montantsParCycle: Record<string, number>;
  @Column({ type: 'boolean', default: true }) ouverte: boolean;
  @Column({ type: 'varchar', nullable: true }) observation: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** Membre de la commission d'une campagne d'enrôlement, avec ses places. */
@Entity('membre_enrolement')
export class MembreEnrolement {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'int' }) campagneId: number;
  @Column() nom: string;
  @Column({ type: 'varchar', nullable: true }) fonction: string | null;
  @Column({ type: 'int', default: 0 }) places: number;
  @CreateDateColumn() creeLe: Date;
}

/** Candidat à l'enrôlement (finaliste) : saisi, contrôlé, puis retenu ou non par la DGRHAS. */
@Entity('enrole')
export class Enrole {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'int' }) campagneId: number;
  @Column() nomComplet: string;
  @Index() @Column() nomNormalise: string;
  @Column({ type: 'date', nullable: true }) dateNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) lieuNaissance: string | null;
  /** BET, CFEEN, DEMA, DCAF, LICENCE, MASTER, AUTRE */
  @Column() diplome: string;
  @Column({ type: 'varchar', nullable: true }) diplomePrecision: string | null;
  /** Année de sortie de l'école. */
  @Column({ type: 'varchar', nullable: true }) promotion: string | null;
  @Column({ type: 'varchar', nullable: true }) cycle: string | null;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  /** Trois départements souhaités, dans l'ordre. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  departementsSouhaites: number[];
  @Column({ type: 'int', nullable: true }) departementRetenuId: number | null;
  @Column({ type: 'varchar', nullable: true }) etablissement: string | null;
  @Column({ type: 'varchar', nullable: true }) telephone: string | null;
  @Column({ type: 'varchar', nullable: true }) origineBrute: string | null;
  @Column({ type: 'uuid', nullable: true }) membreId: string | null;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  /** A_CONTROLER → CONTROLE (à décider par la DGRHAS) → RETENU / NON_RETENU */
  @Index() @Column({ default: 'A_CONTROLER' }) etat: string;
  @Column({ type: 'text', nullable: true }) remarqueControle: string | null;
  @Column({ type: 'text', nullable: true }) motifDecision: string | null;
  @Column({ type: 'varchar', nullable: true }) saisiePar: string | null;
  @Column({ type: 'varchar', nullable: true }) controlePar: string | null;
  @Column({ type: 'varchar', nullable: true }) decidePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decideLe: Date | null;
  /** Note de service validée où figure le volontaire. */
  @Index() @Column({ type: 'uuid', nullable: true }) noteId: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/* ===================== Volontaires en poste et bourse ===================== */

/**
 * Volontaire en poste (ou sorti) : le registre qui sert à payer la bourse chaque mois.
 * Il vient d'une note d'enrôlement signée, ou de la reprise des listes de bourse existantes.
 */
@Entity('volontaire')
export class Volontaire {
  @PrimaryGeneratedColumn('uuid') id: string;
  /**
   * VOLONTAIRE (finaliste enrôlé, payé en bourse) ou COMMUNAUTAIRE (recruté autrefois par une école,
   * payé sur la liste des communautaires) : même registre, mêmes contrôles, états de paiement séparés.
   */
  @Index()
  @Column({ type: 'varchar', default: 'VOLONTAIRE' })
  population: string;
  /** Numéro de la vague (1re = 2019-2020…), tiré de la vague écrite ou de l'année d'enrôlement. */
  @Column({ type: 'int', nullable: true }) vagueNumero: number | null;
  @Column() nomComplet: string;
  @Index() @Column() nomNormalise: string;
  @Column({ type: 'date', nullable: true }) dateNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) lieuNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) telephone: string | null;
  @Column({ type: 'varchar', nullable: true }) diplome: string | null;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  /** Catégorie de bourse (configuration de l'enrôlement) : fixe le montant mensuel. */
  @Index() @Column({ type: 'varchar', nullable: true }) categorie:
    string | null;
  /** Texte d'origine du cycle (« 3-Beaux-Arts/DEMA ») quand il vient d'un fichier. */
  @Column({ type: 'varchar', nullable: true }) cycleBrut: string | null;
  @Index() @Column({ type: 'int', nullable: true }) departementId:
    number | null;
  @Column({ type: 'varchar', nullable: true }) departementBrut: string | null;
  @Column({ type: 'varchar', nullable: true }) etablissement: string | null;
  /** Vague ou campagne d'arrivée (« 2018-2019 », « 7e vague », « Enrôlement 2026 »). */
  @Column({ type: 'varchar', nullable: true }) vague: string | null;
  /** Note de service d'affectation (« n° 1006 du 29/09/2026 »). */
  @Column({ type: 'varchar', nullable: true }) noteReference: string | null;
  @Column({ type: 'date', nullable: true }) dateNote: string | null;
  @Column({ type: 'date', nullable: true }) datePriseService: string | null;
  /** Premier mois payé imposé (« 2026-09 ») : volontaires repris d'une bourse déjà versée. */
  @Column({ type: 'varchar', length: 7, nullable: true }) premierMois:
    string | null;
  /** EN_POSTE ou SORTI. */
  @Index() @Column({ default: 'EN_POSTE' }) statut: string;
  @Column({ type: 'varchar', nullable: true }) motifSortie: string | null;
  @Column({ type: 'date', nullable: true }) dateSortie: string | null;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  /** D'où vient la fiche (« Bourse Septembre 2026.xlsx · Liste générale (3) · ligne 309 »). */
  @Column({ type: 'varchar', nullable: true }) source: string | null;
  @Index() @Column({ type: 'uuid', nullable: true }) enroleId: string | null;
  /** Contrôles vérifiés à la main (« pas la même personne ») : ils ne bloquent plus la bourse. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  verifications: Record<string, { par: string; le: string; note: string }>;
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/** Ce qui arrive à un volontaire : entrée, sortie, réintégration, modification. */
@Entity('mouvement_volontaire')
export class MouvementVolontaire {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'uuid' }) volontaireId: string;
  @Column() type: string;
  /** Date d'effet (sortie, réintégration…). */
  @Column({ type: 'date', nullable: true }) dateEffet: string | null;
  @Column({ type: 'varchar', nullable: true }) motif: string | null;
  @Column({ type: 'jsonb', nullable: true }) details: object | null;
  @Column({ type: 'varchar', nullable: true }) par: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** État de la bourse d'un mois : préparé, contrôlé, puis validé (figé). */
@Entity('etat_bourse')
@Index(['mois', 'population'], { unique: true })
export class EtatBourse {
  @PrimaryGeneratedColumn() id: number;
  /** « 2026-10 » */
  @Column({ type: 'varchar', length: 7 }) mois: string;
  /** Liste payée : VOLONTAIRE (bourse) ou COMMUNAUTAIRE (un état par mois pour chacune). */
  @Column({ type: 'varchar', default: 'VOLONTAIRE' }) population: string;
  /** BROUILLON ou VALIDE */
  @Column({ default: 'BROUILLON' }) statut: string;
  @Column({ type: 'int', default: 0 }) effectif: number;
  @Column({ type: 'bigint', default: 0 }) total: string;
  /** Contrôles du dernier calcul : bloquants et signalés. */
  @Column({ type: 'jsonb', default: () => "'[]'" }) anomalies: object[];
  @Column({ type: 'varchar', nullable: true }) preparePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) calculeLe: Date | null;
  @Column({ type: 'varchar', nullable: true }) validePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) valideLe: Date | null;
  @CreateDateColumn() creeLe: Date;
}

/** Ligne d'un état de bourse : figée à la validation (nom, catégorie, montant du moment). */
@Entity('ligne_bourse')
export class LigneBourse {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) etatId: number;
  @Index() @Column({ type: 'uuid' }) volontaireId: string;
  @Column() nomComplet: string;
  @Column({ type: 'varchar', nullable: true }) categorie: string | null;
  @Column({ type: 'int', nullable: true }) departementId: number | null;
  @Column({ type: 'varchar', nullable: true }) etablissement: string | null;
  @Column({ type: 'varchar', nullable: true }) vague: string | null;
  @Column({ type: 'varchar', nullable: true }) telephone: string | null;
  /** Bourse mensuelle appliquée. */
  @Column({ type: 'int' }) montant: number;
  /** Nombre de mois payés (plus d'un : rappel de mois dus). */
  @Column({ type: 'int', default: 1 }) mois: number;
  /** Mois couverts (du premier au dernier, « AAAA-MM ») : base des trop-perçus. */
  @Column({ type: 'varchar', length: 7, nullable: true }) du: string | null;
  @Column({ type: 'varchar', length: 7, nullable: true }) au: string | null;
  /** Compléments (+) et retenues (−) appliqués sur cette ligne. */
  @Column({ type: 'int', default: 0 }) regularisation: number;
  @Column({ type: 'jsonb', nullable: true }) regularisations:
    { id: number; montant: number }[] | null;
  /** Montant à payer : bourse × mois + régularisation. */
  @Column({ type: 'int' }) total: number;
  @Column({ type: 'varchar', nullable: true }) observation: string | null;
}

/**
 * Régularisation d'un volontaire : complément (somme due) ou retenue (trop-perçu),
 * imputée sur les prochaines bourses. Une retenue sur un sortant reste « à recouvrer ».
 */
@Entity('regularisation')
export class Regularisation {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'uuid' }) volontaireId: string;
  /** COMPLEMENT ou RETENUE */
  @Column() type: string;
  @Column({ type: 'int' }) montant: number;
  /** Ce qui reste à verser (complément) ou à retenir (retenue). */
  @Column({ type: 'int' }) reste: number;
  @Column({ type: 'text' }) motif: string;
  /** MANUEL, TROP_PERCU_BOURSE, DOUBLE_MISE_EN_ROUTE… */
  @Index() @Column({ default: 'MANUEL' }) origine: string;
  /** EN_ATTENTE, SOLDEE ou ANNULEE */
  @Index() @Column({ default: 'EN_ATTENTE' }) statut: string;
  /** Imputations sur les états de bourse validés. */
  @Column({ type: 'jsonb', default: () => "'[]'" }) applications: {
    etatId: number;
    mois: string;
    montant: number;
  }[];
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @Column({ type: 'varchar', nullable: true }) annulePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** État de mise en route (équipement et transport versés une fois), par note de service. */
@Entity('mise_en_route')
export class MiseEnRoute {
  @PrimaryGeneratedColumn() id: number;
  @Column() libelle: string;
  @Index() @Column({ type: 'varchar', nullable: true }) noteReference:
    string | null;
  /** BROUILLON ou VALIDE */
  @Column({ default: 'BROUILLON' }) statut: string;
  /** CALCUL (préparé ici) ou REPRISE (fiche déjà payée, importée) */
  @Column({ default: 'CALCUL' }) source: string;
  @Column({ type: 'int', default: 0 }) effectif: number;
  @Column({ type: 'bigint', default: 0 }) total: string;
  @Column({ type: 'jsonb', default: () => "'[]'" }) anomalies: object[];
  @Column({ type: 'varchar', nullable: true }) preparePar: string | null;
  @Column({ type: 'varchar', nullable: true }) validePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) valideLe: Date | null;
  @CreateDateColumn() creeLe: Date;
}

@Entity('ligne_mise_en_route')
export class LigneMiseEnRoute {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) miseEnRouteId: number;
  /** Vide : personne d'une fiche reprise qui n'est pas (encore) dans le registre. */
  @Index() @Column({ type: 'uuid', nullable: true }) volontaireId:
    string | null;
  @Column() nomComplet: string;
  @Column({ type: 'date', nullable: true }) dateNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) lieuNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) categorie: string | null;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  @Column({ type: 'int', nullable: true }) departementId: number | null;
  @Column({ type: 'varchar', nullable: true }) etablissement: string | null;
  @Column({ type: 'varchar', nullable: true }) telephone: string | null;
  @Column({ type: 'int', default: 0 }) equipement: number;
  @Column({ type: 'int', default: 0 }) billet: number;
  @Column({ type: 'int', default: 0 }) bagages: number;
  @Column({ type: 'int', default: 0 }) total: number;
  @Column({ type: 'varchar', nullable: true }) observation: string | null;
}

/**
 * Ligne du bottin de la solde : un agent payé un mois donné (fourni chaque mois par la solde).
 * Le premier salaire d'un volontaire s'y voit : c'est là, et pas au texte de la FP, que sa bourse s'arrête.
 */
@Entity('ligne_bottin')
export class LigneBottin {
  @PrimaryGeneratedColumn() id: number;
  /** Mois payé (« 2026-10 »). */
  @Index() @Column({ type: 'varchar', length: 7 }) mois: string;
  @Index() @Column({ type: 'varchar', nullable: true }) matricule:
    string | null;
  @Column() nomComplet: string;
  @Index() @Column() nomNormalise: string;
  @Column({ type: 'date', nullable: true }) dateNaissance: string | null;
  @Column({ type: 'varchar', nullable: true }) departement: string | null;
  @Column({ type: 'varchar', nullable: true }) grade: string | null;
  @Column({ type: 'int', nullable: true }) indice: number | null;
  @Column({ type: 'int', nullable: true }) brut: number | null;
  @Column({ type: 'varchar', nullable: true }) banque: string | null;
  /** Fichier et ligne d'origine. */
  @Column({ type: 'varchar', nullable: true }) source: string | null;
  @Column({ type: 'varchar', nullable: true }) importePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/** Besoin en enseignants volontaires d'un établissement (exprimé par la DDEPPSA). */
@Entity('besoin_etablissement')
export class BesoinEtablissement {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) departementId: number;
  @Column() etablissement: string;
  @Index() @Column() etablissementNormalise: string;
  @Column() categorie: string;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  @Column({ type: 'int' }) nombre: number;
  @Column({ type: 'varchar', nullable: true }) anneeScolaire: string | null;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/* ============================ Recensement du personnel ============================ */

/** Un statut de l'agent dans son parcours : depuis quand, et par quel texte (intégration, note…). */
export interface EtapeStatut {
  statut: string;
  /** Date d'effet (texte d'intégration, prise de service…) ; vide si inconnue. */
  depuis: string | null;
  texte: string | null;
  par: string | null;
  le: string;
}

export interface ContentieuxAgent {
  /**
   * EN_COURS (à contrôler par le bureau du contrôle), CONTROLE (contrôlé : à décider par le DG),
   * CONFIRME (l'agent existe : il entre dans la base) ou REJETE.
   */
  etat: 'EN_COURS' | 'CONTROLE' | 'CONFIRME' | 'REJETE';
  motif: string;
  ouvertPar: string | null;
  ouvertLe: string;
  /** Avis du bureau du contrôle, avant la décision du DG. */
  avisControle?: 'FAVORABLE' | 'DEFAVORABLE' | null;
  noteControle?: string | null;
  controlePar?: string | null;
  controleLe?: string | null;
  decidePar?: string | null;
  decideLe?: string | null;
  note?: string | null;
}

/**
 * Agent recensé : fiche de renseignements du personnel (fonctionnaire, contractuel, volontaire,
 * communautaire…). Les rubriques sont celles de la configuration du recensement : leurs valeurs
 * sont gardées dans `donnees` ; les plus utiles (nom, naissance, département…) sont recopiées
 * en colonnes pour la recherche, les doublons et le périmètre des comptes.
 */
/**
 * Modification d'une fiche faite au recensement (DG, 30/10/2026) : comme un agent ajouté, elle passe
 * au contrôle. Elle s'applique tout de suite ; le contrôle la valide, ou la rejette et la fiche
 * reprend ses anciennes valeurs. `champs` : pour chaque rubrique, l'ancienne et la nouvelle valeur
 * (`TYPE_AGENT` : le type d'agent ; `STRUCTURE` : l'établissement de rattachement).
 */
@Entity('modification_recensement')
export class ModificationRecensement {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) agentId: number;
  @Column({ type: 'jsonb' }) champs: Record<
    string,
    { avant: unknown; apres: unknown }
  >;
  /** A_CONTROLER, VALIDEE, REJETEE */
  @Index() @Column({ type: 'varchar', default: 'A_CONTROLER' }) etat: string;
  @Column({ type: 'varchar', nullable: true }) faitePar: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) faiteLe: Date;
  @Column({ type: 'varchar', nullable: true }) controlePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) controleLe: Date | null;
  @Column({ type: 'text', nullable: true }) note: string | null;
}

@Entity('agent_recense')
export class AgentRecense {
  @PrimaryGeneratedColumn() id: number;
  /** N° de fiche donné automatiquement (REC-000123). */
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  numeroFiche: string | null;
  /** Type d'agent (code de la configuration : FONCTIONNAIRE, VOLONTAIRE…). */
  @Index() @Column() statut: string;
  @Column() nomComplet: string;
  @Index() @Column() nomNormalise: string;
  @Column({ type: 'date', nullable: true }) dateNaissance: string | null;
  @Index()
  @Column({ type: 'varchar', nullable: true })
  matricule: string | null;
  @Column({ type: 'varchar', nullable: true }) telephone: string | null;
  @Index()
  @Column({ type: 'int', nullable: true })
  departementId: number | null;
  /** Établissement ou structure de rattachement (organigramme) : périmètre des comptes de structure. */
  @Index()
  @Column({ type: 'int', nullable: true })
  structureId: number | null;
  /** Valeurs des rubriques, par code de rubrique. */
  /** Volontaire du registre (enrôlement, bourse) dont c'est la fiche du personnel. */
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  volontaireId: string | null;
  /** Dernières valeurs reçues d'un autre module (registre des volontaires…) : une rubrique les suit tant qu'elle n'a pas été corrigée. */
  @Column({ type: 'jsonb', default: {} }) liaison: Record<string, unknown>;
  @Column({ type: 'jsonb', default: {} }) donnees: Record<string, unknown>;
  /** Ce qui manque ou est à vérifier, recalculé à chaque enregistrement et à chaque changement de la configuration. */
  @Column({ type: 'jsonb', default: {} }) manques: {
    champs?: string[];
    pieces?: { code: string; manque: number }[];
    aVerifier?: string[];
  };
  /** Part des éléments exigés qui sont fournis (0 à 100). */
  @Column({ type: 'int', default: 0 }) taux: number;
  @Index() @Column({ type: 'boolean', default: false }) complet: boolean;
  /**
   * Statuts successifs de la même personne (volontaire, puis fonctionnaire au texte d'intégration…),
   * du plus ancien au plus récent. Vide : fiche antérieure à l'historique (seul le statut actuel est connu).
   */
  @Column({ type: 'jsonb', default: () => "'[]'" }) parcours: EtapeStatut[];
  /** Agent rencontré au recensement mais absent des bases : à vérifier par la DGRHAS, décidé par le DG. */
  @Column({ type: 'jsonb', nullable: true })
  contentieux: ContentieuxAgent | null;
  /** Fiches déclarées « une autre personne » (homonymes vérifiés) : plus proposées à la fusion. */
  @Column({ type: 'jsonb', default: () => "'[]'" }) distinctes: number[];
  /** SAISIE (fiche à l'écran), IMPORT (fichier Excel) ou ENROLEMENT (registre des volontaires). */
  @Column({ type: 'varchar', default: 'SAISIE' }) source: string;
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @Column({ type: 'varchar', nullable: true }) modifiePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/** Pièce justificative scannée d'un agent recensé (acte de naissance, CNI, bulletin de solde…). */
@Entity('piece_recensement')
@Index(['agentId', 'type'])
export class PieceRecensement {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'int' }) agentId: number;
  /** Code de la pièce dans la configuration (ACTE_NAISSANCE, CNI…). */
  @Column() type: string;
  @Column() nomOrigine: string;
  @Column() fichier: string;
  @Column({ type: 'varchar' }) mime: string;
  @Column({ type: 'int' }) taille: number;
  /**
   * Ligne du tableau que la pièce concerne (1 = le premier enfant) : l'acte de naissance déposé
   * devant un enfant reste le sien (DG, 24/10/2026). Vide : pièce de l'agent.
   */
  @Column({ type: 'int', nullable: true }) ligne: number | null;
  @Column({ type: 'varchar', nullable: true }) ajoutePar: string | null;
  @CreateDateColumn() creeLe: Date;
}

/**
 * Événement de carrière d'un agent (avancement, reclassement, nomination, position, sortie…),
 * avec son acte. Avec les statuts successifs, les affectations et les mutations, il forme le
 * dossier de carrière. Les rubriques qu'il change dans la fiche y sont reportées s'il est le plus
 * récent ; `avant` garde leurs valeurs précédentes pour pouvoir l'annuler.
 */
@Entity('evenement_carriere')
export class EvenementCarriere {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'int' }) agentId: number;
  /** AVANCEMENT_ECHELON, AVANCEMENT_GRADE, RECLASSEMENT, NOMINATION… */
  @Column() type: string;
  @Column({ type: 'date', nullable: true }) dateEffet: string | null;
  /** ARRETE, DECRET, NOTE_SERVICE, DECISION, AUTRE. */
  @Column({ type: 'varchar', nullable: true }) acteNature: string | null;
  @Column({ type: 'varchar', nullable: true }) acteNumero: string | null;
  @Column({ type: 'date', nullable: true }) acteDate: string | null;
  /** Nouvelles valeurs des rubriques de la fiche (GRADE, ECHELON…). */
  @Column({ type: 'jsonb', default: {} }) nouveau: Record<string, unknown>;
  /** Valeurs de la fiche avant l'événement (pour l'annuler). */
  @Column({ type: 'jsonb', default: {} }) avant: Record<string, unknown>;
  /** Les nouvelles valeurs ont-elles été reportées dans la fiche ? */
  @Column({ type: 'boolean', default: false }) reporte: boolean;
  @Column({ type: 'text', nullable: true }) commentaire: string | null;
  /** Scan de l'acte. */
  @Column({ type: 'varchar', nullable: true }) fichier: string | null;
  @Column({ type: 'varchar', nullable: true }) nomOrigine: string | null;
  @Column({ type: 'varchar', nullable: true }) mime: string | null;
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/* ============================ Écoles : bâtiments, salles, classes ============================ */

/** Bâtiment d'un établissement (administratif, pédagogique, sanitaire, sportif…). */
@Entity('batiment')
export class Batiment {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) structureId: number;
  @Column() nom: string;
  /** Type (référentiel TYPE_BATIMENT, libellé). */
  @Column({ type: 'varchar', nullable: true }) type: string | null;
  @Column({ type: 'int', default: 1 }) niveaux: number;
  @Column({ type: 'int', nullable: true }) anneeConstruction: number | null;
  /** BON, MOYEN, MAUVAIS. */
  @Column({ default: 'BON' }) etat: string;
  @Column({ type: 'text', nullable: true }) observation: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/** Salle d'un établissement (salle de classe, laboratoire, bibliothèque, bureau…). */
@Entity('salle')
export class Salle {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) structureId: number;
  @Index() @Column({ type: 'int', nullable: true }) batimentId: number | null;
  @Column() nom: string;
  /** Type (référentiel TYPE_SALLE, libellé). */
  @Column({ type: 'varchar', nullable: true }) type: string | null;
  @Column({ type: 'int', nullable: true }) capacite: number | null;
  @Column({ default: 'BON' }) etat: string;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/**
 * Classe ouverte une année scolaire (6e 1, 2nde C…). Avec le programme de son niveau (heures par
 * matière), elle donne les heures à assurer, donc les enseignants nécessaires.
 */
@Entity('classe')
@Index(['structureId', 'anneeScolaire'])
export class Classe {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'int' }) structureId: number;
  @Column() anneeScolaire: string;
  /** Code du niveau (référentiel NIVEAU : 6EME, 2NDE C, CM1…). */
  @Column() niveau: string;
  @Column() nom: string;
  @Column({ type: 'int', nullable: true }) salleId: number | null;
  @Column({ type: 'int', nullable: true }) effectif: number | null;
  @Column({ type: 'int', nullable: true }) effectifFilles: number | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/* ============================ Présence et évaluation du personnel ============================ */

/** Un cours d'un enseignant : la classe, le jour (1 = lundi) et le créneau (« 07:30 »-« 08:25 »). */
export interface PlageEnseignant {
  classeId: number;
  jour: number;
  debut: string;
  fin: string;
}

/** Jours et heures où l'agent est attendu (1 = lundi … 6 = samedi). */
@Entity('horaire_agent')
export class HoraireAgent {
  @PrimaryColumn({ type: 'int' }) agentId: number;
  @Index() @Column({ type: 'int' }) structureId: number;
  @Column({ type: 'jsonb', default: {} }) jours: Record<
    string,
    { debut: string | null; fin: string | null }
  >;
  /**
   * Plages horaires saisies par l'école (DG, 28/10/2026) : son emploi du temps, créneau par créneau
   * (le lundi 07:30-08:25 en 6ème 1, le mardi 10:30-11:25 en 5ème 2…), dans sa matière. L'emploi du
   * temps les reprend telles quelles ; vide : il est réparti automatiquement.
   */
  @Column({ type: 'jsonb', default: [] }) plages: PlageEnseignant[];
  @Column({ type: 'varchar', nullable: true }) modifiePar: string | null;
  @UpdateDateColumn() modifieLe: Date;
}

/** Présence d'un agent un jour donné, pointée par le chef de sa structure. */
@Entity('presence')
@Index(['agentId', 'date'], { unique: true })
export class Presence {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'int' }) agentId: number;
  @Index() @Column({ type: 'int' }) structureId: number;
  @Index() @Column({ type: 'date' }) date: string;
  /** PRESENT, RETARD, ABSENT_JUSTIFIE, ABSENT. */
  @Column() statut: string;
  @Column({ type: 'varchar', nullable: true }) motif: string | null;
  /** Heures d'arrivée et de départ (« 07:45 ») : facultatives ; elles donnent le retard et les heures faites. */
  @Column({ type: 'varchar', nullable: true }) arrivee: string | null;
  @Column({ type: 'varchar', nullable: true }) depart: string | null;
  @Column({ type: 'varchar', nullable: true }) saisiPar: string | null;
  @UpdateDateColumn() saisiLe: Date;
}

/** Semaine de présence validée par le chef de structure (les retards de pointage se voient). */
@Entity('semaine_presence')
@Index(['structureId', 'lundi'], { unique: true })
export class SemainePresence {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'int' }) structureId: number;
  @Column({ type: 'date' }) lundi: string;
  @Column({ type: 'varchar', nullable: true }) valideePar: string | null;
  @CreateDateColumn() valideeLe: Date;
}

/**
 * Évaluation annuelle d'un agent par son chef immédiat (DG, réunion de cadrage) : compétence
 * professionnelle et compétence sociale, chacune de 1 (très faible) à 5 (excellent) ; la
 * compétence globale est leur moyenne, mais le détail reste toujours visible.
 */
@Entity('evaluation_agent')
@Index(['agentId', 'annee'], { unique: true })
export class EvaluationAgent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'int' }) agentId: number;
  /** Année évaluée (« 2026 ») : une évaluation par an (DG, 24/10/2026) ; avant, l'année scolaire. */
  @Column() annee: string;
  @Column({ type: 'date' }) date: string;
  @Column({ type: 'int' }) competenceProfessionnelle: number;
  @Column({ type: 'int' }) competenceSociale: number;
  @Column({ type: 'real' }) globale: number;
  @Column() appreciation: string;
  @Column({ type: 'varchar', nullable: true }) decision: string | null;
  @Column({ type: 'text', nullable: true }) commentaireProfessionnel:
    string | null;
  @Column({ type: 'text', nullable: true }) commentaireSocial: string | null;
  @Column({ type: 'int', nullable: true }) structureId: number | null;
  @Column({ type: 'varchar', nullable: true }) evaluateur: string | null;
  /** Validée : l'évaluation est close et ne se modifie plus (avant, c'est un brouillon). */
  @Column({ type: 'timestamptz', nullable: true }) valideeLe: Date | null;
  @Column({ type: 'varchar', nullable: true }) valideePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

/**
 * Emploi du temps d'un collège ou d'un lycée pour une année scolaire (DG, 24/10/2026), généré à
 * partir des classes ouvertes, des quotas horaires et des enseignants de l'école : qui fait quelle
 * matière dans quelle classe, à quel créneau. Il se regénère quand les classes ou les enseignants
 * changent.
 */
@Entity('emploi_du_temps')
@Index(['structureId', 'anneeScolaire'], { unique: true })
export class EmploiDuTemps {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'int' }) structureId: number;
  @Column() anneeScolaire: string;
  /** Jours de cours (1 = lundi … 6 = samedi). */
  @Column({ type: 'jsonb' }) jours: number[];
  /** Créneaux de la journée : [{ debut: « 07:30 », fin: « 08:25 » }]. */
  @Column({ type: 'jsonb' }) creneaux: { debut: string; fin: string }[];
  /** Séances : classe, matière, enseignant (vide : à pourvoir), jour et créneau. */
  @Column({ type: 'jsonb' }) seances: Record<string, unknown>[];
  /** Heures sans enseignant ou sans créneau, avec la raison. */
  @Column({ type: 'jsonb' }) nonPlaces: Record<string, unknown>[];
  /** Charge de chaque enseignant (heures, classes). */
  @Column({ type: 'jsonb' }) charges: Record<string, unknown>[];
  @Column({ type: 'int' }) heuresTotal: number;
  @Column({ type: 'int' }) heuresPlacees: number;
  /** Heures du programme des classes au moment de la génération (sans les plages en plus). */
  @Column({ type: 'int', nullable: true }) heuresProgramme: number | null;
  @Column({ type: 'varchar', nullable: true }) generePar: string | null;
  @UpdateDateColumn() genereLe: Date;
}

/**
 * Cadre organique d'une structure administrative (DG, 28/10/2026) : pour chaque poste, l'effectif
 * normal (ex. 5 collaborateurs dans ce bureau). Une demande de personnel se compare à lui.
 */
@Entity('cadre_organique')
@Index(['structureId', 'poste'], { unique: true })
export class CadreOrganique {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) structureId: number;
  @Column() poste: string;
  @Column({ type: 'int' }) effectif: number;
  @Column({ type: 'varchar', nullable: true }) modifiePar: string | null;
  @UpdateDateColumn() modifieLe: Date;
}

/**
 * Besoin en personnel exprimé par une structure administrative (DG, 28/10/2026) : un directeur, un
 * chef de service, des collaborateurs… La DGRHAS l'accorde (en tout ou en partie) ou le refuse.
 */
@Entity('besoin_personnel')
export class BesoinPersonnel {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ type: 'int' }) structureId: number;
  @Column() poste: string;
  @Column({ type: 'int' }) nombre: number;
  @Column({ type: 'text' }) motif: string;
  /** EN_ATTENTE, ACCORDE, REFUSE */
  @Index() @Column({ default: 'EN_ATTENTE' }) statut: string;
  @Column({ type: 'int', nullable: true }) nombreAccorde: number | null;
  @Column({ type: 'text', nullable: true }) decision: string | null;
  @Column({ type: 'varchar', nullable: true }) decidePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decideLe: Date | null;
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @Column({ type: 'uuid', nullable: true }) creeParId: string | null;
  @CreateDateColumn() creeLe: Date;
}

/**
 * Nomination d'un cadre de gestion (DGRHAS, 26/10/2026) : une ligne par personne et par année
 * scolaire. La DDEPPSA propose (reconduire, muter, promouvoir, permuter, relever), la DGRHAS et la
 * commission décident ; les lignes validées vont dans la note de service de leur catégorie.
 * Rien n'est effacé d'une année à l'autre : une personne relevée peut être nommée de nouveau.
 */
@Entity('nomination')
@Index(['annee', 'categorie'])
export class Nomination {
  @PrimaryGeneratedColumn() id: number;
  /** Année scolaire de la nomination (« 2026-2027 »). */
  @Index() @Column() annee: string;
  /** Catégorie (catalogue des nominations) : elle donne la note de service. */
  @Column() categorie: string;
  @Index() @Column({ type: 'int', nullable: true }) departementId:
    number | null;
  /** Circonscription scolaire (« Madingou », « ILZ 4 ») : sous-titre dans la note. */
  @Column({ type: 'varchar', nullable: true }) circonscription: string | null;
  /** Fiche de la base du personnel, quand elle est retrouvée. */
  @Index() @Column({ type: 'int', nullable: true }) agentId: number | null;
  /** Rattachement à la base du personnel : comme pour les mutations (MATRICULE, NOM, MANUEL…). */
  @Index() @Column({ type: 'varchar', nullable: true }) rattachement:
    string | null;
  @Column() nomComplet: string;
  @Index() @Column() nomNormalise: string;
  @Column({ type: 'varchar', nullable: true }) genre: string | null;
  @Column({ type: 'varchar', nullable: true }) grade: string | null;
  @Column({ type: 'varchar', nullable: true }) echelon: string | null;
  /** Catégorie et échelle de l'agent (notes des inspections). */
  @Column({ type: 'varchar', nullable: true }) categorieAgent: string | null;
  @Column({ type: 'varchar', nullable: true }) echelle: string | null;
  @Column({ type: 'varchar', nullable: true }) specialite: string | null;
  @Column({ type: 'varchar', nullable: true }) vague: string | null;
  @Column({ type: 'varchar', nullable: true }) ancienPoste: string | null;
  @Column({ type: 'varchar', nullable: true }) nouveauPoste: string | null;
  /** RECONDUIT, PROMU, MUTE, PERMUTE, RELEVE. */
  @Column({ default: 'RECONDUIT' }) observation: string;
  @Column({ type: 'text', nullable: true }) motif: string | null;
  /** PROPOSEE (par la DDEPPSA), VALIDEE ou REJETEE (DGRHAS, commission, ministre). */
  @Index() @Column({ default: 'PROPOSEE' }) statut: string;
  @Column({ type: 'text', nullable: true }) avisDdeppsa: string | null;
  @Column({ type: 'text', nullable: true }) avisDgrhas: string | null;
  @Column({ type: 'varchar', nullable: true }) decidePar: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decideLe: Date | null;
  /** Modifiée par la DDEPPSA par rapport à ce qui lui a été envoyé (« surligné en jaune »). */
  @Column({ type: 'boolean', default: false }) modifie: boolean;
  /** Ligne de l'année précédente d'où elle vient (reconduction). */
  @Column({ type: 'int', nullable: true }) origineId: number | null;
  /** Note de service validée qui la contient. */
  @Index() @Column({ type: 'uuid', nullable: true }) noteId: string | null;
  /** IMPORT (base de la DGRHAS), REPRISE (année précédente) ou SAISIE. */
  @Column({ default: 'SAISIE' }) source: string;
  @Column({ type: 'varchar', nullable: true }) creePar: string | null;
  @CreateDateColumn() creeLe: Date;
  @UpdateDateColumn() modifieLe: Date;
}

export const ENTITES = [
  Utilisateur,
  Journal,
  Parametre,
  Departement,
  Grade,
  RegleDiplome,
  LotPublication,
  Agent,
  Affectation,
  Recommandation,
  NoteService,
  DemandeMutation,
  Enveloppe,
  Repartition,
  MembreCommission,
  PaquetReception,
  OrigineDossier,
  AncienRecrute,
  PieceJointe,
  Structure,
  TypePrestation,
  PieceDemande,
  Alerte,
  AlerteLue,
  InstructionDemande,
  Beneficiaire,
  PlaceBeneficiaire,
  ReferenceNote,
  CampagneEnrolement,
  MembreEnrolement,
  Enrole,
  Volontaire,
  MouvementVolontaire,
  EtatBourse,
  LigneBourse,
  Regularisation,
  MiseEnRoute,
  LigneMiseEnRoute,
  BesoinEtablissement,
  AgentRecense,
  ModificationRecensement,
  PieceRecensement,
  LigneBottin,
  Referentiel,
  EvenementCarriere,
  Batiment,
  Salle,
  Classe,
  HoraireAgent,
  Presence,
  SemainePresence,
  EvaluationAgent,
  EmploiDuTemps,
  CadreOrganique,
  BesoinPersonnel,
  Nomination,
  DoublonDistinct,
];
