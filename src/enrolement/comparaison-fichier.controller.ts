import {
  BadRequestException,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Roles, ROLES_TRAITEMENT } from '../auth/auth';
import { ComparaisonFichierService } from './comparaison-fichier.service';

/**
 * Comparer un fichier initial (fait à la main, envoyé au Trésor) avec le système (DG, 16/11/2026) :
 * un état de paiement du mois (page de la bourse) ou les dossiers d'une campagne d'enrôlement
 * (page de la base des enrôlés). Lecture seule : le fichier n'est pas enregistré.
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('enrolement')
export class ComparaisonFichierController {
  constructor(private readonly comparaison: ComparaisonFichierService) {}

  private fichier(f?: Express.Multer.File) {
    if (!f || !/\.xlsx$/i.test(f.originalname))
      throw new BadRequestException('Choisissez un fichier Excel (.xlsx).');
    return {
      contenu: f.buffer,
      // Les noms de fichiers accentués arrivent en latin1
      nom: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    };
  }

  private envoyer(res: Response, nom: string, contenu: Buffer) {
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

  @Post('bourse/:id/comparer')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  comparerBourse(
    @Param('id', ParseIntPipe) id: number,
    @Query('feuille') feuille?: string,
    @UploadedFile() f?: Express.Multer.File,
  ) {
    return this.comparaison.comparerBourse(
      this.fichier(f).contenu,
      id,
      feuille?.slice(0, 100) || undefined,
    );
  }

  @Post('bourse/:id/comparer/excel')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  async excelBourse(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
    @Query('feuille') feuille?: string,
    @UploadedFile() f?: Express.Multer.File,
  ) {
    const x = this.fichier(f);
    const r = await this.comparaison.excelBourse(
      x.contenu,
      x.nom,
      id,
      feuille?.slice(0, 100) || undefined,
    );
    this.envoyer(res, r.nom, r.contenu);
  }

  @Post('listes/comparer')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  comparerEnrolement(
    @Query('campagne', ParseIntPipe) campagne: number,
    @UploadedFile() f?: Express.Multer.File,
  ) {
    return this.comparaison.comparerEnrolement(
      this.fichier(f).contenu,
      campagne,
    );
  }

  @Post('listes/comparer/excel')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  async excelEnrolement(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Res() res: Response,
    @UploadedFile() f?: Express.Multer.File,
  ) {
    const x = this.fichier(f);
    const r = await this.comparaison.excelEnrolement(
      x.contenu,
      x.nom,
      campagne,
    );
    this.envoyer(res, r.nom, r.contenu);
  }
}
