/**
 * Outil de détection (DG, 08/11/2026) : les règles qui distinguent un humain qui suit l'interface
 * d'un programme (script, IA) qui interroge le serveur directement ou trop vite. Fonctions pures :
 * elles reçoivent l'état d'un compte et une requête, et disent quelles règles sont franchies.
 * Rien ici ne doit transparaître dans les réponses du serveur : l'agent ne sait pas qu'il est observé.
 */

export interface DefinitionRegle {
  libelle: string;
  points: number;
  /** Suspend le compte tout de suite, quel que soit le score (un humain ne peut pas la franchir). */
  immediate?: boolean;
}

export const REGLES = {
  A1_HORS_NAVIGATEUR: {
    libelle:
      'Requête qui ne vient pas d’un navigateur (ni origine, ni en-têtes Sec-Fetch) : curl, script, IA',
    points: 100,
    immediate: true,
  },
  A1_AUTRE_SITE: {
    libelle: 'Requête envoyée depuis un autre site que celui de l’application',
    points: 100,
    immediate: true,
  },
  A2_OUTIL: {
    libelle:
      'Outil automatique déclaré (curl, python, axios, navigateur sans écran…)',
    points: 60,
  },
  A3_HORS_INTERFACE: {
    libelle: 'Appel sans le contexte que l’interface ajoute toujours',
    points: 10,
  },
  A4_ADRESSE_INCONNUE: {
    libelle: 'Adresse inexistante essayée (tâtonnement)',
    points: 45,
  },
  A5_PARAMETRES: {
    libelle:
      'Paramètres que l’interface n’envoie jamais (filtre inventé, champ inconnu, taille démesurée)',
    points: 70,
  },
  A6_REFUS: {
    libelle:
      'Refus en série (droits ou requêtes mal formées) : le compte sonde ce qu’il peut lire',
    points: 10,
  },
  B1_PIEGE: {
    libelle: 'Adresse piège appelée (jamais utilisée par l’interface)',
    points: 100,
    immediate: true,
  },
  B3_PAGE_RESERVEE: {
    libelle:
      'Page réservée au DG appelée par un autre compte (l’interface ne la lui montre jamais)',
    points: 70,
  },
  B2_INTROUVABLES: {
    libelle: 'Fiches inexistantes demandées en série (parcours des numéros)',
    points: 40,
  },
  C1_RAFALE: {
    libelle: 'Rafale : plus de 240 appels en une minute',
    points: 30,
  },
  C2_FICHES_MINUTE: {
    libelle: 'Plus de 20 fiches différentes ouvertes en une minute',
    points: 30,
  },
  C3_PARCOURS: {
    libelle:
      'Parcours systématique (fiches dans l’ordre des numéros, ou pages d’une liste à la suite)',
    points: 40,
  },
  C4_VOLUME_300: {
    libelle: 'Plus de 300 fiches différentes ouvertes dans la journée',
    points: 20,
  },
  C4_VOLUME_1000: {
    libelle: 'Plus de 1 000 fiches différentes ouvertes dans la journée',
    points: 50,
  },
  C5_EXPORTS: {
    libelle: 'Plus de 15 exports (Excel, Word, PDF d’une base) en une heure',
    points: 30,
  },
  C6_SANS_PAUSE: {
    libelle: 'Plus d’une heure d’activité sans aucune pause de 2 minutes',
    points: 30,
  },
  C7_REGULARITE: {
    libelle: 'Appels à intervalles réguliers comme une machine',
    points: 40,
  },
  D1_SANS_ACTIVITE: {
    libelle: 'Lectures lourdes sans aucun clic ni frappe depuis 5 minutes',
    points: 25,
  },
  D2_ONGLET_CACHE: {
    libelle: 'Fiches lues alors que l’onglet est en arrière-plan',
    points: 15,
  },
  D3_NUIT: {
    libelle: 'Lectures lourdes la nuit (22 h – 5 h, heure de Brazzaville)',
    points: 10,
  },
  E1_DEUX_NAVIGATEURS: {
    libelle: 'La même session utilisée en même temps depuis deux navigateurs',
    points: 60,
  },
  E2_CHANGEMENT: {
    libelle: 'Changement d’adresse réseau au milieu de la session',
    points: 20,
  },
  E3_ECHECS: {
    libelle: 'Connexion réussie juste après plusieurs essais ratés',
    points: 15,
  },
} satisfies Record<string, DefinitionRegle>;

export type CodeRegle = keyof typeof REGLES;

export interface Gain {
  regle: CodeRegle;
  details?: Record<string, unknown>;
}

/* ------------------------------ Classement des adresses ------------------------------ */

/** Lectures communes de toutes les pages : jamais comptées (menu, profil, référentiels…). */
const LECTURES_COMMUNES = [
  /^auth\//,
  /^menu\//,
  /^referentiels(\/|$)/,
  /^parametres$/,
  /^configuration$/,
  /^structures$/,
  /^enrolement\/(referentiel|diplomes|configuration)$/,
  /^recensement\/configuration$/,
  /^prestations$/,
  // Une note (son affichage, son Word, son Excel, son scan) : le travail courant sur une note
  /^notes\/[^/]+(\/(word|excel|scan|recapitulatif))?$/,
];

/** Fiches détaillées d'une personne ou d'un dossier : type et numéro. */
const FICHES: [RegExp, string][] = [
  [/^recensement\/agents\/(\d+)(\/pieces\/[^/]+)?$/, 'agent'],
  // Un identifiant de fiche (et non « ecarts », « export », « catalogue »…) : faux positif du 08/11/2026
  [/^enrolement\/volontaires\/([0-9a-f-]{36})$/, 'volontaire'],
  [/^mutations\/([0-9a-f-]{36})(\/pieces\/[^/]+)?$/, 'mutation'],
  [/^demandes-prestation\/([0-9a-f-]{36})(\/pieces\/[^/]+)?$/, 'prestation'],
  [/^dossiers\/(\d+)(\/pieces\/[^/]+)?$/, 'dossier'],
  [/^evaluations\/agents\/(\d+)(\/fiche\/[^/]+)?$/, 'evaluation'],
  [/^doublons\/[^/]+\/([^/]+)$/, 'doublon'],
];

/** Exports d'une base entière (Excel, Word, PDF, bottin, sauvegarde). */
const EXPORT = /(^|\/)(excel|export|word|bottin|telecharger|listes|pdf)(\/|$)/;

/**
 * Adresses pièges : tentantes pour un programme qui cherche à tout récupérer, jamais appelées par
 * l'interface. Elles n'existent pas (réponse « introuvable » ordinaire), mais un seul appel suffit.
 */
export const PIEGES = [
  /^admin(\/|$)/,
  /^api(\/|$)/,
  /^dump(\/|$)/,
  /^backup(\/|$)/,
  /^export(\/|$)/,
  /^users(\/|$)/,
  /^graphql(\/|$)/,
  /^swagger/,
  /^openapi/,
  /^docs?(\/|$)/,
  /^debug(\/|$)/,
  /^sql(\/|$)/,
  /^agents\/export-complet/,
  /^personnel\/export/,
  /^recensement\/agents\/export-complet/,
  /^base\/export/,
  /^utilisateurs\/export/,
  /^\.env/,
  /^config\.(json|js)$/,
];

const nettoyer = (chemin: string) =>
  chemin.replace(/^\/?api\//, '').replace(/^\/+|\/+$/g, '');

export interface Classe {
  chemin: string;
  commune: boolean;
  lecture: boolean;
  fiche: { type: string; id: string } | null;
  export: boolean;
}

export function classer(cheminBrut: string, methode: string): Classe {
  const chemin = nettoyer(cheminBrut.split('?')[0]);
  const lecture = ['GET', 'HEAD'].includes(methode.toUpperCase());
  const commune = lecture && LECTURES_COMMUNES.some((r) => r.test(chemin));
  let fiche: Classe['fiche'] = null;
  if (lecture && !commune)
    for (const [r, type] of FICHES) {
      const m = r.exec(chemin);
      if (m) {
        fiche = { type, id: m[1] };
        break;
      }
    }
  return {
    chemin,
    commune,
    lecture,
    fiche,
    export: lecture && !commune && EXPORT.test(chemin),
  };
}

export const estPiege = (cheminBrut: string) =>
  PIEGES.some((r) => r.test(nettoyer(cheminBrut.split('?')[0])));

/* ------------------------------ Navigateur et outil ------------------------------ */

const OUTILS =
  /curl|wget|python|requests|aiohttp|httpx|axios|node-fetch|undici|go-http|okhttp|java\/|libwww|scrapy|postman|insomnia|httpie|headlesschrome|phantomjs|puppeteer|playwright|selenium|bot\b|spider|crawler/i;

export interface Entetes {
  origin?: string;
  secFetchSite?: string;
  userAgent?: string;
}

/**
 * Un vrai navigateur qui appelle l'API envoie son origine (appel depuis le site en ligne) ou les
 * en-têtes Sec-Fetch (navigateurs récents) : un programme JavaScript ne peut pas les fabriquer.
 */
export function regleNavigateur(
  e: Entetes,
  originesPermises: (o: string) => boolean,
): Gain[] {
  const g: Gain[] = [];
  if (!e.origin && !e.secFetchSite)
    g.push({
      regle: 'A1_HORS_NAVIGATEUR',
      details: { navigateur: e.userAgent ?? null },
    });
  else if (
    e.origin &&
    e.secFetchSite === 'cross-site' &&
    !originesPermises(e.origin)
  )
    g.push({ regle: 'A1_AUTRE_SITE', details: { origine: e.origin } });
  if (!e.userAgent || OUTILS.test(e.userAgent))
    g.push({ regle: 'A2_OUTIL', details: { navigateur: e.userAgent ?? null } });
  return g;
}

/* ------------------------------ Paramètres impossibles ------------------------------ */

/** Tailles de page : l'interface demande au plus 50 (taille) ou 40 (limite). */
const TAILLES = /^(taille|limite|limit|pagesize|parpage|max|per_page|size)$/i;

/**
 * Paramètres de l'adresse que l'interface n'envoie jamais : un nom que la route ne lit pas (quand
 * elle déclare ses paramètres un par un), ou une taille démesurée.
 */
export function parametresImpossibles(
  query: Record<string, unknown>,
  autorises: Set<string> | null,
): string[] {
  const fautes: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (autorises && !autorises.has(k))
      fautes.push(`paramètre inconnu « ${k} »`);
    const n = Number(Array.isArray(v) ? v[0] : v);
    if (TAILLES.test(k) && Number.isFinite(n) && (n > 200 || n < 0))
      fautes.push(`taille ${k}=${n}`);
    if (/^page$/i.test(k) && Number.isFinite(n) && (n > 100000 || n < 0))
      fautes.push(`page=${n}`);
  }
  return fautes;
}

/* ------------------------------ Comportement dans le temps ------------------------------ */

export interface EtatCompte {
  appels: number[];
  fichesMinute: { t: number; cle: string }[];
  jour: string;
  fichesJour: Set<string>;
  suiteFiches: { type: string; id: number }[];
  pages: Map<string, { page: number; t: number; suite: number }>;
  exports: number[];
  refus: number[];
  introuvables: { t: number; cle: string }[];
  debutActivite: number;
  dernierAppel: number;
  intervalles: number[];
  derniereInteraction: number;
  sessions: Map<string, { ip: string; ua: string; t: number }>;
  donnees: Map<string, number>;
}

export function etatVide(t: number): EtatCompte {
  return {
    appels: [],
    fichesMinute: [],
    jour: '',
    fichesJour: new Set(),
    suiteFiches: [],
    pages: new Map(),
    exports: [],
    refus: [],
    introuvables: [],
    debutActivite: t,
    dernierAppel: 0,
    intervalles: [],
    derniereInteraction: t,
    sessions: new Map(),
    donnees: new Map(),
  };
}

const MINUTE = 60_000;
const HEURE = 60 * MINUTE;

/** Une même règle n'est comptée qu'une fois par période (sauf A3, A4, A5, A6, comptées à chaque fois). */
function unePar(e: EtatCompte, cle: string, periode: number, t: number) {
  const d = e.donnees.get(cle);
  if (d !== undefined && t - d < periode) return false;
  e.donnees.set(cle, t);
  return true;
}

/** Jour à Brazzaville (UTC+1) et heure locale. */
const brazzaville = (t: number) => {
  const d = new Date(t + HEURE);
  return { jour: d.toISOString().slice(0, 10), heure: d.getUTCHours() };
};

export interface Appel {
  t: number;
  classe: Classe;
  query: Record<string, unknown>;
  ip: string;
  ua: string;
  session: string;
  /** Contexte ajouté par l'interface ; null : absent (appel hors interface). */
  contexte: { page: string; interactions: number; visible: boolean } | null;
}

/** Règles de comportement pour une requête (avant le traitement). */
export function observerAppel(e: EtatCompte, a: Appel): Gain[] {
  const g: Gain[] = [];
  const { t, classe } = a;

  // E1, E2 : la même session depuis deux navigateurs, ou un changement d'adresse
  const s = e.sessions.get(a.session);
  if (s) {
    if (
      s.ua !== a.ua &&
      t - s.t < 2 * MINUTE &&
      unePar(e, `E1:${a.session}`, HEURE, t)
    )
      g.push({
        regle: 'E1_DEUX_NAVIGATEURS',
        details: { avant: s.ua, maintenant: a.ua },
      });
    else if (
      s.ua === a.ua &&
      // Adresse inconnue d'un côté (relais, réseau local) : rien à comparer
      !!s.ip &&
      !!a.ip &&
      s.ip !== a.ip &&
      unePar(e, `E2:${a.session}`, HEURE, t)
    )
      g.push({
        regle: 'E2_CHANGEMENT',
        details: { avant: s.ip, maintenant: a.ip },
      });
  }
  e.sessions.set(a.session, { ip: a.ip, ua: a.ua, t });
  if (e.sessions.size > 20) {
    const plusVieille = [...e.sessions.keys()][0];
    if (plusVieille) e.sessions.delete(plusVieille);
  }

  // Contexte de l'interface : interactions humaines et onglet visible
  if (a.contexte?.interactions) e.derniereInteraction = t;
  if (classe.commune) return g;
  if (!a.contexte && unePar(e, 'A3', 0, t))
    g.push({ regle: 'A3_HORS_INTERFACE' });

  // Écritures (enregistrements, imports) : jamais comptées dans la vitesse ni le volume
  if (!classe.lecture) return g;

  // C1 : rafale
  e.appels = e.appels.filter((x) => t - x < MINUTE);
  e.appels.push(t);
  if (e.appels.length > 240 && unePar(e, 'C1', MINUTE, t))
    g.push({
      regle: 'C1_RAFALE',
      details: { appelsParMinute: e.appels.length },
    });

  // C6 : pas de pause ; C7 : régularité de machine
  if (e.dernierAppel && t - e.dernierAppel > 2 * MINUTE) {
    e.debutActivite = t;
    e.intervalles = [];
  } else if (e.dernierAppel) {
    const ecart = t - e.dernierAppel;
    // Les appels d'une même page partent ensemble : seuls les écarts de plus d'une seconde comptent
    if (ecart > 1000) {
      e.intervalles.push(ecart);
      if (e.intervalles.length > 20) e.intervalles.shift();
    }
  }
  e.dernierAppel = t;
  if (t - e.debutActivite > HEURE && unePar(e, 'C6', HEURE, t))
    g.push({
      regle: 'C6_SANS_PAUSE',
      details: { minutes: Math.round((t - e.debutActivite) / MINUTE) },
    });
  if (e.intervalles.length >= 20) {
    const moy = e.intervalles.reduce((x, y) => x + y, 0) / e.intervalles.length;
    const ecartType = Math.sqrt(
      e.intervalles.reduce((x, y) => x + (y - moy) ** 2, 0) /
        e.intervalles.length,
    );
    if (
      moy < 30_000 &&
      ecartType / moy < 0.08 &&
      unePar(e, 'C7', 30 * MINUTE, t)
    )
      g.push({
        regle: 'C7_REGULARITE',
        details: {
          intervalleMoyenMs: Math.round(moy),
          variation: +(ecartType / moy).toFixed(3),
        },
      });
  }

  const lourde = !!classe.fiche || classe.export;
  const { jour, heure } = brazzaville(t);

  // Fiches : à la minute, dans la journée, à la suite
  if (classe.fiche) {
    const cle = `${classe.fiche.type}:${classe.fiche.id}`;
    e.fichesMinute = e.fichesMinute.filter((x) => t - x.t < MINUTE);
    if (!e.fichesMinute.some((x) => x.cle === cle))
      e.fichesMinute.push({ t, cle });
    if (e.fichesMinute.length > 20 && unePar(e, 'C2', MINUTE, t))
      g.push({
        regle: 'C2_FICHES_MINUTE',
        details: { fiches: e.fichesMinute.length },
      });
    if (e.jour !== jour) {
      e.jour = jour;
      e.fichesJour = new Set();
    }
    e.fichesJour.add(cle);
    if (e.fichesJour.size > 1000 && unePar(e, `C4b:${jour}`, 24 * HEURE, t))
      g.push({
        regle: 'C4_VOLUME_1000',
        details: { fiches: e.fichesJour.size },
      });
    else if (e.fichesJour.size > 300 && unePar(e, `C4a:${jour}`, 24 * HEURE, t))
      g.push({
        regle: 'C4_VOLUME_300',
        details: { fiches: e.fichesJour.size },
      });
    const n = Number(classe.fiche.id);
    if (Number.isInteger(n)) {
      const dernier = e.suiteFiches[e.suiteFiches.length - 1];
      if (
        dernier &&
        dernier.type === classe.fiche.type &&
        Math.abs(n - dernier.id) === 1 &&
        (e.suiteFiches.length < 2 ||
          Math.sign(n - dernier.id) ===
            Math.sign(dernier.id - e.suiteFiches[e.suiteFiches.length - 2].id))
      )
        e.suiteFiches.push({ type: classe.fiche.type, id: n });
      else if (!dernier || dernier.id !== n)
        e.suiteFiches = [{ type: classe.fiche.type, id: n }];
      if (e.suiteFiches.length >= 6 && unePar(e, 'C3f', 10 * MINUTE, t))
        g.push({
          regle: 'C3_PARCOURS',
          details: { fiches: e.suiteFiches.map((x) => x.id) },
        });
    }
    if (a.contexte && !a.contexte.visible && unePar(e, 'D2', 10 * MINUTE, t))
      g.push({ regle: 'D2_ONGLET_CACHE' });
  }

  // C3 : pages d'une liste parcourues à la suite (8 pages de suite en moins de 5 minutes)
  const page = Number(a.query?.page);
  if (Number.isInteger(page) && page > 0) {
    const p = e.pages.get(classe.chemin);
    const suite =
      p && page === p.page + 1 && t - p.t < 5 * MINUTE ? p.suite + 1 : 1;
    e.pages.set(classe.chemin, { page, t, suite });
    if (suite >= 8 && unePar(e, `C3p:${classe.chemin}`, 10 * MINUTE, t))
      g.push({
        regle: 'C3_PARCOURS',
        details: { liste: classe.chemin, pages: suite },
      });
  }

  // C5 : exports
  if (classe.export) {
    e.exports = e.exports.filter((x) => t - x < HEURE);
    e.exports.push(t);
    if (e.exports.length > 15 && unePar(e, 'C5', HEURE, t))
      g.push({ regle: 'C5_EXPORTS', details: { exports: e.exports.length } });
  }

  // D1 : lectures lourdes sans personne derrière l'écran ; D3 : la nuit
  if (
    lourde &&
    a.contexte &&
    t - e.derniereInteraction > 5 * MINUTE &&
    unePar(e, 'D1', 5 * MINUTE, t)
  )
    g.push({
      regle: 'D1_SANS_ACTIVITE',
      details: {
        minutesSansActivite: Math.round((t - e.derniereInteraction) / MINUTE),
      },
    });
  if (lourde && (heure >= 22 || heure < 5) && unePar(e, 'D3', HEURE, t))
    g.push({ regle: 'D3_NUIT', details: { heure } });
  return g;
}

/** Après la réponse : refus en série, fiches inexistantes en série. */
export function observerReponse(
  e: EtatCompte,
  t: number,
  classe: Classe,
  statut: number,
): Gain[] {
  const g: Gain[] = [];
  if (statut === 403 || statut === 400) {
    e.refus = e.refus.filter((x) => t - x < 10 * MINUTE);
    e.refus.push(t);
    if (e.refus.length > 5)
      g.push({ regle: 'A6_REFUS', details: { refus: e.refus.length, statut } });
  }
  if (statut === 404 && classe.fiche) {
    const cle = `${classe.fiche.type}:${classe.fiche.id}`;
    e.introuvables = e.introuvables.filter((x) => t - x.t < 10 * MINUTE);
    if (!e.introuvables.some((x) => x.cle === cle))
      e.introuvables.push({ t, cle });
    if (e.introuvables.length > 5 && unePar(e, 'B2', 10 * MINUTE, t))
      g.push({
        regle: 'B2_INTROUVABLES',
        details: { fiches: e.introuvables.map((x) => x.cle) },
      });
  }
  return g;
}

/** Score qui redescend avec le temps : divisé par deux toutes les `demiVie` minutes. */
export const scoreDecru = (
  score: number,
  depuisMs: number,
  demiVieMin: number,
) => score * Math.pow(0.5, depuisMs / (demiVieMin * MINUTE));
