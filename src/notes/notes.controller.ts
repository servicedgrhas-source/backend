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
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  IsBoolean,
  IsIn,
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
import { NotesService } from './notes.service';

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
  async word(@Param('id') id: string, @Res() res: Response) {
    const { nom, contenu } = await this.service.word(id);
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
