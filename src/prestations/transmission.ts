/**
 * Soit-transmis des demandes de prestation, écrits comme les modèles Word de la DGRHAS (dossier
 * « word », 04/11/2026) :
 * - une demande : « Objet : Transmission d’une (01) demande / de prise en charge en solde. », puis
 *   « J’ai l’honneur de vous faire parvenir, pour compétence, une (01) demande de …, formulée par
 *   monsieur X, instituteur de 3e échelon, indice 488, matricule de solde n° …, en service à …,
 *   département scolaire de … » ;
 * - plusieurs demandes du même type (le cas le plus courant, DG 03/11/2026) : « Transmission de six
 *   (06) demandes de … », « formulées par les agents dont les noms et prénoms suivent, conformément
 *   au tableau ci-après : », et le tableau des agents.
 */

import type { DemandePrestation } from '../entities';
import type {
  ColonneTransmission,
  DefinitionPrestation,
  TransmissionModele,
} from './definitions';
import { type ContexteActe, rendre } from './moteur';

const UNITES = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
];
const DIZAINES = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

/** Nombre en lettres (jusqu'à 999), à la française : « vingt et un », « soixante-dix », « quatre-vingts ». */
export function enLettres(n: number): string {
  if (n < 17) return UNITES[n];
  if (n < 20) return `dix-${UNITES[n - 10]}`;
  if (n < 70) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    return u === 0
      ? DIZAINES[d]
      : u === 1
        ? `${DIZAINES[d]} et un`
        : `${DIZAINES[d]}-${UNITES[u]}`;
  }
  if (n < 80) return n === 71 ? 'soixante et onze' : `soixante-${enLettres(n - 60)}`;
  if (n < 100) return n === 80 ? 'quatre-vingts' : `quatre-vingt-${enLettres(n - 80)}`;
  const c = Math.floor(n / 100);
  const r = n % 100;
  const cent = c === 1 ? 'cent' : `${UNITES[c]} cent${r === 0 ? 's' : ''}`;
  return r === 0 ? cent : `${cent} ${enLettres(r)}`;
}

/** « une (01) demande », « six (06) demandes », « trois (03) demandes ». */
export function nombreDemandes(n: number) {
  const lettres = n === 1 ? 'une' : enLettres(n);
  return `${lettres} (${String(n).padStart(2, '0')}) demande${n > 1 ? 's' : ''}`;
}

/** Libellés des colonnes du tableau, comme dans les modèles. */
export const COLONNES: Record<ColonneTransmission, string> = {
  GRADE: 'Grade',
  FONCTION: 'Fonction',
  TEXTE_RECRUTEMENT: 'Référence du texte de recrutement',
  TEXTE_PROMOTION: 'Référence du texte de dernière promotion',
  NOTE_NOMINATION: 'Référence de la note de nomination',
  DATE_PRISE_SERVICE: 'Date de prise de service',
  MATRICULE: 'Matricule de solde',
  STRUCTURE: 'Structure',
  DEPARTEMENT: 'Département',
};

const dateFr = (d: unknown) =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)
    ? d.slice(0, 10).split('-').reverse().join('-')
    : typeof d === 'string'
      ? d
      : '';
const texte = (v: unknown) =>
  v === null || v === undefined ? '' : String(v).trim();
/** Valeur d'une colonne pour une demande (la demande passe avant la fiche : elle est plus précise). */
export function cellule(
  col: ColonneTransmission,
  d: Pick<DemandePrestation, 'agent' | 'details'>,
): string {
  const a = d.agent;
  const det = d.details ?? {};
  switch (col) {
    case 'GRADE':
      return texte(a.grade);
    case 'FONCTION':
      return texte(a.fonction);
    case 'TEXTE_RECRUTEMENT':
      return texte(det.texteEngagement ?? a.texteRecrutement);
    case 'TEXTE_PROMOTION':
      return texte(det.textePromotion ?? det.texteDernierePromotion);
    case 'NOTE_NOMINATION':
      return texte(det.texteNomination);
    case 'DATE_PRISE_SERVICE':
      return dateFr(det.datePriseService ?? a.datePriseService);
    case 'MATRICULE':
      return texte(a.matricule);
    case 'STRUCTURE':
      return texte(a.lieuService);
    case 'DEPARTEMENT':
      return texte(a.departement);
  }
}

/** Le modèle de la demande, avec sa variante selon un renseignement (rectificatif de nom…). */
export function modeleDe(
  def: DefinitionPrestation,
  details: Record<string, unknown>,
): TransmissionModele {
  const t = def.acteModele.transmission!;
  const v = t.selon ? t.selon.valeurs[String(details[t.selon.champ] ?? '')] : null;
  return { ...t, ...(v ?? {}) };
}

/** « de paiement|de l’indemnité de fin de carrière » → les deux lignes et le texte suivi. */
const coupure = (objet: string) => {
  const [avant, apres] = objet.includes('|') ? objet.split('|') : ['', objet];
  return { avant: avant.trim(), apres: apres.trim(), suivi: `${avant.trim()} ${apres.trim()}`.trim() };
};

/**
 * La phrase d'une demande seule, comme le modèle : « la demande de domiciliation de salaire,
 * formulée par madame X, institutrice de 1er échelon, indice 488, matricule de solde n° …, en
 * service à …, département scolaire de …. »
 */
export function phraseIndividuelle(
  def: DefinitionPrestation,
  ctx: ContexteActe,
): string {
  const t = modeleDe(def, ctx.details);
  const objet = rendre(t.corpsObjet ?? coupure(t.objet).suivi, ctx);
  const debut = t.article === 'la' ? 'la demande' : `${nombreDemandes(1)}`;
  // Le moteur retire l'espace de tête : « … santé formulée par » (primes, sans virgule)
  const espace = /^\s/.test(t.phrase) ? ' ' : '';
  return `${debut} ${objet}${espace}${rendre(t.phrase, ctx)}`
    .replace(/\s+([,.])/g, '$1')
    .replace(/\.\.$/, '.');
}

/** La lettre, prête à imprimer : objet, appel, corps, tableau (collectif), formule de politesse. */
export interface LettreTransmission {
  /** Une ou plusieurs demandes. */
  collective: boolean;
  /** « Transmission d’une (01) demande », puis « de prise en charge en solde. » (deux lignes). */
  objet: [string, string];
  appel: string;
  corps: string;
  colonnes: { cle: ColonneTransmission; libelle: string }[];
  lignes: { numero: string; nomComplet: string; valeurs: string[]; reference: string }[];
  politesse: string;
  destinataire: string;
  /** Qui envoie (en haut à droite, avant « à ») et qui signe (son nom). */
  expediteur: string;
  signataireNom: string | null;
  /** Suffixe du n° (« MEPPSA-CAB-DGRHAS-DRSC-SSC »). */
  suffixeNumero: string;
  lieu: string;
}

/** « Monsieur le directeur général et cher collègue, » → « monsieur le directeur général et cher collègue ». */
export const politesseDe = (appel: string) =>
  `Veuillez agréer, ${appel.replace(/[,\s]+$/, '').replace(/^./, (c) => c.toLowerCase())}, l’expression de ma franche collaboration.`;

/**
 * Écrit le soit-transmis d'une ou plusieurs demandes du même type, accordées. `contexte(d)` donne
 * le contexte du moteur pour chaque demande (fiche, renseignements, paramètres).
 */
export function ecrireTransmission(
  def: DefinitionPrestation,
  demandes: DemandePrestation[],
  contexte: (d: DemandePrestation) => ContexteActe,
  p: {
    destinataire: string;
    appel: string;
    expediteur: string;
    signataireNom: string | null;
    suffixeNumero: string;
    lieu: string;
    reference: (n: number) => string;
  },
): LettreTransmission {
  const premier = contexte(demandes[0]);
  const t = modeleDe(def, premier.details);
  const o = coupure(rendre(t.objet, premier));
  const corpsObjet = t.corpsObjet ? rendre(t.corpsObjet, premier) : o.suivi;
  const collective = demandes.length > 1;
  const nombre = nombreDemandes(demandes.length);
  return {
    collective,
    // « Objet : Transmission d’une (01) demande de paiement » / « de l’indemnité de fin de carrière. »
    objet: [
      `Transmission ${collective ? 'de ' : 'd’'}${nombre}${o.avant ? ` ${o.avant}` : ''}`,
      `${o.apres}.`,
    ],
    appel: p.appel,
    corps: collective
      ? `J’ai l’honneur de vous faire parvenir, pour compétence, ${nombre} ${corpsObjet}, formulées par les agents dont les noms et prénoms suivent, conformément au tableau ci-après :`
      : `J’ai l’honneur de vous faire parvenir, pour compétence, ${phraseIndividuelle(def, premier)}`,
    colonnes: collective
      ? t.colonnes.map((cle) => ({ cle, libelle: COLONNES[cle] }))
      : [],
    lignes: collective
      ? demandes.map((d, i) => ({
          numero: String(i + 1).padStart(2, '0'),
          nomComplet: d.agent.nomComplet,
          valeurs: t.colonnes.map((c) => cellule(c, d)),
          reference: p.reference(d.numero),
        }))
      : [],
    politesse: politesseDe(p.appel),
    destinataire: p.destinataire,
    expediteur: p.expediteur,
    signataireNom: p.signataireNom,
    suffixeNumero: p.suffixeNumero,
    lieu: p.lieu,
  };
}
