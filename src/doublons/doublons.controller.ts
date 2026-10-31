import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { DoublonsCentralService } from './doublons-central.service';

class DecisionDoublonDto {
  @IsString() autreId: string;
  @IsIn(['SUPPRIMER', 'DIFFERENTES']) decision: 'SUPPRIMER' | 'DIFFERENTES';
  @IsOptional() @IsString() @MaxLength(500) motif?: string;
}

/**
 * Contrôle et vérification › Doublons probables (DG, 31/10/2026) : recrutés, base du personnel,
 * registre des volontaires et communautaires, enrôlés. Supprimer : réservé au contrôle (vérifié
 * dans le service) ; deux personnes différentes : ouvert au traitement.
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('doublons')
export class DoublonsController {
  constructor(private readonly service: DoublonsCentralService) {}

  @Get()
  compter() {
    return this.service.compter();
  }

  @Get(':base')
  paires(@Param('base') base: string, @Query('page') page?: string) {
    return this.service.paires(base, Math.max(1, Number(page) || 1));
  }

  @Get(':base/:id')
  candidats(@Param('base') base: string, @Param('id') id: string) {
    return this.service.candidats(base, id);
  }

  @Post(':base/:id')
  trancher(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('base') base: string,
    @Param('id') id: string,
    @Body() dto: DecisionDoublonDto,
  ) {
    return this.service.trancher(
      u,
      base,
      id,
      dto.autreId,
      dto.decision,
      dto.motif,
    );
  }
}
