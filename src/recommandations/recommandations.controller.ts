import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { RecommandationsService } from './recommandations.service';

class PropositionDto {
  @IsOptional() @IsInt() departementId?: number | null;
  @IsOptional() @IsString() @MaxLength(200) etablissement?: string | null;
  @IsString() @MaxLength(300) origine: string;
  @IsOptional() @IsString() @MaxLength(1000) motif?: string | null;
}

class AvisDto {
  @IsIn(['FAVORABLE', 'DEFAVORABLE']) avis: 'FAVORABLE' | 'DEFAVORABLE';
  @IsString() @MaxLength(1000) motif: string;
}

class DecisionDto {
  @IsIn(['VALIDEE', 'REJETEE']) decision: 'VALIDEE' | 'REJETEE';
  @IsOptional() @IsString() @MaxLength(1000) commentaire?: string;
}

/** Recommandations des affectations, mutations et enrôlements : proposition, avis du directeur, décision du DG. */
@Controller()
export class RecommandationsController {
  constructor(private readonly service: RecommandationsService) {}

  @Get('recommandations')
  liste(
    @Query('statut') statut?: string,
    @Query('operation') operation?: string,
    @Query('etape') etape?: string,
  ) {
    return this.service.liste(
      statut || undefined,
      operation || undefined,
      etape || undefined,
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('mutations/:id/recommandations')
  mutation(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: PropositionDto,
  ) {
    return this.service.proposerMutation(u, id, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('enrolement/enroles/:id/recommandations')
  enrolement(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: PropositionDto,
  ) {
    return this.service.proposerEnrolement(u, id, dto);
  }

  @Roles('DIRECTEUR')
  @Post('recommandations/:id/avis')
  avis(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: AvisDto,
  ) {
    return this.service.avis(u, id, dto.avis, dto.motif);
  }

  @Roles('DG')
  @Post('recommandations/:id/decision')
  decider(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.service.decider(u, id, dto.decision, dto.commentaire);
  }
}
