import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { PlacementNominationsService } from './placement.service';

/** Placer les nommés dans l'organigramme : essai, puis enregistrement (DG et administrateurs). */
@Roles(...ROLES_TRAITEMENT)
@Controller('nominations-placement')
export class PlacementNominationsController {
  constructor(private readonly service: PlacementNominationsService) {}

  @Get()
  analyse(@Query('annee') annee?: string) {
    return this.service.analyse(annee || undefined);
  }

  @Roles('DG')
  @Post('appliquer')
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { annee?: unknown; placer?: unknown; ajouter?: unknown },
  ) {
    const placer = Array.isArray(corps?.placer)
      ? corps.placer.filter((x): x is number => Number.isInteger(x))
      : [];
    const ajouter = Array.isArray(corps?.ajouter)
      ? (corps.ajouter as { id?: unknown; inspectionId?: unknown }[])
          .filter(
            (x) => Number.isInteger(x?.id) && Number.isInteger(x?.inspectionId),
          )
          .map((x) => ({
            id: x.id as number,
            inspectionId: x.inspectionId as number,
          }))
      : [];
    return this.service.appliquer(
      u,
      typeof corps?.annee === 'string' ? corps.annee : '',
      {
        placer: placer.slice(0, 20000),
        ajouter: ajouter.slice(0, 5000),
      },
    );
  }
}
