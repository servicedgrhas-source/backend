import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Roles, Utilisateur, type UtilisateurConnecte } from '../auth/auth';
import { ConfigurationService } from './configuration.service';

class GradeDto {
  @IsString() @MaxLength(40) abreviation: string;
  @IsString() @MaxLength(150) libelle: string;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(5)
  categorie: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(20)
  echelle: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(20)
  echelon: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(5000)
  indice?: number | null;
}

class RegleDto {
  @IsString() @MaxLength(80) libelle: string;
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) ecritures: string[];
  @IsString() cycle: string;
  @IsString() typeNote: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() gradeCode:
    string | null;
}

/** Règles diplôme → grade et liste des grades : réservé au DG (et à l'administrateur). */
@Roles('DG')
@Controller('configuration')
export class ConfigurationController {
  constructor(private readonly service: ConfigurationService) {}

  @Get()
  etat() {
    return this.service.etat();
  }

  @Post('apercu')
  apercuNouvelle(@Body() dto: RegleDto) {
    return this.service.apercu(null, dto);
  }

  @Post('apercu/:code')
  apercu(@Param('code') code: string, @Body() dto: RegleDto) {
    return this.service.apercu(code, dto);
  }

  @Post('grades')
  creerGrade(@Utilisateur() u: UtilisateurConnecte, @Body() dto: GradeDto) {
    return this.service.creerGrade(u, dto);
  }

  @Put('grades/:code')
  modifierGrade(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('code') code: string,
    @Body() dto: GradeDto,
  ) {
    return this.service.modifierGrade(u, code, dto);
  }

  @Delete('grades/:code')
  supprimerGrade(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('code') code: string,
  ) {
    return this.service.supprimerGrade(u, code);
  }

  @Post('regles')
  creerRegle(@Utilisateur() u: UtilisateurConnecte, @Body() dto: RegleDto) {
    return this.service.creerRegle(u, dto);
  }

  @Put('regles/:code')
  modifierRegle(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('code') code: string,
    @Body() dto: RegleDto,
  ) {
    return this.service.modifierRegle(u, code, dto);
  }

  @Delete('regles/:code')
  supprimerRegle(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('code') code: string,
  ) {
    return this.service.supprimerRegle(u, code);
  }

  @Post('reinitialiser')
  reinitialiser(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.reinitialiser(u);
  }
}
