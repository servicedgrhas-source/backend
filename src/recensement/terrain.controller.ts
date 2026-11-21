import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { type ModificationTerrain, TerrainService } from './terrain.service';

/** Recensement sur le terrain : paquet d'une école, puis envoi de ce qui a été complété. */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE')
@Controller('recensement/terrain')
export class TerrainController {
  constructor(private readonly service: TerrainService) {}

  @Get('colonnes')
  colonnes() {
    return this.service.colonnes();
  }

  @Get('ecole/:id')
  paquet(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.paquet(u, id);
  }

  @Post('envoyer')
  @HttpCode(200)
  envoyer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { modifications?: ModificationTerrain[] },
  ) {
    return this.service.envoyer(u, corps?.modifications ?? []);
  }
}
