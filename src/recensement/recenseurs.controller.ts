import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  Roles,
  ROLES_CONTROLE,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { RecenseursService, type SaisieRecenseurs } from './recenseurs.service';

/** Planification des recenseurs de la mission de terrain (comptes, départements, dates, effacement). */
@Roles(...ROLES_TRAITEMENT)
@Controller('recensement/recenseurs')
export class RecenseursController {
  constructor(private readonly service: RecenseursService) {}

  @Get()
  liste() {
    return this.service.liste();
  }

  /** Suivi depuis Brazzaville (DG et administrateur) : positions, signal coupé, trajets, envois. */
  @Roles('DG', 'ADMIN')
  @Get('suivi')
  suivi(@Query('jour') jour?: string) {
    return this.service.suivi(jour);
  }

  /** Créer un ou plusieurs recenseurs (un nom par ligne), avec leurs départements et leurs dates. */
  @Roles(...ROLES_CONTROLE)
  @Post()
  creer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: SaisieRecenseurs,
  ) {
    return this.service.creer(u, corps ?? ({} as SaisieRecenseurs));
  }

  @Roles(...ROLES_CONTROLE)
  @Put(':id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    corps: {
      nom?: string;
      code?: string;
      departements?: number[];
      debut?: string | null;
      fin?: string | null;
      telephones?: string[];
    },
  ) {
    return this.service.modifier(u, id, corps ?? {});
  }

  @Roles(...ROLES_CONTROLE)
  @Post(':id/mot-de-passe')
  @HttpCode(200)
  motDePasse(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.nouveauMotDePasse(u, id);
  }

  /** Arrêter sa mission et effacer son appareil à la prochaine connexion. */
  @Roles(...ROLES_CONTROLE)
  @Post(':id/effacer')
  @HttpCode(200)
  effacer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.effacer(u, id);
  }

  /** Bloquer : compte suspendu, données gardées sur sa tablette. */
  @Roles(...ROLES_CONTROLE)
  @Post(':id/bloquer')
  @HttpCode(200)
  bloquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.bloquer(u, id);
  }

  @Roles(...ROLES_CONTROLE)
  @Post(':id/debloquer')
  @HttpCode(200)
  debloquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.debloquer(u, id);
  }

  @Roles(...ROLES_CONTROLE)
  @Post(':id/reprendre')
  @HttpCode(200)
  reprendre(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.reprendre(u, id);
  }
}
