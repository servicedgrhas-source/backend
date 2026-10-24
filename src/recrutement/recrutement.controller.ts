import { BeneficiairesService } from '../pilotage/beneficiaires.service';
import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { AffectationService } from '../affectation/affectation.service';
import {
  Roles,
  ROLES_CONTROLE,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { ParametresService } from '../core/core.service';
import type { Agent } from '../entities';
import { CandidatsService, type EtatListe } from './candidats.service';
import { fichierBase } from './fichier-fp';
import { ReceptionService, type LigneRetour } from './reception.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class CandidatDto {
  @IsIn(['MEPPSA', 'QUOTA_AUTRES']) feuille: 'MEPPSA' | 'QUOTA_AUTRES';
  @IsOptional() @IsInt() quota?: number | null;
  @IsOptional() @IsInt() numeroOrdre?: number | null;
  @IsString() @MaxLength(150) nomComplet: string;
  @Matches(DATE, { message: 'La date de naissance est obligatoire.' })
  dateNaissance: string;
  @IsOptional() @Matches(DATE) dateDepot?: string | null;
  @IsOptional() @IsString() @MaxLength(100) lieuNaissance?: string | null;
  @IsString({ message: 'Choisissez le diplôme.' }) diplomeCode: string;
  @IsOptional() @IsInt() departementId?: number | null;
  @IsOptional() @IsString() @MaxLength(100) source?: string | null;
  @IsOptional() @IsString() @MaxLength(30) lotCommission?: string | null;
  @IsOptional()
  @IsIn(['VOLONTAIRE', 'COMMUNAUTAIRE', 'MIXTE'])
  lotNature?: 'VOLONTAIRE' | 'COMMUNAUTAIRE' | 'MIXTE' | null;
  @IsOptional() @IsString() membreCommissionId?: string | null;
  @IsOptional() @IsString() @MaxLength(40) statut?: string | null;
  @IsOptional() @IsString() @MaxLength(200) lieuServiceBrut?: string | null;
  @IsOptional() @IsString() @MaxLength(300) origineBrute?: string | null;
  @IsOptional() @IsString() @MaxLength(500) observation?: string | null;
  @IsOptional() @IsBoolean() forcerDoublon?: boolean;
  @IsOptional() @IsInt() agentRecenseId?: number | null;
}

class ControleDto {
  @IsBoolean() conforme: boolean;
  @IsOptional() @IsString() @MaxLength(500) remarque?: string;
}

class ValidationDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  ids?: string[];
}

class ContentieuxDto {
  @IsIn(['APPROUVE', 'REJETE']) decision: 'APPROUVE' | 'REJETE';
}

class ReportDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids: string[];
  @IsString() @MaxLength(300) motif: string;
}

class MembreDto {
  @IsInt() quota: number;
  @IsString() @MaxLength(150) nom: string;
  @IsOptional() @IsString() @MaxLength(150) fonction?: string | null;
  @IsInt() places: number;
}

class TransmissionDto {
  @IsInt({ message: 'Choisissez le quota à envoyer.' }) quota: number;
  /** Dossiers cochés ; absent : tous les dossiers prêts du quota partent. */
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) ids?: string[];
}

class MiseDeCoteDto {
  @IsString() @MaxLength(300) motif: string;
}

class LigneRetourDto {
  @IsInt() ligne: number;
  @IsString() feuille: string;
  @IsString() @MaxLength(150) nomComplet: string;
  @IsOptional() @Matches(DATE) dateNaissance: string | null;
  @IsOptional() @IsString() lieuNaissance: string | null;
  @IsIn(['ARRETE', 'DECRET']) typeTexte: 'ARRETE' | 'DECRET';
  @IsOptional() @IsString() @MaxLength(40) numeroTexte: string | null;
  @IsOptional() @Matches(DATE) dateSignature: string | null;
  @IsIn(['AGE', 'FONCTIONNAIRE', 'CONTRACTUEL'])
  statutTexte: 'AGE' | 'FONCTIONNAIRE' | 'CONTRACTUEL';
  @IsOptional() @IsString() diplomeBrut: string | null;
  @IsOptional() @IsString() diplomeCode: string | null;
  @IsOptional() @IsInt() departementId: number | null;
  @IsString() categorie: LigneRetour['categorie'];
  @IsOptional() @IsString() agentId: string | null;
  @IsOptional() @IsString() agentNom: string | null;
  @IsOptional() @IsString() detail: string | null;
  @IsIn(['POINTER', 'AUTRES', 'IGNORER']) decision:
    'POINTER' | 'AUTRES' | 'IGNORER';
}

class RetourFpDto {
  @Matches(DATE, { message: 'Indiquez la date de réception.' })
  dateReception: string;
  @IsOptional() @IsString() @MaxLength(200) nomFichier?: string;
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => LigneRetourDto)
  lignes: LigneRetourDto[];
}

class TexteDto {
  @Matches(DATE, { message: 'Indiquez la date de réception.' })
  dateReception: string;
  @IsIn(['ARRETE', 'DECRET']) typeTexte: 'ARRETE' | 'DECRET';
  @IsString() @MaxLength(40) numeroTexte: string;
  @IsOptional() @Matches(DATE) dateSignature?: string | null;
  @IsOptional()
  @IsIn(['AGE', 'FONCTIONNAIRE', 'CONTRACTUEL'])
  statutTexte?: 'AGE' | 'FONCTIONNAIRE' | 'CONTRACTUEL';
  @IsArray()
  @ArrayNotEmpty({
    message: 'Ajoutez au moins une personne concernée par ce texte.',
  })
  @IsString({ each: true })
  agentIds: string[];
}

class QuotaAutresDto {
  @IsString() @MaxLength(150) nomComplet: string;
  @IsOptional() @Matches(DATE) dateNaissance?: string | null;
  @IsOptional() @IsString() @MaxLength(100) lieuNaissance?: string | null;
  @IsString({ message: 'Choisissez le diplôme.' }) diplomeCode: string;
  @IsOptional() @IsInt() departementId?: number | null;
  @IsOptional() @IsString() @MaxLength(200) lieuServiceBrut?: string | null;
  @IsOptional() @IsInt() quota?: number | null;
  @IsOptional() @IsString() @MaxLength(300) origineBrute?: string | null;
  @IsOptional() @IsString() @MaxLength(500) observation?: string | null;
}

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller()
export class RecrutementController {
  constructor(
    private readonly candidats: CandidatsService,
    private readonly reception: ReceptionService,
    private readonly affectation: AffectationService,
    private readonly params: ParametresService,
    private readonly beneficiaires: BeneficiairesService,
  ) {}

  /* ------------------------- Saisie des candidats ------------------------ */

  @Get('candidats')
  async liste(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('etat') etat: EtatListe = 'A_CONTROLER',
    @Query('recherche') recherche?: string,
    @Query('quota') quota?: string,
  ) {
    const liste = await this.candidats.liste(
      etat,
      recherche,
      Number(quota) || undefined,
    );
    // Le salaire (budget) n'est communiqué qu'au DG
    if (u.role === 'DG' || u.role === 'ADMIN') return liste;
    return liste.map((f) => ({ ...f, salaireBrut: null }));
  }

  @Get('candidats/compteurs')
  compteurs() {
    return this.candidats.compteurs();
  }

  @Get('candidats/prochain-numero')
  async prochainNumero(@Query('quota') quota?: string) {
    return {
      numero: await this.candidats.prochainNumero(
        'MEPPSA',
        quota ? Number(quota) : null,
      ),
    };
  }

  /** Places du quota réajusté par bénéficiaire et par cycle, pour le formulaire de saisie (sans montants). */
  @Get('candidats/quota-beneficiaires')
  quotaBeneficiaires(
    @Query('quota') quota: string,
    @Query('exclure') exclure?: string,
  ) {
    return this.beneficiaires.consommation(
      String(Number(quota) || ''),
      exclure,
    );
  }

  @Get('candidats/lots')
  lots(
    @Query('quota') quota?: string,
    @Query('statut') statut?: string,
    @Query('diplomeCode') diplomeCode?: string,
    @Query('exclure') exclure?: string,
    @Query('feuille') feuille?: string,
  ) {
    return this.candidats.lots(
      quota ? Number(quota) : null,
      statut || null,
      diplomeCode || null,
      exclure || undefined,
      feuille === 'QUOTA_AUTRES' ? 'QUOTA_AUTRES' : 'MEPPSA',
    );
  }

  /** Volontaires et communautaires de la base du personnel, à choisir au lieu de les ressaisir. */
  @Get('candidats/personnel')
  personnel(@Query('recherche') recherche?: string) {
    return this.candidats.personnel(recherche);
  }

  /** Volontaires en poste par vague, et ceux déjà présentés dans ce quota. */
  @Get('candidats/vagues')
  vagues(@Query('quota') quota?: string) {
    return this.candidats.vagues(Number(quota) || null);
  }

  @Get('candidats/doublons')
  doublons(
    @Query('nom') nom?: string,
    @Query('dateNaissance') dateNaissance?: string,
    @Query('exclure') exclure?: string,
  ) {
    return this.candidats.doublons(nom, dateNaissance, exclure);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('candidats/import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importer(
    @Utilisateur() u: UtilisateurConnecte,
    @UploadedFile() fichier?: Express.Multer.File,
    @Query('mode') mode?: string,
    @Query('origine') origine?: string,
  ) {
    if (!fichier) throw new BadRequestException('Fichier Excel manquant');
    if (!/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException('Seuls les fichiers .xlsx sont acceptés');
    return this.candidats.importer(
      u,
      fichier.buffer,
      fichier.originalname,
      mode === 'analyse' || mode === 'sansTexte' ? mode : 'tout',
      { origine: origine?.slice(0, 200) },
    );
  }

  /** Modèle Excel d'une liste de candidats (à remettre à une institution ou une direction). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('candidats/modele')
  async modele(@Res() res: Response) {
    res.setHeader('Content-Type', XLSX);
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="Modele - liste des candidats.xlsx"',
    );
    res.send(await this.candidats.modeleListe());
  }

  @Roles(...ROLES_CONTROLE)
  @Post('candidats/controler')
  controlerTout(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: ValidationDto,
  ) {
    return this.candidats.controlerTout(u, dto.ids);
  }

  @Roles('DG')
  @Post('candidats/valider')
  valider(@Utilisateur() u: UtilisateurConnecte, @Body() dto: ValidationDto) {
    return this.candidats.valider(u, dto.ids);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('candidats')
  creer(@Utilisateur() u: UtilisateurConnecte, @Body() dto: CandidatDto) {
    return this.candidats.creer(u, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put('candidats/:id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: CandidatDto,
  ) {
    return this.candidats.modifier(u, id, dto);
  }

  @Roles(...ROLES_CONTROLE)
  @Post('candidats/:id/controle')
  controler(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: ControleDto,
  ) {
    return this.candidats.controler(u, id, dto.conforme, dto.remarque);
  }

  @Roles('DG')
  @Post('candidats/:id/contentieux')
  contentieux(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: ContentieuxDto,
  ) {
    return this.candidats.deciderContentieux(u, id, dto.decision);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Delete('candidats/:id')
  supprimer(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.candidats.supprimer(u, id);
  }

  /* ------------------ Transmission à la Fonction Publique ---------------- */

  @Get('transmissions')
  transmissions() {
    return this.candidats.transmissions();
  }

  @Roles(...ROLES_CONTROLE)
  @Post('transmissions')
  transmettre(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: TransmissionDto,
  ) {
    return this.candidats.transmettre(u, dto.quota, dto.ids);
  }

  @Roles(...ROLES_CONTROLE)
  @Post('transmissions/:quota/:numero/annuler')
  annulerTransmission(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('quota', ParseIntPipe) quota: number,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.candidats.annulerTransmission(u, quota, numero);
  }

  /** Budget dépassé : le DG met à part des dossiers validés pour le quota suivant. */
  @Roles('DG')
  @Post('candidats/reporter')
  reporter(@Utilisateur() u: UtilisateurConnecte, @Body() dto: ReportDto) {
    return this.candidats.reporter(u, dto.ids, dto.motif);
  }

  @Roles('DG')
  @Post('candidats/:id/annuler-report')
  annulerReport(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.candidats.annulerReport(u, id);
  }

  /* --------------------- Membres de la commission --------------------- */

  @Get('commission/membres')
  membres(@Query('quota') quota: string) {
    return this.candidats.membresCommission(
      Number(quota) || new Date().getFullYear(),
    );
  }

  @Roles('DG')
  @Post('commission/membres')
  ajouterMembre(@Utilisateur() u: UtilisateurConnecte, @Body() dto: MembreDto) {
    return this.candidats.enregistrerMembre(u, null, dto);
  }

  @Roles('DG')
  @Put('commission/membres/:id')
  modifierMembre(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: MembreDto,
  ) {
    return this.candidats.enregistrerMembre(u, id, dto);
  }

  @Roles('DG')
  @Delete('commission/membres/:id')
  supprimerMembre(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.candidats.supprimerMembre(u, id);
  }

  /** La FP dit un dossier incomplet : il sort de sa transmission. */
  @Roles(...ROLES_CONTROLE)
  @Post('candidats/:id/mettre-de-cote')
  mettreDeCote(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: MiseDeCoteDto,
  ) {
    return this.candidats.mettreDeCote(u, id, dto.motif);
  }

  /** Dossier corrigé et validé : retour dans sa transmission d'origine. */
  @Roles(...ROLES_CONTROLE)
  @Post('candidats/:id/rattacher')
  rattacher(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.candidats.rattacher(u, id);
  }

  /**
   * Le chef de service, la DRSC et le bureau d'études ont tout le fichier sauf le
   * budget (INCIDENCE FINANCIÈRE, TOTAL) et le bloc DGRHAS interne : réservés au DG.
   */
  private async envoyerFichier(
    res: Response,
    u: UtilisateurConnecte,
    fiches: Agent[],
    titre: string,
    nom: string,
    interneDemande: boolean,
  ) {
    const complet = u.role === 'DG' || u.role === 'ADMIN';
    if (interneDemande && !complet)
      throw new ForbiddenException(
        'Le fichier DGRHAS (informations internes) est réservé au DG.',
      );
    const interne = interneDemande && complet;
    if (!complet) nom = nom.replace(/\.xlsx$/, ' - sans incidence.xlsx');
    const contenu = await fichierBase({
      fiches,
      regles: await this.affectation.reglesParCode(),
      parametres: this.affectation.parametresCalcul(),
      campagne: this.params.get('CAMPAGNE_RECRUTEMENT'),
      titre,
      interne,
      budget: complet,
    });
    res.setHeader('Content-Type', XLSX);
    res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
    res.send(contenu);
  }

  /** Base compilée : toutes les transmissions dans un seul fichier. */
  @Roles(...ROLES_CONTROLE)
  @Get('transmissions/compilation/fichier')
  async compilation(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('modele') modele: string,
    @Res() res: Response,
    @Query('de') de?: string,
    @Query('a') a?: string,
    @Query('quota') q?: string,
  ) {
    const interne = modele === 'dgrhas';
    const quota = Number(q) || null;
    const debut = quota ? Number(de) || null : null;
    const fin = quota ? Number(a) || null : null;
    const plage = quota
      ? `quota ${quota}${debut || fin ? ` - transmissions ${debut ?? 1} a ${fin ?? 'derniere'}` : ''}`
      : 'tous les quotas';
    await this.envoyerFichier(
      res,
      u,
      await this.candidats.fichesTransmission(quota, null, debut, fin),
      quota
        ? `Quota ${quota}${debut || fin ? ` – transmissions ${debut ?? 1} à ${fin ?? 'la dernière'}` : ' – toutes les transmissions'}`
        : 'Toutes les transmissions',
      `Base compilee - ${plage}${interne ? ' - DGRHAS' : ''}.xlsx`,
      interne,
    );
  }

  @Roles(...ROLES_CONTROLE)
  @Get('transmissions/:quota/:numero/fichier')
  async fichier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('quota', ParseIntPipe) quota: number,
    @Param('numero', ParseIntPipe) numero: number,
    @Query('modele') modele: string,
    @Res() res: Response,
  ) {
    const interne = modele === 'dgrhas';
    await this.envoyerFichier(
      res,
      u,
      await this.candidats.fichesTransmission(quota, numero),
      `Quota ${quota} – transmission ${numero}`,
      `Quota ${quota} - Transmission ${numero} - ${interne ? 'DGRHAS' : 'FP'}.xlsx`,
      interne,
    );
  }

  @Get('transmissions/:quota/:numero/soit-transmis')
  soitTransmis(
    @Param('quota', ParseIntPipe) quota: number,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.candidats.soitTransmis(quota, numero);
  }

  @Get('transmissions/:quota/:numero/listes')
  listes(
    @Param('quota', ParseIntPipe) quota: number,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.candidats.listesTransmission(quota, numero);
  }

  /** Base des recrutés complète (tous les champs, incidences comprises). */
  @Roles(...ROLES_CONTROLE)
  @Get('recrutes/export')
  async exporter(@Utilisateur() u: UtilisateurConnecte, @Res() res: Response) {
    const fiches = await this.affectation.toutesLesFiches();
    await this.envoyerFichier(
      res,
      u,
      fiches,
      'Base des recrutés',
      'Base des recrutes - DGRHAS.xlsx',
      // Bloc interne DGRHAS ajouté seulement pour le DG
      u.role === 'DG' || u.role === 'ADMIN',
    );
  }

  /* ------------------ Réception des textes de la FP ---------------------- */

  @Get('reception/paquets')
  paquets() {
    return this.reception.paquets();
  }

  @Get('reception/paquet')
  textesDuPaquet(@Query('date') date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))
      throw new BadRequestException('Date de réception invalide.');
    return this.reception.textesDuPaquet(date);
  }

  @Get('reception/texte')
  texte(@Query('type') type: string, @Query('numero') numero: string) {
    return this.reception.texte(type, numero);
  }

  @Get('reception/lots/:numero')
  textesDuLot(@Param('numero', ParseIntPipe) numero: number) {
    return this.reception.textesDuLot(numero);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('reception')
  enregistrer(@Utilisateur() u: UtilisateurConnecte, @Body() dto: TexteDto) {
    return this.reception.enregistrer(u, dto);
  }

  /** Fichier Excel renvoyé par la FP : analyse (rien n'est enregistré). */
  @Roles(...ROLES_TRAITEMENT)
  @Post('reception/import/analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  analyserRetour(@UploadedFile() fichier?: Express.Multer.File) {
    if (!fichier) throw new BadRequestException('Fichier Excel manquant');
    if (!/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException('Seuls les fichiers .xlsx sont acceptés');
    return this.reception.analyserRetour(fichier.buffer);
  }

  /** Fichier Excel renvoyé par la FP : enregistrement des choix de l'agent. */
  @Roles(...ROLES_TRAITEMENT)
  @Post('reception/import')
  appliquerRetour(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: RetourFpDto,
  ) {
    return this.reception.appliquerRetour(u, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('reception/quota-autres')
  quotaAutres(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: QuotaAutresDto,
  ) {
    return this.reception.ajouterQuotaAutres(u, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('reception/annuler/:agentId')
  annuler(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('agentId') agentId: string,
  ) {
    return this.reception.annuler(u, agentId);
  }
}
