import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  Roles,
  ROLES_CONTROLE,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import {
  CampagnesRecensementService,
  type SaisieCampagne,
} from './campagnes-recensement.service';

/** Les recensements (campagnes) : ouvrir, corriger, clôturer ou rouvrir. */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
@Controller('recensement/campagnes')
export class CampagnesRecensementController {
  constructor(private readonly service: CampagnesRecensementService) {}

  @Get()
  liste() {
    return this.service.liste();
  }

  @Roles(...ROLES_CONTROLE)
  @Post()
  creer(@Utilisateur() u: UtilisateurConnecte, @Body() corps: SaisieCampagne) {
    return this.service.creer(u, corps ?? {});
  }

  @Roles(...ROLES_CONTROLE)
  @Put(':id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() corps: SaisieCampagne,
  ) {
    return this.service.modifier(u, id, corps ?? {});
  }

  @Roles(...ROLES_CONTROLE)
  @Post(':id/cloturer')
  cloturer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.cloturer(u, id, true);
  }

  @Roles(...ROLES_CONTROLE)
  @Post(':id/rouvrir')
  rouvrir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.cloturer(u, id, false);
  }
}
