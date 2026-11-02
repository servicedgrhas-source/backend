/**
 * Moteur des demandes de prestations (DG, 02/11/2026) : une prestation n'est plus du code, mais
 * une définition (definitions.ts) — renseignements, pièces, modèle de l'acte. Le même moteur
 * contrôle le formulaire, construit le circuit (catalogue) et écrit l'acte à partir du modèle.
 * Introduire une des 58 prestations, c'est écrire sa définition.
 *
 * Langage des modèles d'acte :
 * - `{agent}` : « Monsieur X, grade, catégorie, échelle, échelon, matricule … » ;
 * - `{enService}` : « , en service à … » (rien si le lieu n'est pas connu) ;
 * - `{agent.departement}`, `{agent.lieuService}`, `{agent.nomComplet}`… : un renseignement de la fiche ;
 * - `{champ:cle}` : un renseignement de la demande (le libellé pour une liste ou un département) ;
 *   `{champ:cle|min}` : en minuscules ;
 * - `{acte:cle}` : pour une liste, le texte de l'option prévu pour l'acte (`acte` de l'option,
 *   « directeur départemental|directrice départementale » : masculin|féminin) ;
 * - `{decideur.poste}`, `{decideur.nom}`, `{decideur.sigle}` : la structure qui a décidé (pour un
 *   certificat du lieu de service : « Directeur d'école », « École primaire de … ») ;
 * - `{param:CLE}` : un paramètre de l'administration (destinataire et signataire des soit-transmis…) ;
 * - `{f:affecté|affectée}` : masculin ou féminin selon l'agent ;
 * - `[[ … ]]` : morceau écrit seulement si tous ses repères ont une valeur.
 * Un repère sans valeur hors de `[[ … ]]` s'écrit « … » (à compléter à la main).
 */

import { enTexte } from '../common/texte';
import type { ChampPrestation } from './definitions';

export interface ContexteActe {
  agent: Record<string, string | null | undefined> & {
    genre: 'M' | 'F';
    nomComplet: string;
  };
  details: Record<string, unknown>;
  champs: ChampPrestation[];
  /** Structure qui a décidé (dernier visa) : son responsable signe les certificats du lieu de service. */
  decideur?: { sigle: string; nom: string; poste: string } | null;
  /** Paramètres de l'administration (Administration › Paramètres). */
  param?: (cle: string) => string | null;
}

const MANQUE = '…';
const REPERE = /\{([^{}]+)\}/g;

/** Masculin|féminin : « affecté|affectée » → l'un ou l'autre. */
const genre = (t: string, femme: boolean) => {
  const [m, f] = t.split('|');
  return femme ? (f ?? m) : m;
};

/** Valeur d'un repère, ou null s'il n'en a pas. Lève une erreur si le repère est inconnu. */
export function valeurRepere(repere: string, c: ContexteActe): string | null {
  const femme = c.agent.genre === 'F';
  const [nom, ...reste] = repere.split(':');
  const arg = reste.join(':');
  if (repere === 'agent') {
    const a = c.agent;
    const situation = [
      a.grade,
      a.categorie && `catégorie ${a.categorie}`,
      a.echelle && `échelle ${a.echelle}`,
      a.echelon && `${a.echelon}${a.echelon === '1' ? 'er' : 'e'} échelon`,
    ]
      .filter(Boolean)
      .join(', ');
    return `${femme ? 'Madame' : 'Monsieur'} ${a.nomComplet}${situation ? `, ${situation}` : ''}${a.matricule ? `, matricule ${a.matricule}` : ''}`;
  }
  if (repere === 'enService')
    return c.agent.lieuService ? `, en service à ${c.agent.lieuService}` : '';
  if (repere.startsWith('decideur.')) {
    const cle = repere.slice(9);
    if (!['sigle', 'nom', 'poste'].includes(cle))
      throw new Error(`Repère inconnu : {${repere}}`);
    const v = c.decideur?.[cle as 'sigle' | 'nom' | 'poste'];
    return v
      ? cle === 'poste'
        ? v.charAt(0).toLowerCase() + v.slice(1)
        : v
      : null;
  }
  if (repere.startsWith('agent.')) {
    const v = c.agent[repere.slice(6)];
    return v ? String(v) : null;
  }
  if (nom === 'f') return genre(arg, femme);
  if (nom === 'param') {
    if (!/^[A-Z_]+$/.test(arg)) throw new Error(`Repère inconnu : {${repere}}`);
    return c.param?.(arg)?.trim() || null;
  }
  if (nom === 'champ' || nom === 'acte') {
    const [cle, option] = arg.split('|');
    const champ = c.champs.find((x) => x.cle === cle);
    if (!champ)
      throw new Error(`Repère inconnu : {${repere}} (aucun champ « ${cle} »)`);
    const brut = c.details[cle];
    if (brut === undefined || brut === null || brut === '') return null;
    let v: string;
    if (nom === 'acte') {
      const o = champ.options?.find((x) => x.valeur === brut);
      v = genre(o?.acte ?? o?.libelle ?? enTexte(brut), femme);
    } else if (champ.type === 'departement')
      v = enTexte(c.details[`${cle}Nom`] ?? brut);
    else if (champ.type === 'liste')
      v = enTexte(c.details[`${cle}Libelle`] ?? brut);
    else if (champ.type === 'date')
      v = enTexte(brut).split('-').reverse().join('/');
    else v = enTexte(brut);
    return option === 'min' ? v.toLowerCase() : v;
  }
  throw new Error(`Repère inconnu : {${repere}}`);
}

/** Écrit un texte du modèle : repères remplacés, morceaux facultatifs gardés ou retirés. */
export function rendre(modele: string, c: ContexteActe): string {
  const avecFacultatifs = modele.replace(
    /\[\[([\s\S]*?)\]\]/g,
    (_, morceau: string) => {
      const reperes = [...morceau.matchAll(REPERE)].map((m) => m[1]);
      return reperes.every((r) => {
        const v = valeurRepere(r, c);
        return v !== null && v !== '';
      })
        ? morceau
        : '';
    },
  );
  return avecFacultatifs
    .replace(REPERE, (_, r: string) => valeurRepere(r, c) ?? MANQUE)
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Repères employés par un modèle (pour vérifier une définition sans demande réelle). */
export function reperesDe(modele: string) {
  return [...modele.matchAll(REPERE)].map((m) => m[1]);
}
