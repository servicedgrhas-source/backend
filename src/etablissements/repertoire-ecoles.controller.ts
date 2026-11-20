import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { RepertoireEcolesService } from './repertoire-ecoles.service';

const fichierExcel = (f?: Express.Multer.File) => {
  if (!f || !/\.xlsx$/i.test(f.originalname))
    throw new BadRequestException('Choisissez le répertoire en Excel (.xlsx).');
  return f.buffer;
};

/**
 * Répertoire officiel des établissements publics (Structures scolaires) : essai, puis
 * enregistrement de ce que la DGRHAS a coché (renommages, écoles ajoutées).
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('ecoles-repertoire')
export class RepertoireEcolesController {
  constructor(private readonly service: RepertoireEcolesService) {}

  /** Essai : rien n'est enregistré. */
  @Post('analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 30 * 1024 * 1024 } }),
  )
  analyser(@UploadedFile() fichier?: Express.Multer.File) {
    return this.service.analyser(fichierExcel(fichier));
  }

  /** Enregistre les lignes cochées (DG et administrateurs). */
  @Roles('DG')
  @Post('appliquer')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 30 * 1024 * 1024 } }),
  )
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body('choix') choixTexte: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    let choix: unknown;
    try {
      choix = JSON.parse(choixTexte ?? '');
    } catch {
      throw new BadRequestException('Choix illisibles : refaites l’essai.');
    }
    const c = choix as {
      renommer?: unknown;
      ajouter?: unknown;
    };
    const renommer = Array.isArray(c.renommer)
      ? c.renommer
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 10000)
      : [];
    const ajouter = Array.isArray(c.ajouter)
      ? (c.ajouter as { cle?: unknown; inspectionId?: unknown }[])
          .filter(
            (x) =>
              typeof x?.cle === 'string' && Number.isInteger(x?.inspectionId),
          )
          .map((x) => ({
            cle: x.cle as string,
            inspectionId: x.inspectionId as number,
          }))
          .slice(0, 10000)
      : [];
    return this.service.appliquer(u, fichierExcel(fichier), {
      renommer,
      ajouter,
    });
  }
}
