import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  Roles,
  ROLES_CONTROLE,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { RattachementService } from './rattachement.service';

class DecisionDto {
  @IsIn(['LIER', 'CREER', 'SANS_FICHE']) action:
    'LIER' | 'CREER' | 'SANS_FICHE';
  @IsOptional() @IsInt() agentId?: number;
}
class ValidationDto {
  @IsIn(['VALIDER', 'REJETER', 'SUPPRIMER']) action:
    'VALIDER' | 'REJETER' | 'SUPPRIMER';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Mutations et nominations rattachées à la base du personnel (DG, 31/10/2026). */
@Roles(...ROLES_TRAITEMENT)
@Controller('rattachement')
export class RattachementController {
  constructor(private readonly service: RattachementService) {}

  /** Fiches créées depuis une mutation ou une nomination, à valider. */
  @Get('fiches/a-valider')
  fichesAValider() {
    return this.service.fichesAValider();
  }

  @Roles(...ROLES_CONTROLE)
  @Post('fiches/:id')
  validerFiche(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ValidationDto,
  ) {
    return this.service.validerFiche(u, id, dto.action, dto.note);
  }

  @Get(':module')
  bilan(@Param('module') module: string) {
    return this.service.bilan(module);
  }

  @Get(':module/a-trancher')
  aTrancher(@Param('module') module: string) {
    return this.service.aTrancher(module);
  }

  /** Relancer le rattachement (après un import du personnel, par exemple). */
  @Post(':module/relancer')
  relancer(@Param('module') module: string) {
    return this.service.rattacher(module);
  }

  @Post(':module/creer-toutes')
  creerToutes(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('module') module: string,
  ) {
    return this.service.creerToutes(u, module);
  }

  @Post(':module/:id')
  decider(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('module') module: string,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.service.decider(u, module, id, dto.action, dto.agentId);
  }
}
