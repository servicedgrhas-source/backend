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
import { CircuitService } from '../circuit/circuit.service';
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

class OrganigrammeBody {
  @IsString() @MaxLength(260) cle: string;
  @IsString() @MaxLength(250) nom: string;
  @IsIn(['PRESCOLAIRE', 'PRIMAIRE', 'COLLEGE', 'LYCEE', 'ALPHABETISATION'])
  cycle: string;
  @IsInt() @Min(1) inspectionId: number;
}

/** Les filtres d'une liste d'écoles (cycle, DEPPSA, seuil, recherche). */
function filtresEcoles(
  q: Record<string, string | undefined>,
  cycleParDefaut: string | undefined,
): FiltresEcoles {
  const seuil = Number(q.seuil);
  return {
    // « TOUS » : tous les cycles
    cycle:
      q.cycle === undefined
        ? cycleParDefaut
        : /^(PRESCOLAIRE|PRIMAIRE|COLLEGE|LYCEE|ALPHABETISATION|SANS)$/.test(
              q.cycle,
            )
          ? q.cycle
          : undefined,
    departementId:
      q.departementId && /^d+$/.test(q.departementId)
        ? Number(q.departementId)
        : undefined,
    seuil: Number.isInteger(seuil) && seuil >= 1 && seuil <= 50 ? seuil : 3,
    sousSeuil: q.sousSeuil === '1',
    recherche: q.recherche?.slice(0, 100) || undefined,
  };
}

/**
 * Effectifs par école (Banque mondiale, 16/11/2026) : volontaires, communautaires, contractuels et
 * fonctionnaires de chaque école, par DEPPSA ; écoles sous le seuil de fonctionnaires ; écoles qui
 * se ressemblent. Lecture seule (DG, 17/11/2026) : les décisions sur les écoles se prennent dans
 * Structures scolaires (routes « ecoles-controle »).
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('enrolement/effectifs-ecoles')
export class EffectifsEcolesController {
  constructor(private readonly ecoles: EffectifsEcolesService) {}

  // Sans cycle demandé : le préscolaire
  private filtres(q: Record<string, string | undefined>): FiltresEcoles {
    return filtresEcoles(q, 'PRESCOLAIRE');
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

/**
 * Les écoles à contrôler, dans Structures scolaires (DG, 17/11/2026) : écoles qui se ressemblent,
 * noms à harmoniser, écoles hors organigramme ; les décisions (même école, deux écoles, pas une
 * école, nom corrigé) et l'ajout d'une école à l'organigramme, sous son inspection.
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('ecoles-controle')
export class ControleEcolesController {
  constructor(
    private readonly ecoles: EffectifsEcolesService,
    private readonly circuit: CircuitService,
  ) {}

  // Sans cycle demandé : tous les cycles
  private filtres(q: Record<string, string | undefined>): FiltresEcoles {
    return filtresEcoles(q, undefined);
  }

  /** Les compteurs des onglets. */
  @Get()
  async resume(@Query() q: Record<string, string | undefined>) {
    const e = await this.ecoles.effectifs(this.filtres(q), 1, 1);
    return {
      ressemblances: e.ressemblances,
      aHarmoniser: e.aHarmoniser,
      horsOrganigramme: e.horsOrganigramme,
      decisions: e.decisions,
      reclassees: e.reclassees,
      calculeLe: e.calculeLe,
      aJour: e.aJour,
    };
  }

  @Get('ressemblances')
  ressemblances(@Query() q: Record<string, string | undefined>) {
    return this.ecoles.ressemblances(
      this.filtres(q),
      Math.max(1, Number(q.page) || 1),
      Math.min(50, Number(q.taille) || 20),
    );
  }

  @Get('liste/:quoi')
  liste(
    @Param('quoi') quoi: string,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.ecoles.aControler(
      quoi === 'harmoniser' ? 'harmoniser' : 'hors-organigramme',
      this.filtres(q),
      Math.max(1, Number(q.page) || 1),
      Math.min(100, Number(q.taille) || 30),
    );
  }

  /** Pour choisir une école à jumeler (recherche dans la DEPPSA). */
  @Get('ecoles')
  chercher(@Query() q: Record<string, string | undefined>) {
    return this.ecoles.effectifs(
      this.filtres(q),
      1,
      Math.min(20, Number(q.taille) || 8),
    );
  }

  @Get('ecole')
  ecole(@Query('id') id?: string) {
    return this.ecoles.ecole(String(id ?? '').slice(0, 260));
  }

  @Get('inspections')
  inspections() {
    return this.ecoles.inspections();
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

  /** Ajouter une école hors organigramme à l'organigramme (comme Administration › Organigramme : le DG). */
  @Roles('DG')
  @Post('organigramme')
  organigramme(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() d: OrganigrammeBody,
  ) {
    return this.ecoles.ajouterOrganigramme(u, d, (dto) =>
      this.circuit.enregistrerStructure(u, null, dto),
    );
  }
}
