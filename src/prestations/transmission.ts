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
/** « 3e échelon », « 1er échelon ». */
const echelon = (e: string | null | undefined) =>
  e ? `${e}${e === '1' ? 'er' : 'e'} échelon` : null;

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

/**
 * La phrase d'une demande seule : « une (01) demande de …, formulée par monsieur X, grade de
 * 3e échelon, indice …, matricule de solde n° …, en service à …, département scolaire de …[suite]. »
 */
export function phraseIndividuelle(
  def: DefinitionPrestation,
  ctx: ContexteActe,
): string {
  const t = def.acteModele.transmission!;
  if (t.corps) return rendre(t.corps, ctx);
  const a = ctx.agent;
  const civilite = a.genre === 'F' ? 'madame' : 'monsieur';
  const identite = [
    [a.grade, echelon(a.echelon)].filter(Boolean).join(' de '),
    a.indice && `indice ${a.indice}`,
    a.matricule && `matricule de solde n° ${a.matricule}`,
  ]
    .filter(Boolean)
    .join(', ');
  const morceaux = [
    `${nombreDemandes(1)} ${rendre(t.demande, ctx)}`,
    `, formulée par ${civilite} ${a.nomComplet}`,
    identite ? `, ${identite}` : '',
    t.apresIdentite ? rendre(t.apresIdentite, ctx) : '',
    a.lieuService ? `, en service à ${a.lieuService}` : '',
    a.departement ? `, département scolaire de ${a.departement}` : '',
    t.suite ? rendre(t.suite, ctx) : '',
  ];
  return `${morceaux.join('').replace(/\s+([,.])/g, '$1').trim()}.`;
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
  const t = def.acteModele.transmission!;
  const premier = contexte(demandes[0]);
  const demande = rendre(t.demande, premier);
  const collective = demandes.length > 1;
  const nombre = nombreDemandes(demandes.length);
  return {
    collective,
    objet: [
      `Transmission ${collective ? 'de' : 'd’'}${collective ? ' ' : ''}${nombre}`,
      `${demande}.`,
    ],
    appel: p.appel,
    corps: collective
      ? `J’ai l’honneur de vous faire parvenir, pour compétence, ${nombre} ${demande}, formulées par les agents dont les noms et prénoms suivent, conformément au tableau ci-après :`
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
