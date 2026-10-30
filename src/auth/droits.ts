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
  /** Réglages par rôle : rôles du système et rôles personnalisés (« PERSO_… »). */
  roles: Partial<Record<Role, Record<string, Niveau>>> &
    Record<string, Record<string, Niveau>>;
  utilisateurs: Record<string, Record<string, Niveau>>;
  /**
   * Rôles créés par le DG (« Secrétariat DRSC ») : un nom et un rôle de départ (ses actions) ; ses
   * rubriques sont réglées dans `roles` comme pour un rôle du système.
   */
  rolesPerso?: Record<string, { libelle: string; base: Role }>;
  /** Rôle personnalisé de chaque compte (id du compte → code du rôle). */
  attributions?: Record<string, string>;
}

/** Rôles qui ne peuvent pas servir de départ à un rôle personnalisé. */
export const BASES_INTERDITES: Role[] = ['ADMIN', 'DG', 'STRUCTURE'];
const CODE_PERSO = /^PERSO_[A-Z0-9_]{1,40}$/;

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
    rolesPerso?: unknown;
    attributions?: unknown;
  };
  const objet = (v: unknown) =>
    (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<
      string,
      unknown
    >;
  const rolesPerso: NonNullable<ConfigDroits['rolesPerso']> = {};
  for (const [code, v] of Object.entries(objet(b.rolesPerso))) {
    const r = objet(v);
    const libelle = typeof r.libelle === 'string' ? r.libelle.trim() : '';
    if (!CODE_PERSO.test(code)) continue;
    if (!libelle || libelle.length > 60)
      throw new BadRequestException(
        'Nom de rôle vide ou trop long (60 caractères au plus).',
      );
    if (
      !ROLES.includes(r.base as Role) ||
      BASES_INTERDITES.includes(r.base as Role)
    )
      throw new BadRequestException(
        `Rôle de départ non permis pour « ${libelle} ».`,
      );
    rolesPerso[code] = { libelle, base: r.base as Role };
  }
  const libelles = Object.values(rolesPerso).map((r) =>
    r.libelle.toLowerCase(),
  );
  if (new Set(libelles).size !== libelles.length)
    throw new BadRequestException('Deux rôles portent le même nom.');
  const attributions: Record<string, string> = {};
  for (const [id, code] of Object.entries(objet(b.attributions)))
    if (UUID.test(id) && typeof code === 'string' && rolesPerso[code])
      attributions[id] = code;
  const roles: ConfigDroits['roles'] = {};
  for (const [r, v] of Object.entries(
    (b.roles && typeof b.roles === 'object' ? b.roles : {}) as Record<
      string,
      unknown
    >,
  )) {
    const systeme =
      ROLES.includes(r as Role) && !ROLES_LIBRES.includes(r as Role);
    if (!systeme && !rolesPerso[r]) continue;
    const n = niveaux(v);
    if (Object.keys(n).length) roles[r] = n;
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
  return { roles, utilisateurs, rolesPerso, attributions };
}

/**
 * Réglages qui valent pour ce compte : ceux de son rôle, puis ceux de son rôle personnalisé, puis
 * les siens par-dessus.
 */
export function droitsDe(
  c: ConfigDroits,
  u: { id: string; role: Role },
): Record<string, Niveau> {
  if (ROLES_LIBRES.includes(u.role)) return {};
  const perso = c.attributions?.[u.id];
  return {
    ...(c.roles[u.role] ?? {}),
    ...(perso && c.rolesPerso?.[perso] ? (c.roles[perso] ?? {}) : {}),
    ...(c.utilisateurs[u.id] ?? {}),
  };
}

/** Nom du rôle personnalisé d'un compte (affiché à la place de son rôle), sinon null. */
export function rolePersoDe(c: ConfigDroits, id: string): string | null {
  const code = c.attributions?.[id];
  return (code && c.rolesPerso?.[code]?.libelle) || null;
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
