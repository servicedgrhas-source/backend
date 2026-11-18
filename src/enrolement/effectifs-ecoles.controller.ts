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
  ArrayMaxSize,
  IsArray,
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
import { PropositionsBmService } from './propositions-bm.service';
import {
  EffectifsEcolesService,
  type FiltresEcoles,
  type TypeDecisionEcole,
} from './effectifs-ecoles.service';
import {
  RANG_VRAISEMBLANCE,
  type Vraisemblance,
} from './effectifs-ecoles-regles';

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

class FusionBody {
  @IsArray() @ArrayMaxSize(3000) paires: { a: string; b: string }[];
}

/** Le niveau de probabilité demandé (« TRES_PROBABLE »…), ou rien. */
const niveauDe = (n?: string) =>
  n && n in RANG_VRAISEMBLANCE ? (n as Vraisemblance) : undefined;

class PropositionEcoleBody {
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
      q.departementId && /^\d+$/.test(q.departementId)
        ? Number(q.departementId)
        : undefined,
    seuil: Number.isInteger(seuil) && seuil >= 1 && seuil <= 50 ? seuil : 3,
    // AU_MOINS : écoles d'au moins `seuil` F/C ; MOINS : les autres (« sousSeuil=1 » des anciens liens = MOINS)
    seuilFiltre:
      q.seuilFiltre === 'AU_MOINS' || q.seuilFiltre === 'MOINS'
        ? q.seuilFiltre
        : q.sousSeuil === '1'
          ? 'MOINS'
          : undefined,
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
  constructor(
    private readonly ecoles: EffectifsEcolesService,
    private readonly propositions: PropositionsBmService,
  ) {}

  /** Proposer d'ajouter une école hors organigramme à l'organigramme : le DG valide ou rejette. */
  @Post('propositions')
  proposer(@Utilisateur() u: UtilisateurConnecte, @Body() d: PropositionEcoleBody) {
    return this.propositions.proposerEcole(u, d);
  }

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

  /** L'Excel remis à la Banque mondiale : des chiffres, sans les feuilles de contrôle (18/11/2026). */
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
 * Les écoles à contrôler, dans Structures scolaires (DG, 18/11/2026) : écoles qui se ressemblent,
 * écoles hors organigramme ; les décisions (même école, deux écoles, pas une école, nom corrigé).
 * Des décisions de comptage seulement ; une école est proposée à l'organigramme, le DG valide.
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('ecoles-controle')
export class ControleEcolesController {
  constructor(
    private readonly ecoles: EffectifsEcolesService,
    private readonly propositions: PropositionsBmService,
  ) {}

  /** Proposer d'ajouter une école hors organigramme à l'organigramme : le DG valide ou rejette. */
  @Post('propositions')
  proposer(@Utilisateur() u: UtilisateurConnecte, @Body() d: PropositionEcoleBody) {
    return this.propositions.proposerEcole(u, d);
  }

  // Sans cycle demandé : tous les cycles
  private filtres(q: Record<string, string | undefined>): FiltresEcoles {
    return filtresEcoles(q, undefined);
  }

  /** L'Excel de contrôle : effectifs, plus les noms à harmoniser et les écoles qui se ressemblent. */
  @Get('excel')
  async excel(
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const { nom, contenu } = await this.ecoles.excel(this.filtres(q), true);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`Écoles à contrôler - ${nom}`)}`,
    );
    res.send(contenu);
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
      niveauDe(q.niveau),
    );
  }

  /** Toutes les paires d'un niveau, pour les cocher d'un coup. */
  @Get('ressemblances/toutes')
  toutesLesPaires(@Query() q: Record<string, string | undefined>) {
    return this.ecoles.toutesLesPaires(this.filtres(q), niveauDe(q.niveau));
  }

  /** Fusionner les paires cochées (décisions « même école » en série). */
  @Post('decisions/fusion')
  fusionner(@Utilisateur() u: UtilisateurConnecte, @Body() d: FusionBody) {
    return this.ecoles.fusionner(u, d.paires);
  }

  @Get('liste/:quoi')
  async liste(
    @Param('quoi') quoi: string,
    @Query() q: Record<string, string | undefined>,
  ) {
    const r = await this.ecoles.aControler(
      quoi === 'harmoniser' ? 'harmoniser' : 'hors-organigramme',
      this.filtres(q),
      Math.max(1, Number(q.page) || 1),
      Math.min(100, Number(q.taille) || 30),
    );
    // L'état de la proposition d'ajout à l'organigramme de chaque école
    const p = await this.propositions.enAttente('ECOLE', r.ecoles.map((e) => e.id));
    return {
      ...r,
      ecoles: r.ecoles.map((e) => {
        const x = p.get(e.id);
        return { ...e, proposition: x ? { etat: x.etat, note: x.note, controlePar: x.controlePar } : null };
      }),
    };
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
}
