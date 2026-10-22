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
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Role } from '../entities';

export interface UtilisateurConnecte {
  id: string;
  email: string;
  nom: string;
  initiales: string | null;
  role: Role;
  departementId: number | null;
  structureId?: number | null;
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
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const cibles = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(CLE_PUBLIC, cibles))
      return true;

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: UtilisateurConnecte }>();
    const entete = req.headers.authorization ?? '';
    const jeton = entete.startsWith('Bearer ') ? entete.slice(7) : null;
    if (!jeton) throw new UnauthorizedException('Authentification requise');
    try {
      req.user = await this.jwt.verifyAsync<UtilisateurConnecte>(jeton);
    } catch {
      throw new UnauthorizedException('Session expirée, reconnectez-vous');
    }

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
