import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { RetraitsService } from './retraits.service';

/** Base des retraits : volontaires et communautaires non payés en bourse, hors des effectifs. */
@Roles(...ROLES_TRAITEMENT)
@Controller('recensement/retraits')
export class RetraitsController {
  constructor(private readonly service: RetraitsService) {}

  @Get()
  liste(
    @Query('motif') motif?: string,
    @Query('statut') statut?: string,
    @Query('recherche') recherche?: string,
    @Query('page') page?: string,
  ) {
    return this.service.liste({
      motif,
      statut,
      recherche,
      page: Number(page) || 1,
    });
  }

  /** Ce que la mise en retrait ferait, groupe par groupe (DG). */
  @Roles('DG')
  @Get('apercu')
  apercu() {
    return this.service.apercu();
  }

  /** Mettre en retrait les groupes choisis (DG : touche des milliers de fiches d'un coup). */
  @Roles('DG')
  @Post('appliquer')
  @HttpCode(200)
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { motifs?: unknown },
  ) {
    return this.service.appliquer(
      u,
      Array.isArray(corps?.motifs) ? corps.motifs.map(String) : [],
    );
  }

  /** Réintégrer des fiches dans la base (DG). */
  @Roles('DG')
  @Post('reintegrer')
  @HttpCode(200)
  reintegrer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { ids?: unknown },
  ) {
    return this.service.reintegrer(
      u,
      Array.isArray(corps?.ids) ? corps.ids.map(Number) : [],
    );
  }
}
