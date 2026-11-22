import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
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

  /** Recherche intelligente d'un agent (nom tapé comme on l'entend, ou matricule). */
  @Get('agents')
  agents(@Utilisateur() u: UtilisateurConnecte, @Query('q') q?: string) {
    return this.service.rechercherAgents(u, String(q ?? ''));
  }

  @Get('ecole/:id')
  paquet(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.paquet(u, id);
  }

  /** Signalements du terrain (absent, parti, inconnu ici) : à traiter, ou déjà traités (?traites=1). */
  @Get('signalements')
  signalements(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('traites') traites?: string,
  ) {
    return this.service.signalements(u, traites === '1');
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('signalements/:id/traite')
  @HttpCode(200)
  traiter(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.traiter(u, id);
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
