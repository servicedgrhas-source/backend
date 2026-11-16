import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import {
  EffectifsEcolesService,
  type FiltresEcoles,
  type TypeDecisionEcole,
} from './effectifs-ecoles.service';

class DecisionEcoleBody {
  @IsIn(['JUMELEE', 'DIFFERENTES', 'ECARTEE', 'MISE_A_JOUR'])
  type: TypeDecisionEcole;
  @IsString() @MaxLength(260) cle: string;
  @IsOptional() @IsString() @MaxLength(260) autreCle?: string;
  @IsOptional() @IsString() @MaxLength(150) nom?: string;
  @IsOptional() @IsInt() @Min(1) departementId?: number;
  @IsOptional() @IsString() @MaxLength(30) cycle?: string;
  @IsOptional() @IsString() @MaxLength(500) motif?: string;
}

/**
 * Effectifs par école (Banque mondiale, 16/11/2026) : volontaires, communautaires, contractuels et
 * fonctionnaires de chaque école, par DEPPSA ; écoles sous le seuil de fonctionnaires ; écoles qui
 * se ressemblent et décisions (même école, deux écoles, pas une école, nom corrigé).
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('enrolement/effectifs-ecoles')
export class EffectifsEcolesController {
  constructor(private readonly ecoles: EffectifsEcolesService) {}

  private filtres(q: Record<string, string | undefined>): FiltresEcoles {
    const seuil = Number(q.seuil);
    return {
      // Sans cycle demandé : le préscolaire ; « TOUS » : tous les cycles
      cycle:
        q.cycle === undefined
          ? 'PRESCOLAIRE'
          : /^(PRESCOLAIRE|PRIMAIRE|COLLEGE|LYCEE|ALPHABETISATION|SANS)$/.test(
                q.cycle,
              )
            ? q.cycle
            : undefined,
      departementId:
        q.departementId && /^\d+$/.test(q.departementId)
          ? Number(q.departementId)
          : undefined,
      seuil: Number.isInteger(seuil) && seuil >= 1 && seuil <= 50 ? seuil : 3,
      sousSeuil: q.sousSeuil === '1',
      recherche: q.recherche?.slice(0, 100) || undefined,
    };
  }

  @Get()
  lire(@Query() q: Record<string, string | undefined>) {
    return this.ecoles.effectifs(
      this.filtres(q),
      Math.max(1, Number(q.page) || 1),
      Math.min(200, Number(q.taille) || 50),
    );
  }

  @Get('ressemblances')
  ressemblances(@Query() q: Record<string, string | undefined>) {
    return this.ecoles.ressemblances(
      this.filtres(q),
      Math.max(1, Number(q.page) || 1),
      Math.min(50, Number(q.taille) || 20),
    );
  }

  @Get('ecole')
  ecole(@Query('id') id?: string) {
    return this.ecoles.ecole(String(id ?? '').slice(0, 260));
  }

  @Get('decisions')
  decisions() {
    return this.ecoles.decisions();
  }

  @Post('decisions')
  decider(@Utilisateur() u: UtilisateurConnecte, @Body() d: DecisionEcoleBody) {
    return this.ecoles.decider(u, d);
  }

  @Delete('decisions/:id')
  annuler(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.ecoles.annuler(u, id);
  }

  @Get('excel')
  async excel(
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const { nom, contenu } = await this.ecoles.excel(this.filtres(q));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(nom)}`,
    );
    res.send(contenu);
  }
}
