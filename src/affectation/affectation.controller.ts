import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { JournalService } from '../core/core.service';
import { AffectationService } from './affectation.service';
import { ControleAffectationsService } from './controle.service';
import { StatistiquesService } from './statistiques.service';
import { ImportBaseService } from './import.service';
import { LotsReceptionService } from './lots-reception.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class LotDto {
  @IsOptional() @Matches(DATE) dateSignatureArretes?: string | null;
  @IsOptional() @Matches(DATE) dateSignatureDecrets?: string | null;
  @IsOptional() @Matches(DATE) dateReception?: string | null;
  @IsOptional() @IsString() observation?: string | null;
}

class AgentDto {
  @IsOptional() @Matches(DATE) dateNaissance?: string;
  @IsOptional() @IsInt() departementId?: number;
  @IsOptional() @IsString() diplomeCode?: string;
  @IsOptional() @IsString() @MaxLength(40) numeroTexte?: string;
  @IsOptional() @IsIn(['ARRETE', 'DECRET']) typeTexte?: 'ARRETE' | 'DECRET';
  @IsOptional() @Matches(DATE) dateSignatureTexte?: string | null;
  @IsOptional() @IsBoolean() contractuelForce?: boolean | null;
  /** Anomalies déclarées vérifiées (elles disparaissent de la fiche). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  anomaliesVerifiees?: string[];
}

class AffectationDto {
  @IsOptional() @IsString() @MaxLength(200) specialite?: string | null;
  @IsOptional() @IsString() @MaxLength(200) structure?: string | null;
  @IsOptional() @IsString() @MaxLength(200) etablissement?: string | null;
  @IsOptional() @IsString() @MaxLength(100) obs?: string | null;
}

class RecommandationDto {
  @IsOptional() @IsString() typeNote?: string | null;
  @IsOptional() @IsInt() departementId?: number | null;
  @IsOptional() @IsString() structure?: string | null;
  @IsOptional() @IsString() etablissement?: string | null;
  @IsString() @MaxLength(300) origine: string;
  @IsOptional() @IsString() @MaxLength(1000) motif?: string | null;
}

class MotifDto {
  @IsString() motif: string;
}

const optInt = (v?: string) => (v ? Number(v) : undefined);

@Controller()
export class AffectationController {
  constructor(
    private readonly service: AffectationService,
    private readonly importation: ImportBaseService,
    private readonly lotsReception: LotsReceptionService,
    private readonly journal: JournalService,
    private readonly controle: ControleAffectationsService,
    private readonly statsSuivi: StatistiquesService,
  ) {}

  /* ------------- Statistiques de suivi et contrôle des affectations ------------- */

  @Roles(...ROLES_TRAITEMENT)
  @Get('statistiques/recrutement')
  statistiquesRecrutement() {
    return this.statsSuivi.recrutement();
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('controle-affectations')
  resumeControle() {
    return this.controle.resume();
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('controle-affectations/doubles')
  doublesAffectations() {
    return this.controle.doubles();
  }

  /** Lecture du fichier de contrôle, sans rien enregistrer (rapport à confirmer). */
  @Roles('CHEF_SERVICE', 'DG')
  @Post('controle-affectations/analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  analyserControle(@UploadedFile() fichier?: Express.Multer.File) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException(
        'Choisissez le fichier Excel (.xlsx) du contrôle des affectations',
      );
    return this.controle.analyser(fichier.buffer);
  }

  @Roles('CHEF_SERVICE', 'DG')
  @Post('controle-affectations/import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importerControle(
    @Utilisateur() u: UtilisateurConnecte,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException(
        'Choisissez le fichier Excel (.xlsx) du contrôle des affectations',
      );
    return this.controle.importer(u, fichier.buffer, fichier.originalname);
  }

  /** Seule entrée sans le circuit (saisie → contrôle → validation → envoi) : réservée. */
  @Roles('CHEF_SERVICE', 'DG')
  @Post('import/base')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  async importerBase(
    @Utilisateur() u: UtilisateurConnecte,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier) throw new BadRequestException('Fichier Excel manquant');
    if (!/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException('Seuls les fichiers .xlsx sont acceptés');
    const rapport = await this.importation.importer(fichier.buffer);
    await this.journal.log(u, 'IMPORT_BASE_RECRUTEMENT', 'agent', null, {
      fichier: fichier.originalname,
      ...rapport,
    });
    return rapport;
  }

  @Get('lots')
  lots() {
    return this.service.listeLots();
  }

  @Roles(...ROLES_TRAITEMENT)
  @Patch('lots/:id')
  modifierLot(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LotDto,
  ) {
    return this.service.modifierLot(u, id, dto);
  }

  /**
   * Range une fois les anciens lots selon la règle : paquet (date de réception), puis un
   * lot par quota et par type de texte. `essai=1` : rapport sans rien changer.
   */
  @Roles('DG')
  @Post('lots/reorganiser')
  reorganiser(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('essai') essai?: string,
  ) {
    return this.lotsReception.reorganiser(u, essai === '1');
  }

  @Get('lots/:numero/resume')
  resume(@Param('numero', ParseIntPipe) numero: number) {
    return this.service.resumeLot(numero);
  }

  @Get('agents')
  agents(
    @Query('recherche') recherche?: string,
    @Query('lot') lot?: string,
    @Query('texte') texte?: 'recu' | 'attente',
    @Query('feuille') feuille?: string,
    @Query('anomalies') anomalies?: string,
    @Query('page') page?: string,
    @Query('taille') taille?: string,
  ) {
    return this.service.listeAgents({
      recherche,
      lot: optInt(lot),
      texte,
      feuille,
      anomalies: anomalies === '1',
      page: optInt(page),
      taille: optInt(taille),
    });
  }

  @Get('agents/anomalies')
  anomalies() {
    return this.service.resumeAnomalies();
  }

  /** Cycle du fichier différent de celui du diplôme : la règle du diplôme s'applique à tous. */
  @Roles(...ROLES_TRAITEMENT)
  @Post('agents/anomalies/cycle')
  appliquerCycle(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.appliquerReglesCycle(u);
  }

  @Get('agents/statistiques')
  statistiques() {
    return this.service.statistiquesAgents();
  }

  @Roles(...ROLES_TRAITEMENT)
  @Patch('agents/:id')
  modifierAgent(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: AgentDto,
  ) {
    return this.service.modifierAgent(u, id, dto);
  }

  @Get('affectations')
  affectations(
    @Query('lot') lot?: string,
    @Query('typeNote') typeNote?: string,
    @Query('departementId') departementId?: string,
    @Query('statut') statut?: string,
    @Query('recherche') recherche?: string,
    @Query('probleme') probleme?: 'bloquant' | 'avertissement',
  ) {
    return this.service.listeAffectations({
      lot: optInt(lot),
      typeNote,
      departementId: optInt(departementId),
      statut,
      recherche,
      probleme,
    });
  }

  @Roles(...ROLES_TRAITEMENT)
  @Patch('affectations/:id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: AffectationDto,
  ) {
    return this.service.modifier(u, id, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('affectations/:id/exclure')
  exclure(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: MotifDto,
  ) {
    return this.service.exclure(u, id, dto.motif);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('affectations/:id/reintegrer')
  reintegrer(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.reintegrer(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('affectations/:id/recommandations')
  recommander(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: RecommandationDto,
  ) {
    return this.service.proposerRecommandation(u, id, dto);
  }
}
