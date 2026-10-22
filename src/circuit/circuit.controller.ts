import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Repository } from 'typeorm';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { DemandeMutation } from '../entities';
import { TYPES_STRUCTURE } from './catalogue';
import { CircuitService } from './circuit.service';

class StructureDto {
  @IsString() type: string;
  @IsString() @MaxLength(250) nom: string;
  @IsOptional() @IsString() @MaxLength(80) sigle?: string | null;
  @IsOptional() @IsInt() parentId?: number | null;
  @IsOptional() @IsInt() departementId?: number | null;
  @IsOptional() @IsBoolean() actif?: boolean;
}

class TypeDto {
  @IsOptional() @IsString() @MaxLength(250) libelle?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  pieces?: string[];
  @IsOptional() @IsBoolean() circuitExterne?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  etapesInternes?: string[];
  @IsOptional() @IsIn(['LIEU_SERVICE', 'DDEPPSA', 'DGRHAS']) decision?: string;
  @IsOptional() @IsBoolean() actif?: boolean;
}

class AgirDto {
  @IsOptional() @IsIn(['FAVORABLE', 'REJET']) avis?: 'FAVORABLE' | 'REJET';
  @IsOptional() @IsIn(['ACCORDEE', 'REJETEE', 'EN_INSTANCE']) decision?:
    'ACCORDEE' | 'REJETEE' | 'EN_INSTANCE';
  @IsString() @MaxLength(2000) motivation: string;
  @IsOptional() @IsBoolean() surPapier?: boolean;
}

class InstructionDto {
  @IsString() @MaxLength(500) texte: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) echeance?: string | null;
}

/**
 * Tous ceux qui interviennent dans un circuit : DGRHAS, DDEPPSA, écoles, inspections, cabinet,
 * secrétariat (qui imprime les dossiers accordés : il doit les ouvrir, voir leurs alertes).
 * Les actions restent contrôlées une à une (étape en cours, rang dans le circuit, rôle DG).
 */
const ROLES_CIRCUIT = [
  ...ROLES_TRAITEMENT,
  'DDEPPSA',
  'STRUCTURE',
  'CABINET',
  'SECRETARIAT',
] as const;

const entier = (v?: string) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : undefined;
};

@Roles(...ROLES_CIRCUIT)
@Controller()
export class CircuitController {
  constructor(
    private readonly service: CircuitService,
    @InjectRepository(DemandeMutation)
    private readonly demandes: Repository<DemandeMutation>,
  ) {}

  /* ------------------------------ Organigramme ------------------------------ */

  @Get('structures')
  structures() {
    return this.service.listeStructures();
  }

  @Get('structures/types')
  typesStructure() {
    return TYPES_STRUCTURE;
  }

  @Roles('DG')
  @Post('structures')
  ajouter(@Utilisateur() u: UtilisateurConnecte, @Body() dto: StructureDto) {
    return this.service.enregistrerStructure(u, null, dto);
  }

  @Roles('DG')
  @Put('structures/:id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: StructureDto,
  ) {
    return this.service.enregistrerStructure(u, id, dto);
  }

  @Roles('DG')
  @Post('structures/:id/deplacer')
  deplacer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { sens: 'haut' | 'bas' },
  ) {
    if (body?.sens !== 'haut' && body?.sens !== 'bas')
      throw new BadRequestException('Sens attendu : haut ou bas');
    return this.service.deplacerStructure(u, id, body.sens);
  }

  @Roles('DG')
  @Delete('structures/:id')
  supprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.supprimerStructure(u, id);
  }

  /* --------------------------- Catalogue des prestations --------------------------- */

  @Get('prestations')
  prestations(@Query('actifs') actifs?: string) {
    return this.service.listeTypes(actifs === '1');
  }

  @Roles('DG')
  @Put('prestations/:code')
  modifierType(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('code') code: string,
    @Body() dto: TypeDto,
  ) {
    return this.service.modifierType(u, code, dto);
  }

  /* ---------------------------- Travail de chacun ---------------------------- */

  @Get('circuit/a-traiter')
  aTraiter(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('onglet') onglet?: string,
    @Query('recherche') recherche?: string,
    @Query('type') type?: string,
    @Query('etape') etape?: string,
    @Query('retard') retard?: string,
    @Query('page') page?: string,
    @Query('taille') taille?: string,
  ) {
    return this.service.aTraiter(u, {
      onglet: onglet === 'aSuivre' ? 'aSuivre' : 'aTraiter',
      recherche: recherche?.slice(0, 100),
      type: type?.slice(0, 80) || undefined,
      etape: etape?.slice(0, 120) || undefined,
      retard: retard === '1',
      page: entier(page),
      taille: entier(taille),
    });
  }

  /** Tableau de bord des comptes du circuit (DDEPPSA, cabinet, secrétariat…). */
  @Get('circuit/tableau')
  tableau(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.tableau(u);
  }

  @Get('circuit/compteur')
  compteur(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.compteur(u);
  }

  @Get('circuit/alertes')
  alertes(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('avant') avant?: string,
  ) {
    return this.service.mesAlertes(u, entier(avant));
  }

  /** Alertes lues : celles de la liste `ids`, ou toutes (`tout: true`). */
  @Post('circuit/alertes/lues')
  @HttpCode(200)
  lues(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() body: { ids?: unknown; tout?: unknown },
  ) {
    const tout = body?.tout === true;
    if (!tout && !Array.isArray(body?.ids))
      throw new BadRequestException('Liste attendue.');
    const ids = tout
      ? []
      : (body.ids as unknown[])
          .filter((x): x is number => Number.isInteger(x))
          .slice(0, 500);
    return this.service.marquerLues(u, ids, tout);
  }

  /* --------------------------- Circuit d'une demande --------------------------- */

  @Get('mutations/:id/circuit')
  async circuit(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    const d = await this.demandes.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    const mes = await this.service.structuresDe(u);
    const enCours = d.etapeCourante !== null && !!d.circuit;
    return {
      circuit: d.circuit ?? [],
      etapeCourante: d.etapeCourante,
      decideur: d.decideur,
      decision: d.decision,
      decisionMotivation: d.decisionMotivation,
      decisionPar: d.decisionPar,
      decisionLe: d.decisionLe,
      canal: d.canal,
      peutAgir: await this.service.peutAgir(u, d),
      peutRecopier: await this.service.peutRecopier(u, d),
      peutSauter:
        enCours &&
        ['DG', 'ADMIN'].includes(u.role) &&
        d.etapeCourante! < d.circuit!.length - 1,
      peutInstruire:
        enCours &&
        (['DG', 'ADMIN'].includes(u.role) ||
          d.circuit!.some(
            (e, i) =>
              i > d.etapeCourante! &&
              !!e.structureId &&
              mes.includes(e.structureId),
          )),
      responsables: await this.service.responsables(d),
      instructions: await this.service.instructionsDe(id),
    };
  }

  @Post('mutations/:id/circuit/agir')
  agir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: AgirDto,
  ) {
    return this.service.agir(u, id, dto);
  }

  @Roles('DG')
  @Post('mutations/:id/circuit/franchir')
  franchir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body('motif') motif: string,
  ) {
    return this.service.sauter(u, id, motif);
  }

  @Post('mutations/:id/circuit/instruction')
  instruction(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: InstructionDto,
  ) {
    return this.service.instruire(u, id, dto.texte, dto.echeance ?? null);
  }
}
