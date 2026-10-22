import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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

/** Tous ceux qui interviennent dans un circuit : DGRHAS, DDEPPSA, écoles, inspections… */
const ROLES_CIRCUIT = [
  ...ROLES_TRAITEMENT,
  'DDEPPSA',
  'STRUCTURE',
  'CABINET',
] as const;

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
  aTraiter(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.aTraiter(u);
  }

  @Get('circuit/compteur')
  compteur(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.compteur(u);
  }

  @Get('circuit/alertes')
  alertes(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.mesAlertes(u);
  }

  @Post('circuit/alertes/lues')
  lues(@Utilisateur() u: UtilisateurConnecte, @Body('ids') ids: number[]) {
    if (!Array.isArray(ids)) throw new BadRequestException('Liste attendue.');
    return this.service.marquerLues(
      u,
      ids.filter((x) => Number.isInteger(x)).slice(0, 200),
    );
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
