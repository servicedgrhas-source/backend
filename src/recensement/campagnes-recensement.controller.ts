import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  Roles,
  ROLES_CONTROLE,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { ConstatsTerrainService } from './constats-terrain.service';
import {
  CampagnesRecensementService,
  type SaisieCampagne,
} from './campagnes-recensement.service';

/** Les recensements (campagnes) : ouvrir, corriger, clôturer ou rouvrir. */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
@Controller('recensement/campagnes')
export class CampagnesRecensementController {
  constructor(
    private readonly service: CampagnesRecensementService,
    private readonly constats: ConstatsTerrainService,
  ) {}

  @Get()
  liste() {
    return this.service.liste();
  }

  /** Le bilan du recensement, département par département (écoles, agents vus, non vus). */
  @Get(':id/bilan')
  bilan(@Param('id', ParseIntPipe) id: number) {
    return this.constats.bilan(id);
  }

  /** Le bilan en Excel : synthèse, agents non vus (à vérifier), tous les constats (avec la distance du recenseur à l’école). */
  @Get(':id/bilan.xlsx')
  async bilanExcel(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
    @Query('departement') departement?: string,
  ) {
    const f = await this.constats.bilanExcel(
      id,
      departement ? Number(departement) || undefined : undefined,
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${f.nom.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.nom)}`,
    );
    res.send(f.contenu);
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
