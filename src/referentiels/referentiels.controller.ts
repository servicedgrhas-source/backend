import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  Public,
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { ReferentielsService } from './referentiels.service';

class ValeurDto {
  @IsString() type: string;
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @IsString() @MaxLength(250) libelle: string;
  @IsOptional() @IsString() @MaxLength(80) parent?: string | null;
  @IsOptional() @IsInt() departementId?: number | null;
  @IsOptional() @IsObject() donnees?: Record<string, unknown>;
  @IsOptional() @IsBoolean() actif?: boolean;
  @IsOptional() @IsInt() ordre?: number;
}

/** Référentiels : listes de choix (avec recherche) et leur gestion dans l'Administration. */
@Controller('referentiels')
export class ReferentielsController {
  constructor(private readonly service: ReferentielsService) {}

  /** Valeurs proposées dans un champ « à choisir » (aussi pour le portail des agents). */
  @Public()
  @Get('options')
  options(
    @Query('liste') liste: string,
    @Query('q') q?: string,
    @Query('departement') departement?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.options(
      String(liste ?? '').toUpperCase(),
      q,
      Number(departement) || undefined,
      Number(limite) || 30,
    );
  }

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
  @Get('resume')
  resume() {
    return this.service.resume();
  }

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
  @Get('valeurs')
  liste(
    @Query('type') type: string,
    @Query('q') q?: string,
    @Query('parent') parent?: string,
  ) {
    return this.service.liste(type, q, parent || undefined);
  }

  @Roles('DG')
  @Post('valeurs')
  ajouter(@Utilisateur() u: UtilisateurConnecte, @Body() dto: ValeurDto) {
    return this.service.enregistrer(u, null, dto);
  }

  @Roles('DG')
  @Put('valeurs/:id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ValeurDto,
  ) {
    return this.service.enregistrer(u, id, dto);
  }

  /** Reprise (ou complément) des référentiels de l'ancien système : n'écrase rien. */
  @Roles('DG')
  @Post('import-ancien')
  importer(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.importerAncien(u);
  }
}
