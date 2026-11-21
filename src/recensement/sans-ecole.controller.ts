import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { SansEcoleService } from './sans-ecole.service';

/** Agents sans école : lieux écrits à rattacher, lieux écrits qui contredisent l'école. */
@Roles(...ROLES_TRAITEMENT)
@Controller('recensement/sans-ecole')
export class SansEcoleController {
  constructor(private readonly service: SansEcoleService) {}

  @Get()
  analyse() {
    return this.service.analyse();
  }

  /** Rattacher et aligner (DG et administrateurs) : touche des milliers de fiches d'un coup. */
  @Roles('DG')
  @Post('appliquer')
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { rattacher?: unknown; aligner?: unknown },
  ) {
    const rattacher = Array.isArray(corps?.rattacher)
      ? (corps.rattacher as { cle?: unknown; structureId?: unknown }[])
          .filter(
            (x) =>
              typeof x?.cle === 'string' && Number.isInteger(x?.structureId),
          )
          .map((x) => ({
            cle: x.cle as string,
            structureId: x.structureId as number,
          }))
          .slice(0, 20000)
      : [];
    const aligner = Array.isArray(corps?.aligner)
      ? corps.aligner
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 20000)
      : [];
    return this.service.appliquer(u, { rattacher, aligner });
  }
}
