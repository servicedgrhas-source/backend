import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { JournalService, ParametresService } from '../core/core.service';
import type { Role } from '../entities';
import {
  decider,
  deciderVisiteur,
  droitsDe,
  permisInformatique,
  refusInformatique,
  rubriqueDuChemin,
  rolePersoDe,
  type Niveau,
  validerDroits,
  type ConfigDroits,
} from './droits';
import { parametresDeLaRoute } from '../securite/route';
import { compteSignale, SecuriteService } from '../securite/securite.service';
import { SessionService } from './session.service';

/** Paramètre où le DG range les droits par rubrique (Administration › Droits). */
export const CLE_DROITS = 'DROITS_RUBRIQUES';

export interface UtilisateurConnecte {
  id: string;
  email: string;
  nom: string;
  initiales: string | null;
  role: Role;
  departementId: number | null;
  structureId?: number | null;
  /** A un code personnel (sinon, invitation à en créer un). */
  aCode?: boolean;
  /** Rubriques réglées par le DG pour ce compte (rôle puis personne) : le menu en tient compte. */
  droits?: Record<string, Niveau>;
  /** Nom du rôle personnalisé donné par le DG (« Secrétariat DRSC »), sinon absent. */
  rolePerso?: string | null;
  /** Dernier jour d'accès (comptes visiteurs), sinon absent. */
  finAcces?: string | null;
  /**
   * Compte Informatique (DG, 08/11/2026) : sur le serveur, il a les droits de l'administrateur
   * (`role` vaut alors « ADMIN ») ; ce drapeau garde trace du vrai rôle.
   */
  informatique?: boolean;
  /** Compte suspendu par l'outil de détection : toute requête est refusée. */
  suspendu?: boolean;
}

/** Types de fichiers qu'un visiteur ne reçoit jamais (filet de sécurité derrière les adresses). */
const TYPES_FICHIERS =
  /officedocument|msword|ms-excel|application\/pdf|zip|gzip|octet-stream|sql|text\/csv/i;

/**
 * Filet de sécurité du compte visiteur : toute réponse qui serait un fichier (Excel, Word, PDF,
 * archive) ou un téléchargement est remplacée par un refus, quelle que soit l'adresse.
 */
export function bloquerFichiers(res: Response) {
  const setHeader = res.setHeader.bind(res);
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  let bloque = false;
  res.setHeader = ((
    nom: string,
    valeur: number | string | readonly string[],
  ) => {
    const n = nom.toLowerCase();
    if (
      n === 'content-disposition' ||
      (n === 'content-type' && TYPES_FICHIERS.test(String(valeur)))
    ) {
      bloque = true;
      return res;
    }
    return setHeader(nom, valeur);
  }) as Response['setHeader'];
  // Le contenu du fichier n'est jamais envoyé
  res.write = ((...a: unknown[]) => {
    if (!bloque) return write(...a);
    (a.find((x) => typeof x === 'function') as (() => void) | undefined)?.();
    return true;
  }) as Response['write'];
  res.end = ((...a: unknown[]) => {
    if (!bloque) return end(...a);
    res.statusCode = 403;
    res.removeHeader('Content-Length');
    setHeader('Content-Type', 'application/json; charset=utf-8');
    return end(
      JSON.stringify({
        statusCode: 403,
        message:
          'Compte visiteur : la consultation est permise, pas l’impression ni le téléchargement.',
      }),
    );
  }) as Response['end'];
}

const CLE_PUBLIC = 'public';
const CLE_ROLES = 'roles';

/** Route accessible sans authentification. */
export const Public = () => SetMetadata(CLE_PUBLIC, true);

/** Rôles autorisés (ADMIN est toujours autorisé). */
export const Roles = (...roles: Role[]) => SetMetadata(CLE_ROLES, roles);

export const Utilisateur = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): UtilisateurConnecte =>
    ctx.switchToHttp().getRequest<Request & { user: UtilisateurConnecte }>()
      .user,
);

/** Rôles de traitement courant (saisie, import, préparation des notes). */
export const ROLES_TRAITEMENT: Role[] = [
  'AGENT',
  'CHEF_SERVICE',
  'DIRECTEUR',
  'BUREAU_ETUDES',
  'DG',
];

/** Tous les comptes, y compris ceux des structures (routes communes : profil, référentiels). */
export const TOUS_LES_ROLES: Role[] = [
  'AGENT',
  'CHEF_SERVICE',
  'DIRECTEUR',
  'BUREAU_ETUDES',
  'DG',
  'DDEPPSA',
  'CABINET',
  'SECRETARIAT',
  'STRUCTURE',
];

/**
 * Comptes du ministère, sans ceux des écoles et inspections : routes communes de l'interface
 * (menu, paramètres, travail en attente de la personne connectée).
 */
export const ROLES_INTERNES: Role[] = TOUS_LES_ROLES.filter(
  (r) => r !== 'STRUCTURE',
);

/**
 * Voit tout le pays : l'administrateur, la DGRHAS, et un visiteur sans département ni structure
 * (dans les rubriques qui lui sont ouvertes en lecture).
 */
export const voitToutLePays = (u: UtilisateurConnecte) =>
  u.role === 'ADMIN' ||
  ROLES_TRAITEMENT.includes(u.role) ||
  (u.role === 'VISITEUR' && !u.departementId && !u.structureId);

/** Contrôle du travail saisi (chef de service, DRSC, bureau d'études). */
export const ROLES_CONTROLE: Role[] = [
  'CHEF_SERVICE',
  'DIRECTEUR',
  'BUREAU_ETUDES',
  'DG',
];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
    private readonly securite: SecuriteService,
  ) {}

  /** Dernière consultation notée par visiteur et rubrique (une ligne de journal par heure). */
  private readonly consultations = new Map<string, number>();

  /** Le journal garde ce qu'un visiteur a consulté : quelle rubrique, quand. */
  private consultation(u: UtilisateurConnecte, chemin: string) {
    const rubrique = rubriqueDuChemin(chemin);
    if (!rubrique) return;
    const cle = `${u.id}|${rubrique}`;
    const maintenant = Date.now();
    if (maintenant - (this.consultations.get(cle) ?? 0) < 3_600_000) return;
    this.consultations.set(cle, maintenant);
    void this.journal
      .log(u, 'CONSULTATION_VISITEUR', 'rubrique', null, { rubrique })
      .catch(() => undefined);
  }

  /** Réglages enregistrés (une valeur illisible vaut « aucun réglage »). */
  private config(): ConfigDroits {
    try {
      return validerDroits(JSON.parse(this.params.get(CLE_DROITS) || '{}'));
    } catch {
      return { roles: {}, utilisateurs: {} };
    }
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const cibles = [ctx.getHandler(), ctx.getClass()];
    const req = ctx
      .switchToHttp()
      .getRequest<
        Request & { user?: UtilisateurConnecte; routeTrouvee?: boolean }
      >();
    // Une route existe pour cette adresse (une adresse inconnue n'arrive jamais ici)
    req.routeTrouvee = true;
    if (this.reflector.getAllAndOverride<boolean>(CLE_PUBLIC, cibles))
      return true;

    const entete = req.headers.authorization ?? '';
    const jeton = entete.startsWith('Bearer ') ? entete.slice(7).trim() : null;
    if (!jeton) throw new UnauthorizedException('Authentification requise');
    // Le compte est relu en base : désactivation, rôle et sessions fermées valent tout de suite
    req.user = await this.sessions.profilDuJeton(jeton);
    // Outil de détection (08/11/2026) : compte suspendu, puis règles de la requête
    if (req.user.suspendu) throw compteSignale();
    if (
      await this.securite.avant(
        req,
        req.user,
        parametresDeLaRoute(ctx.getClass() as never, ctx.getHandler() as never),
      )
    )
      throw compteSignale();
    // La page des comptes signalés n'existe pas pour les autres comptes : « introuvable » ordinaire,
    // et des points (l'interface ne la leur montre jamais)
    if (
      /^\/api\/securite(\/|$)/.test(req.path) &&
      req.user.role !== 'DG' &&
      req.user.role !== 'ADMIN'
    ) {
      if (await this.securite.pageReservee(req, req.user))
        throw compteSignale();
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    // Sauvegarde de la base (08/11/2026) : le DG, le compte administrateur de départ et les comptes
    // exemptés seulement ; pour tous les autres (administrateurs compris), elle n'existe pas
    if (
      /^\/api\/sauvegarde(\/|$)/.test(req.path) &&
      !this.securite.accesSauvegarde(req.user)
    ) {
      if (await this.securite.pageReservee(req, req.user))
        throw compteSignale();
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    const config = this.config();
    const droits = droitsDe(config, req.user);
    req.user.droits = droits;
    req.user.rolePerso = rolePersoDe(config, req.user.id);

    // Droits par rubrique : lecture seule, rubrique fermée, ou rubrique ouverte en plus du rôle
    const chemin = (req.path ?? '').replace(/^\/api(?=\/|$)/, '');

    // Visiteur : seulement ses rubriques en lecture, sans enregistrement ni fichier
    if (req.user.role === 'VISITEUR') {
      const v = deciderVisiteur(droits, chemin, req.method);
      if (v.decision === 'refuse') throw new ForbiddenException(v.message);
      bloquerFichiers(ctx.switchToHttp().getResponse<Response>());
      this.consultation(req.user, chemin);
      return true;
    }
    const d = decider(droits, chemin, req.method);
    // (l'aperçu d'une règle et son propre code restent permis à l'informatique malgré la lecture seule)
    if (
      d.decision === 'refuse' &&
      !(req.user.role === 'INFORMATIQUE' && permisInformatique(chemin))
    )
      throw new ForbiddenException(d.message);
    // Informatique : la configuration en lecture seule, puis tout le reste comme l'administrateur
    if (req.user.role === 'INFORMATIQUE') {
      const refus = refusInformatique(chemin, req.method);
      if (refus) throw new ForbiddenException(refus);
      req.user.role = 'ADMIN';
      req.user.informatique = true;
      return true;
    }
    // Un compte d'école ou d'inspection n'est jamais ouvert au-delà de ses routes
    if (d.decision === 'permis' && req.user.role !== 'STRUCTURE') return true;

    const roles = this.reflector.getAllAndOverride<Role[]>(CLE_ROLES, cibles);
    // Comptes des structures (écoles, inspections…) : seulement les routes qui les citent
    if (req.user.role === 'STRUCTURE' && !roles?.includes('STRUCTURE'))
      throw new ForbiddenException(
        "Vous n'avez pas les droits pour cette action",
      );
    if (
      roles?.length &&
      req.user.role !== 'ADMIN' &&
      !roles.includes(req.user.role)
    )
      throw new ForbiddenException(
        "Vous n'avez pas les droits pour cette action",
      );
    return true;
  }
}
