import { BadRequestException } from '@nestjs/common';
import { ROLES, type Role } from '../entities';

/**
 * Droits par rubrique (réunion DG du 26/10/2026) : pour chaque rôle, et pour une personne en
 * particulier, le DG choisit les rubriques du menu que l'on voit et ce qu'on peut y faire.
 *
 * - MASQUE : la rubrique n'apparaît pas et ses enregistrements sont refusés ;
 * - LECTURE : on la consulte, mais tout enregistrement est refusé ;
 * - MODIFICATION : on la voit et on y travaille, même si le rôle ne l'a pas d'origine.
 * Sans réglage, la rubrique suit les droits d'origine du rôle.
 * Le réglage d'une personne passe avant celui de son rôle. L'administrateur et le DG voient tout.
 */
export type Niveau = 'MASQUE' | 'LECTURE' | 'MODIFICATION';
export const NIVEAUX: Niveau[] = ['MASQUE', 'LECTURE', 'MODIFICATION'];

export interface ConfigDroits {
  roles: Partial<Record<Role, Record<string, Niveau>>>;
  utilisateurs: Record<string, Record<string, Niveau>>;
}

/** Rôles que l'on ne règle pas : ils voient et font tout. */
export const ROLES_LIBRES: Role[] = ['ADMIN', 'DG'];

/**
 * Chaque rubrique du menu (son adresse, sans « ?… ») et les adresses du serveur qui lui
 * appartiennent (« /api/… » sans le préfixe). Une adresse appartient à la rubrique dont
 * l'adresse serveur est la plus précise ; une adresse partagée par plusieurs rubriques
 * reste permise dès que l'une d'elles l'est. Les lectures communes (paramètres, référentiels,
 * organigramme) ne sont pas citées : elles servent à toutes les pages.
 */
export const RUBRIQUES_API: Record<string, string[]> = {
  '/candidats': ['candidats'],
  '/transmission': ['transmissions'],
  '/reception': ['reception'],
  '/recrutement': ['agents', 'import/base', 'recrutes/export'],
  '/commission': ['commission'],
  '/pilotage': ['pilotage'],
  '/lots': ['lots'],
  '/affectations': ['affectations', 'deport'],
  '/recommandations': ['recommandations'],
  '/statistiques': ['statistiques', 'agents/statistiques'],
  '/enrolement/campagne': ['enrolement/campagnes', 'enrolement/membres'],
  '/enrolement/saisie': [
    'enrolement/dossiers',
    'enrolement/import',
    'enrolement/controler',
    'enrolement/decider',
    'enrolement/doublons',
  ],
  '/enrolement/base': ['enrolement/dossiers'],
  '/notes/enrolement': ['notes', 'notes/preparer/enrolement'],
  '/enrolement/volontaires': [
    'enrolement/volontaires',
    'enrolement/volontaires-correction',
    'enrolement/volontaires-valeurs',
  ],
  '/enrolement/bottin': ['enrolement/bottin'],
  '/enrolement/bourse': ['enrolement/bourse'],
  '/enrolement/mise-en-route': ['enrolement/mises-en-route'],
  '/enrolement/regularisations': ['enrolement/regularisations'],
  '/enrolement/tableau': ['enrolement/tableau'],
  '/enrolement/configuration': ['enrolement/configuration'],
  '/recensement': ['recensement/tableau'],
  '/personnel': [],
  '/personnel/agents': [
    'recensement/agents',
    'recensement/pieces',
    'recensement/export',
  ],
  '/personnel/presence': ['presence'],
  '/personnel/evaluations': ['evaluations'],
  '/personnel/retards-echelons': ['recensement/retards-echelons'],
  '/structures/besoins-administratifs': ['besoins-administratifs'],
  '/personnel/import': [
    'recensement/import',
    'recensement/analyse',
    'recensement/modele',
  ],
  '/personnel/configuration': ['recensement/configuration'],
  '/mutations/nouvelle': ['mutations'],
  '/mutations': ['mutations'],
  '/mutations/statistiques': ['mutations/statistiques'],
  '/demandes/nouvelle': ['demandes'],
  '/structures': [],
  '/ecoles': ['etablissements'],
  '/ecoles/besoins': ['etablissements/besoins'],
  '/enrolement/besoins': ['enrolement/besoins'],
  '/notes/affectation': ['notes', 'notes/preparer/affectation'],
  '/notes/mutation': ['notes', 'notes/preparer/mutation'],
  '/notes/nomination': ['notes', 'notes/preparer/nomination'],
  '/nominations': ['nominations'],
  '/rapprochement': ['rapprochement', 'anciens', 'controle-affectations'],
  '/administration': ['utilisateurs'],
  '/administration/parametres': ['parametres'],
  '/administration/regles': ['configuration'],
  '/administration/organigramme': ['structures'],
  '/administration/referentiels': [
    'referentiels/valeurs',
    'referentiels/import-ancien',
  ],
  '/administration/prestations': ['prestations'],
  '/administration/origines': ['origines'],
  '/administration/menu': ['menu/configuration'],
  '/journal': ['journal'],
};

/** Ce que l'on ne peut jamais fermer : la page des droits elle-même. */
const RUBRIQUES_FIXES = new Set(['/administration/droits']);

/**
 * Rubriques que l'on peut fermer ou mettre en lecture seule, mais jamais ouvrir au-delà du rôle :
 * les comptes (sinon un compte ouvert pourrait se donner plus de droits).
 */
export const RUBRIQUES_NON_OUVRABLES = new Set(['/administration']);

const UUID = /^[0-9a-f-]{36}$/;

function niveaux(brut: unknown): Record<string, Niveau> {
  const sortie: Record<string, Niveau> = {};
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return sortie;
  for (const [k, v] of Object.entries(brut as Record<string, unknown>)) {
    if (!(k in RUBRIQUES_API) || RUBRIQUES_FIXES.has(k)) continue;
    if (!NIVEAUX.includes(v as Niveau))
      throw new BadRequestException(`Niveau inconnu pour la rubrique ${k}.`);
    sortie[k] = v as Niveau;
  }
  return sortie;
}

/** Ne garde que ce qui a une forme valide (rubriques connues, niveaux connus). */
export function validerDroits(brut: unknown): ConfigDroits {
  const b = (brut && typeof brut === 'object' ? brut : {}) as {
    roles?: unknown;
    utilisateurs?: unknown;
  };
  const roles: ConfigDroits['roles'] = {};
  for (const [r, v] of Object.entries(
    (b.roles && typeof b.roles === 'object' ? b.roles : {}) as Record<
      string,
      unknown
    >,
  )) {
    if (!ROLES.includes(r as Role) || ROLES_LIBRES.includes(r as Role))
      continue;
    const n = niveaux(v);
    if (Object.keys(n).length) roles[r as Role] = n;
  }
  const utilisateurs: ConfigDroits['utilisateurs'] = {};
  for (const [id, v] of Object.entries(
    (b.utilisateurs && typeof b.utilisateurs === 'object'
      ? b.utilisateurs
      : {}) as Record<string, unknown>,
  )) {
    if (!UUID.test(id)) continue;
    const n = niveaux(v);
    if (Object.keys(n).length) utilisateurs[id] = n;
  }
  return { roles, utilisateurs };
}

/** Réglages qui valent pour ce compte : ceux de son rôle, puis les siens par-dessus. */
export function droitsDe(
  c: ConfigDroits,
  u: { id: string; role: Role },
): Record<string, Niveau> {
  if (ROLES_LIBRES.includes(u.role)) return {};
  return { ...(c.roles[u.role] ?? {}), ...(c.utilisateurs[u.id] ?? {}) };
}

/** Rubriques propriétaires d'une adresse du serveur (la correspondance la plus précise). */
export function rubriquesDe(chemin: string): string[] {
  const c = chemin.replace(/^\/+|\/+$/g, '');
  let long = -1;
  let trouvees: string[] = [];
  for (const [r, prefixes] of Object.entries(RUBRIQUES_API))
    for (const p of prefixes)
      if (c === p || c.startsWith(`${p}/`)) {
        if (p.length > long) {
          long = p.length;
          trouvees = [r];
        } else if (p.length === long && !trouvees.includes(r)) trouvees.push(r);
      }
  return trouvees;
}

/**
 * Décision pour une requête :
 * - « permis » : un réglage ouvre la rubrique (le contrôle d'origine du rôle est levé) ;
 * - « refuse » : la rubrique est en lecture seule ou masquée, et c'est un enregistrement ;
 * - « normal » : on applique les droits d'origine du rôle.
 */
export function decider(
  droits: Record<string, Niveau>,
  chemin: string,
  methode: string,
): { decision: 'permis' | 'normal' } | { decision: 'refuse'; message: string } {
  const proprietaires = rubriquesDe(chemin);
  if (!proprietaires.length) return { decision: 'normal' };
  const n = proprietaires.map((r) =>
    RUBRIQUES_NON_OUVRABLES.has(r) && droits[r] !== 'MASQUE'
      ? droits[r] === 'LECTURE'
        ? 'LECTURE_SEULE'
        : undefined
      : droits[r],
  );
  const lecture = ['GET', 'HEAD', 'OPTIONS'].includes(methode.toUpperCase());
  if (n.includes('MODIFICATION')) return { decision: 'permis' };
  if (n.includes(undefined)) return { decision: 'normal' };
  if (lecture) return { decision: n.includes('LECTURE') ? 'permis' : 'normal' };
  if (n.includes('LECTURE_SEULE'))
    return {
      decision: 'refuse',
      message:
        'Cette rubrique vous est ouverte en lecture seule : vous pouvez la consulter, pas la modifier.',
    };
  return {
    decision: 'refuse',
    message: n.includes('LECTURE')
      ? 'Cette rubrique vous est ouverte en lecture seule : vous pouvez la consulter, pas la modifier.'
      : 'Cette rubrique ne vous est pas ouverte.',
  };
}
