import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { NomsEcolesService } from './noms-ecoles.service';

/** Noms des écoles : préfixe du cycle + nom propre (DG, 21/11/2026). */
@Roles(...ROLES_TRAITEMENT)
@Controller('ecoles-noms')
export class NomsEcolesController {
  constructor(private readonly service: NomsEcolesService) {}

  @Get()
  analyse() {
    return this.service.analyse();
  }

  /** Renomme toutes les écoles d'un coup : DG (et administrateurs). */
  @Roles('DG')
  @Post('appliquer')
  @HttpCode(200)
  appliquer(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.appliquer(u);
  }
}
