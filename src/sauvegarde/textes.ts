/**
 * Textes de la page de sauvegarde (08/11/2026) : envoyés par le serveur aux seuls comptes autorisés
 * (le DG, le compte administrateur de départ ADMIN_EMAIL, les comptes de SECURITE_COMPTES_EXEMPTES).
 * Rien n'est écrit dans le code de l'interface. **gras** et `code` sont mis en forme à l'affichage ;
 * {n}, {jours}… sont remplacés.
 */
export const TEXTES_SAUVEGARDE = {
  titre: 'Sauvegarde de la base',
  sousTitre:
    'Un fichier avec toutes les données du système (recrutés, affectations, notes, personnel, mutations, enrôlement, comptes, paramètres…) : de quoi tout remettre en place si la base en ligne est perdue ou abîmée.',
  avertissement:
    '**Le fichier contient toutes les données personnelles** (noms, dates de naissance, textes, comptes). Gardez-le sur un support à vous (clé USB rangée, disque du service), jamais sur un ordinateur partagé. Ne l’envoyez **jamais** par e-mail, WhatsApp ou une messagerie. Chaque téléchargement est inscrit au journal, avec votre nom.',
  chiffres: {
    donnees: 'Données enregistrées',
    lignes: '{n} lignes',
    tables: '{n} tables',
    taille: 'Taille de la base',
    tailleDetail: 'Le fichier est compressé : bien plus petit',
    derniere: 'Dernière sauvegarde',
    aujourdhui: 'Aujourd’hui',
    hier: 'Hier',
    ilYa: 'Il y a {jours} jours',
    jamais: 'Jamais',
    aucune: 'Aucune sauvegarde téléchargée',
    conseil: 'Conseil',
    conseilValeur: 'Une par semaine',
    conseilDetail:
      'Et toujours avant un import important, un vidage ou une grosse correction',
  },
  rappelJamais:
    'Aucune sauvegarde n’a encore été téléchargée. Faites-en une maintenant.',
  rappelVieille:
    'La dernière sauvegarde date de {jours} jours. Faites-en une maintenant.',
  telecharger: {
    titre: 'Télécharger une sauvegarde',
    etapes: [
      'Le serveur prépare un fichier **« sauvegarde-sigrhas-AAAAMMJJ-HHMM.sql.gz »** avec toutes les données, telles qu’elles sont à l’instant du clic. Cela prend quelques secondes à une minute.',
      'Le navigateur l’enregistre (dossier Téléchargements, ou celui que vous choisissez).',
      'Copiez-le sur votre support de sauvegarde, puis supprimez-le de l’ordinateur s’il n’est pas à vous.',
    ],
    engagement:
      'Je garderai ce fichier en lieu sûr et je ne l’enverrai par aucune messagerie. Je sais qu’il contient les données personnelles de tous les agents.',
    bouton: 'Télécharger la sauvegarde',
    enCours: 'Préparation de la sauvegarde…',
    cloudinary: 'Envoyer chez Cloudinary',
    cloudinaryEnCours: 'Envoi chez Cloudinary…',
    cloudinaryNonRegle: 'Cloudinary n’est pas réglé sur le serveur',
    pieces:
      'Les fichiers joints (scans des textes, pièces) ne sont pas dans ce fichier : ils restent dans le stockage des fichiers.',
    fait: 'Sauvegarde téléchargée. Rangez le fichier en lieu sûr (voir les conseils ci-dessous).',
    faitCloudinary:
      'Sauvegarde envoyée chez Cloudinary : {fichier} ({taille}, {lignes} lignes), en fichier privé.',
  },
  cloudinary: {
    titre: 'Copie chez Cloudinary',
    nonRegle: [
      '**Cloudinary n’est pas encore réglé.** Une copie chez Cloudinary garde la sauvegarde hors du bureau : si l’ordinateur ou la clé est perdu, elle reste récupérable.',
      'Pour l’activer, l’informaticien ajoute sur le serveur (Render › Environment) le réglage `CLOUDINARY_URL`, copié depuis le tableau de bord Cloudinary (« API environment variable », de la forme `cloudinary://clé:secret@nom`), puis redémarre le serveur.',
    ],
    regle:
      'Compte Cloudinary **{cloud}**, dossier « sauvegardes-sigrhas ». Les fichiers y sont **privés** : aucune adresse publique ; « Récupérer » donne un lien valable 5 minutes. Gardez l’accès à ce compte Cloudinary pour vous seuls.',
    vide: 'Aucune sauvegarde chez Cloudinary pour l’instant.',
    envoyeeLe: 'Envoyée le',
    fichier: 'Fichier',
    taille: 'Taille',
    recuperer: 'Récupérer',
  },
  dernieres: {
    titre: 'Dernières sauvegardes',
    vide: 'Aucune sauvegarde téléchargée pour l’instant.',
    date: 'Date',
    ou: 'Où',
    par: 'Par',
    fichier: 'Fichier',
    lignes: 'Lignes',
    telechargee: 'Téléchargée',
    cloudinary: 'Cloudinary',
  },
  contenu: {
    titre: 'Ce que contient la sauvegarde',
    toutes: 'Toutes les tables ({n})',
  },
  restauration: {
    titre: 'En cas de problème : remettre une sauvegarde en place',
    intro:
      'La remise en place se fait par la personne qui s’occupe du serveur (informaticien), pas depuis cette page : elle **remplace toutes les données** par celles du fichier.',
    etapes: [
      'Créer une base PostgreSQL vide (ou vider l’ancienne).',
      'Démarrer une fois le serveur SIGRHAS branché sur cette base : il crée toutes les tables.',
      'Décompresser le fichier (.gz), puis l’exécuter sur la base, par exemple : `psql "adresse de la base" -f sauvegarde-sigrhas-….sql`',
      'Vérifier sur cette page que les nombres de lignes sont revenus.',
    ],
    note: 'Le fichier est complet ou rien : s’il a été coupé pendant le téléchargement, il ne restaure rien (il faut en télécharger un autre).',
  },
};

/** Ce que contient chaque table, en mots de la DGRHAS. */
export const NOMS_TABLES: Record<string, string> = {
  agent: 'Base des recrutés',
  affectation: 'Affectations',
  note_service: 'Notes de service',
  lot_publication: 'Lots de publication',
  paquet_reception: 'Paquets de textes reçus',
  recommandation: 'Recommandations',
  reference_note: 'Notes signées hors du système',
  agent_recense: 'Personnel (recensement)',
  modification_recensement: 'Modifications du recensement',
  piece_recensement: 'Pièces du recensement',
  demande_mutation: 'Demandes de mutation',
  nomination: 'Nominations',
  volontaire: 'Registre des volontaires',
  mouvement_volontaire: 'Mouvements des volontaires',
  enrole: 'Enrôlés',
  campagne_enrolement: 'Campagnes d’enrôlement',
  membre_enrolement: 'Commission d’enrôlement',
  ancien_recrute: 'Recrutés des années passées',
  structure: 'Structures (écoles, directions…)',
  besoin_personnel: 'Besoins en personnel',
  besoin_etablissement: 'Besoins des établissements',
  cadre_organique: 'Cadre organique',
  emploi_du_temps: 'Emplois du temps',
  presence: 'Présences',
  semaine_presence: 'Semaines de présence',
  journal: 'Journal des actions',
  utilisateur: 'Comptes des utilisateurs',
  parametre: 'Paramètres',
  regle_diplome: 'Règles des diplômes',
  grade: 'Grades',
  departement: 'Départements',
  referentiel: 'Listes de référence',
  piece_jointe: 'Pièces jointes (références)',
  doublon_distinct: 'Doublons tranchés',
  repartition: 'Répartitions du quota « Autres »',
  enveloppe: 'Enveloppes budgétaires',
  beneficiaire: 'Bénéficiaires du quota',
  evenement_carriere: 'Carrière (événements)',
  evaluation_agent: 'Évaluations',
  alerte: 'Alertes',
};
