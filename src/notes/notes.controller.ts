import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Rectification } from '../entities';
import type { Response } from 'express';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { StockageService } from '../common/stockage';
import { type CritereLot, NotesService } from './notes.service';

class ConformiteDto {
  @IsBoolean() conforme: boolean;
  @IsOptional() @IsString() remarque?: string;
  /** Réservé à l'administrateur (agir à la place d'un niveau, journalisé). */
  @IsOptional() @IsIn(['BUREAU', 'SERVICE', 'DIRECTION']) niveau?: string;
}

class OrdreImpressionDto {
  @IsIn(['DIRECTEUR', 'SECRETARIAT']) pour: string;
}

class SignatureDto {
  @IsString() numero: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dateSignature: string;
}

class CommentaireDto {
  @IsString() commentaire: string;
}

class IntroductionDto {
  @IsString() introduction: string;
}

class SelectionLotsDto {
  @IsArray() @ArrayNotEmpty() @IsInt({ each: true }) lots: number[];
  @IsOptional()
  @IsArray()
  @IsIn(['MEPPSA', 'AUTRES_AVEC', 'AUTRES_SANS'], { each: true })
  groupes?: string[];
}

@Controller('notes')
export class NotesController {
  constructor(
    private readonly service: NotesService,
    private readonly stockage: StockageService,
  ) {}

  @Get()
  liste(@Query('module') module?: string, @Query('lot') lot?: string) {
    return this.service.liste(module, lot ? Number(lot) : undefined);
  }

  /** Lots choisis ensemble et groupes de quota : { lots: [3, 4], groupes: ['MEPPSA'] }. */
  @Roles(...ROLES_TRAITEMENT)
  @Post('preparer/affectation')
  preparerSelection(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: SelectionLotsDto,
  ) {
    return this.service.preparerSelection(u, dto.lots, dto.groupes ?? []);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('preparer/affectation/:lot')
  preparerAffectation(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('lot', ParseIntPipe) lot: number,
  ) {
    return this.service.preparerAffectation(u, lot);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('preparer/enrolement')
  preparerEnrolement(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() body: { campagneId: number; anneeScolaire: string },
  ) {
    return this.service.preparerEnrolement(
      u,
      Number(body?.campagneId),
      body?.anneeScolaire,
    );
  }

  @Post('preparer/nomination')
  preparerNomination(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: { annee?: string },
  ) {
    return this.service.preparerNomination(u, dto?.annee);
  }

  @Post('preparer/mutation')
  preparerMutation(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.preparerMutation(u);
  }

  /** Ce qui attend la personne connectée (avis, impressions, scans, dossiers à confier au secrétariat). */
  @Get('a-faire')
  aFaire(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.aFaire(u);
  }

  @Roles('AGENT', 'CHEF_SERVICE', 'DIRECTEUR', 'BUREAU_ETUDES')
  @Post(':id/conformite')
  conformite(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: ConformiteDto,
  ) {
    return this.service.donnerConformite(u, id, dto);
  }

  @Roles('DG')
  @Post(':id/ordre-impression')
  ordreImpression(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: OrdreImpressionDto,
  ) {
    return this.service.ordonnerImpression(u, id, dto.pour);
  }

  @Roles(...ROLES_TRAITEMENT, 'SECRETARIAT')
  @Post(':id/scan')
  @UseInterceptors(
    FileInterceptor('fichier', {
      limits: { fileSize: 30 * 1024 * 1024 },
      fileFilter: (_req, f, cb) => cb(null, /\.pdf$/i.test(f.originalname)),
      // Scan gardé en mémoire, puis envoyé au stockage (Cloudflare R2 ou disque local)
    }),
  )
  async scan(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier)
      throw new BadRequestException(
        'Joignez la note signée en PDF (30 Mo maximum) : les archives gardent la version numérisée.',
      );
    // La note doit être signée avant d'envoyer quoi que ce soit au stockage
    await this.service.verifierScanPossible(id);
    const nom = await this.stockage.enregistrer('notes-signees', fichier);
    try {
      const r = await this.service.enregistrerScan(
        u,
        id,
        nom,
        fichier.originalname,
      );
      if (r.ancien && r.ancien !== nom)
        await this.stockage.supprimer('notes-signees', r.ancien);
      return { ok: true };
    } catch (e) {
      await this.stockage.supprimer('notes-signees', nom);
      throw e;
    }
  }

  @Get(':id/scan')
  async telechargerScan(@Param('id') id: string, @Res() res: Response) {
    const { fichier, nom } = await this.service.cheminScan(id);
    await this.stockage.servir(res, 'notes-signees', fichier, {
      mime: 'application/pdf',
      nomAffiche: nom,
    });
  }

  /** Récapitulatif : la note de base, ses additifs et ses rectificatifs, en une liste définitive. */
  @Get(':id/recapitulatif')
  recapitulatif(@Param('id') id: string) {
    return this.service.recapitulatif(id);
  }

  @Get(':id/recapitulatif/excel')
  async recapitulatifExcel(@Param('id') id: string, @Res() res: Response) {
    const { nom, contenu } = await this.service.recapitulatifExcel(id);
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

  @Get(':id/excel')
  async excel(@Param('id') id: string, @Res() res: Response) {
    const { nom, contenu } = await this.service.excel(id);
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

  /** La note au format Word, modifiable (réunion DG du 26/10/2026). */
  @Get(':id/word')
  async word(
    @Param('id') id: string,
    @Res() res: Response,
    // « ?visas=0 » : sans les spécimens de visa de l'en-tête
    @Query('visas') visas?: string,
    // « ?echelle=0.91 » : la police réduite choisie à l'écran (notes courtes), 06/11/2026
    @Query('echelle') echelle?: string,
  ) {
    const { nom, contenu } = await this.service.word(
      id,
      visas !== '0',
      echelle ? Number(echelle) : 1,
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(nom)}`,
    );
    res.send(contenu);
  }

  @Roles('DG')
  @Post(':id/rouvrir')
  rouvrir(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.rouvrir(u, id);
  }

  @Get(':id')
  obtenir(@Param('id') id: string) {
    return this.service.obtenir(id);
  }

  /** Introduction d'une note (textes de référence) : réservée au DG. */
  @Roles('DG')
  @Patch(':id')
  introduction(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: IntroductionDto,
  ) {
    return this.service.modifierIntroduction(u, id, dto.introduction);
  }

  /** Ampliations décochées sur l'aperçu de la note : le nombre des archives suit. */
  /* ---- Notes d'enrôlement (cadrage du 05/11/2026) : colonnes, additif, rectificatif ---- */

  /** Introduction et conclusion d'une note d'enrôlement : réservées au DG, comme l'introduction. */
  @Roles('DG')
  @Put(':id/textes')
  textes(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { introduction?: string | null; mentions?: string[] | null },
  ) {
    return this.service.ecrireTextes(
      u,
      id,
      typeof body?.introduction === 'string' ? body.introduction : null,
      Array.isArray(body?.mentions) ? body.mentions.map(String) : null,
    );
  }

  /** En-tête de la note (lignes, référence) ; null : l'en-tête habituel. */
  @Roles(...ROLES_TRAITEMENT)
  @Put(':id/entete')
  ecrireEntete(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { lignes?: string[] | null; reference?: string | null },
  ) {
    return this.service.ecrireEntete(
      u,
      id,
      Array.isArray(body?.lignes) ? body.lignes.map(String) : null,
      body?.reference ? String(body.reference).slice(0, 120) : null,
    );
  }

  /** Valeurs de chaque critère de découpage (spécialité, diplôme, promotion, département). */
  @Roles(...ROLES_TRAITEMENT)
  @Get(':id/lots/criteres')
  criteresDeLaNote(@Param('id') id: string) {
    return this.service.criteresDeLaNote(id);
  }

  /* ---- Note de mutation signée → base du personnel (06/11/2026) ---- */

  /** Chaque personne de la note : sa fiche du personnel trouvée, à vérifier ou introuvable. */
  @Roles(...ROLES_TRAITEMENT)
  @Get(':id/personnel')
  personnelDeLaNote(@Param('id') id: string) {
    return this.service.personnelDeLaNote(id);
  }

  /** C'est cette fiche (LIER), créer sa fiche (CREER), ou laisser sans fiche (SANS_FICHE). */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/personnel/decision')
  decisionPersonnel(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { demandeId: string; action: string; agentId?: number },
  ) {
    if (!['LIER', 'CREER', 'SANS_FICHE'].includes(body?.action))
      throw new BadRequestException('Action inconnue.');
    return this.service.decisionPersonnel(
      u,
      id,
      String(body.demandeId),
      body.action as 'LIER' | 'CREER' | 'SANS_FICHE',
      body.agentId ? Number(body.agentId) : undefined,
    );
  }

  /** Créer d'un coup les fiches des introuvables de la note (« à valider »). */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/personnel/creer-toutes')
  creerFichesNote(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.service.creerFichesNote(u, id);
  }

  /** Reporter la note sur les fiches : nouveau lieu, nouveau département, affectations successives. */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/personnel/reporter')
  reporterPersonnel(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.service.reporterPersonnel(u, id);
  }

  /** Une note pour les valeurs choisies d'un critère (une par valeur, ou une pour toutes). */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/lots/critere')
  decouperParCritere(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { critere: string; valeurs: string[]; ensemble?: boolean },
  ) {
    return this.service.decouperParCritere(
      u,
      id,
      String(body?.critere) as CritereLot,
      Array.isArray(body?.valeurs) ? body.valeurs.map(String) : [],
      !!body?.ensemble,
    );
  }

  /** Découper une note d'enrôlement : des notes de N personnes au plus. */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/lots/nombre')
  decouperParNombre(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { taille: number; garderDepartements?: boolean },
  ) {
    return this.service.decouperParNombre(
      u,
      id,
      Number(body?.taille),
      body?.garderDepartements !== false,
    );
  }

  /** Mettre les personnes cochées dans une nouvelle note (lot). */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/lots/main')
  decouperALaMain(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { ids: string[] },
  ) {
    return this.service.decouperALaMain(
      u,
      id,
      Array.isArray(body?.ids) ? body.ids.map(String) : [],
    );
  }

  /** Remettre les lots « à soumettre au DG » dans la note principale. */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/lots/regrouper')
  regrouperLots(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.service.regrouperLots(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put(':id/colonnes')
  colonnes(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { colonnes: string[] | null },
  ) {
    return this.service.choisirColonnes(
      u,
      id,
      Array.isArray(body?.colonnes) ? body.colonnes.map(String) : null,
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put(':id/additif')
  additif(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { de: string | null },
  ) {
    return this.service.rendreAdditif(u, id, body?.de ? String(body.de) : null);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/rectificatif')
  rectificatif(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.creerRectificatif(u, id);
  }

  @Get(':id/rectificatif/choix')
  choixRectificatif(@Param('id') id: string) {
    return this.service.choixRectificatif(id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put(':id/rectifications')
  rectifications(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { rectifications: Rectification[] },
  ) {
    return this.service.enregistrerRectifications(
      u,
      id,
      Array.isArray(body?.rectifications) ? body.rectifications : [],
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put(':id/ampliations')
  ampliations(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body()
    body: {
      exclues: string[];
      ajoutees?: { libelle: string; nombre: string }[];
    },
  ) {
    return this.service.modifierAmpliations(
      u,
      id,
      Array.isArray(body?.exclues) ? body.exclues.map(String) : [],
      Array.isArray(body?.ajoutees) ? body.ajoutees : undefined,
    );
  }

  /** Réunir dans cette note les notes d'autres lots (même type, encore à soumettre). */
  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/fusionner')
  fusionner(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() body: { avec: string[] },
  ) {
    return this.service.fusionner(
      u,
      id,
      Array.isArray(body?.avec) ? body.avec.map(String) : [],
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/separer')
  separer(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.separer(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/soumettre')
  soumettre(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.soumettre(u, id);
  }

  @Roles('DG')
  @Post(':id/renvoyer')
  renvoyer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: CommentaireDto,
  ) {
    return this.service.renvoyer(u, id, dto.commentaire);
  }

  @Roles('DG')
  @Post(':id/valider')
  valider(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.valider(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/signer')
  signer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: SignatureDto,
  ) {
    return this.service.signer(u, id, dto.numero, dto.dateSignature);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Delete(':id')
  supprimer(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.supprimer(u, id);
  }
}
