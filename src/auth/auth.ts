import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ParametresService } from '../core/core.service';
import type { Role } from '../entities';
import {
  decider,
  droitsDe,
  rolePersoDe,
  type Niveau,
  validerDroits,
  type ConfigDroits,
} from './droits';
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
  ) {}

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
    if (this.reflector.getAllAndOverride<boolean>(CLE_PUBLIC, cibles))
      return true;

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: UtilisateurConnecte }>();
    const entete = req.headers.authorization ?? '';
    const jeton = entete.startsWith('Bearer ') ? entete.slice(7).trim() : null;
    if (!jeton) throw new UnauthorizedException('Authentification requise');
    // Le compte est relu en base : désactivation, rôle et sessions fermées valent tout de suite
    req.user = await this.sessions.profilDuJeton(jeton);
    const config = this.config();
    const droits = droitsDe(config, req.user);
    req.user.droits = droits;
    req.user.rolePerso = rolePersoDe(config, req.user.id);

    // Droits par rubrique : lecture seule, rubrique fermée, ou rubrique ouverte en plus du rôle
    const chemin = (req.path ?? '').replace(/^\/api(?=\/|$)/, '');
    const d = decider(droits, chemin, req.method);
    if (d.decision === 'refuse') throw new ForbiddenException(d.message);
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
