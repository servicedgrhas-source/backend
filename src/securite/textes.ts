/**
 * Textes de la page des comptes signalés (08/11/2026) : envoyés par le serveur au DG et à
 * l'administrateur seulement. Rien de ce qui révèle l'outil n'est écrit dans le code de l'interface
 * (que tout navigateur peut lire). Les accolades sont remplacées à l'affichage : {n}, {nom}, {seuil}.
 */
export const TEXTES_SECURITE = {
  titre: 'Comptes signalés',
  sousTitre:
    'L’outil de détection note ce qui n’est pas le comportement d’un humain qui suit l’interface : appels directs au serveur, adresses inventées, lectures trop rapides ou à la chaîne… Chaque règle franchie ajoute des points ; le score redescend de lui-même avec le temps. Les comptes concernés n’en sont jamais informés, sauf s’ils sont suspendus.',
  chiffres: {
    suspendus: 'Comptes suspendus',
    suspendusDetail: 'en attente de vérification',
    surveilles: 'Comptes surveillés',
    surveillesDetail: 'score de {seuil} ou plus',
    mode: 'Mode de l’outil',
    actif: 'Actif',
    observation: 'Observation',
    actifDetail: 'suspension à {seuil} points',
    observationDetail: 'note et alerte, suspend seulement les signes certains',
  },
  liste: {
    titre: 'Comptes signalés (7 derniers jours)',
    vide: 'Aucun compte signalé : rien d’anormal ces 7 derniers jours.',
    compte: 'Compte',
    etat: 'État',
    score: 'Score',
    max: 'max {n}',
    regles: 'Règles franchies',
    dernier: 'Dernier signal',
    voir: 'Ce qu’il a fait',
    retablir: 'Rétablir',
    suspendre: 'Suspendre',
  },
  etats: {
    suspendu: 'Suspendu',
    alerte: 'Alerte',
    surveille: 'Surveillé',
    observe: 'Observé',
  },
  paliers: {
    SURVEILLANCE: 'Surveillance commencée',
    ALERTE: 'Alerte au DG et à l’administrateur',
    SUSPENSION: 'Compte suspendu',
    SUSPENSION_SIMULEE: 'Aurait été suspendu (mode observation)',
    RETABLI: 'Compte rétabli',
  },
  /** Couleur de chaque palier dans la chronologie. */
  tons: {
    SURVEILLANCE: 'jaune',
    ALERTE: 'rouge',
    SUSPENSION: 'rouge',
    SUSPENSION_SIMULEE: 'jaune',
    RETABLI: 'vert',
  },
  chronologie: {
    titre: 'Ce qu’a fait {nom}',
    vide: 'Rien de noté.',
    score: 'score {n}',
    requetes: 'Ses {n} dernières requêtes',
  },
  retablir: {
    titre: 'Rétablir le compte de {nom} ?',
    texte:
      'Après vérification : la personne retrouve son accès, son score repart de zéro. Dites ce qui a été vérifié (avec qui, et ce qui s’est passé).',
    champ: 'Ce qui a été vérifié',
    exemple: 'Ex. Entretien avec l’agent : travail normal sur les imports',
    bouton: 'Rétablir',
    fait: '{nom} est rétabli.',
  },
  suspendre: {
    titre: 'Suspendre le compte de {nom} ?',
    texte:
      'La personne voit aussitôt l’écran « compte signalé » et ne peut plus rien faire jusqu’à ce qu’on la rétablisse.',
    champ: 'Motif',
    exemple: 'Ex. Lectures massives à vérifier',
    bouton: 'Suspendre',
    fait: '{nom} est suspendu.',
  },
  annuler: 'Annuler',
  reglages: {
    titre: 'Réglages de l’outil',
    observation: 'Observation',
    actif: 'Actif',
    explicationActif:
      'Actif : un compte qui atteint le seuil de suspension est suspendu.',
    explicationObservation:
      'Observation : l’outil note, surveille et alerte, et montre « aurait été suspendu » sans suspendre. Les signes certains (appel hors navigateur, adresse piège) suspendent toujours. À utiliser les premières semaines pour régler les seuils.',
    surveillance: 'Surveillance à',
    alerte: 'Alerte à',
    suspension: 'Suspension à',
    demiVie: 'Score divisé par deux en (minutes)',
    enregistrer: 'Enregistrer',
    fait: 'Réglages de l’outil enregistrés.',
  },
  exemptes: {
    titre: 'Comptes exemptés',
    texte:
      'Ces comptes ne sont jamais comptés ni suspendus par l’outil (tests du développeur). La liste est tenue sur le serveur (variable SECURITE_COMPTES_EXEMPTES, et le compte administrateur de départ) : elle ne se change pas depuis l’application.',
  },
  regles: {
    titre: 'Les règles de l’outil',
    regle: 'Règle',
    points: 'Points',
    immediate: 'Suspension immédiate',
  },
};

/** Ce que voit un compte suspendu (envoyé avec le refus, jamais écrit dans l'interface). */
export const ECRAN_SUSPENDU = {
  titre: 'Votre compte a été signalé par nos outils de détection.',
  message: 'Veuillez patienter pendant qu’un humain vérifie votre compte.',
};
