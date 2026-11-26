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
import {
  type AjoutEcole,
  ClassesDeclareesService,
} from './classes-declarees.service';

const fichierExcel = (f?: Express.Multer.File) => {
  if (!f || !/\.xlsx$/i.test(f.originalname))
    throw new BadRequestException(
      'Choisissez le fichier des allocations budgétaires en Excel (.xlsx).',
    );
  return f.buffer;
};
/** Vide : l'année scolaire en cours. */
const anneeScolaire = (a?: string) => {
  if (!a) return undefined;
  if (!/^\d{4}-\d{4}$/.test(a))
    throw new BadRequestException('Année scolaire attendue : « 2026-2027 ».');
  return a;
};

/** Nombre de classes par école (fichier des allocations budgétaires) : essai, puis enregistrement. */
@Roles(...ROLES_TRAITEMENT)
@Controller('classes-declarees')
export class ClassesDeclareesController {
  constructor(private readonly service: ClassesDeclareesService) {}

  @Post('analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 30 * 1024 * 1024 } }),
  )
  analyse(
    @Body('annee') annee: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    return this.service.analyse(fichierExcel(fichier), anneeScolaire(annee));
  }

  @Roles('DG')
  @Post('appliquer')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 30 * 1024 * 1024 } }),
  )
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body('annee') annee: string,
    @Body('cles') clesTexte: string,
    @Body('ajouter') ajouterTexte: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    let cles: unknown;
    let ajouter: unknown;
    try {
      cles = JSON.parse(clesTexte || '[]');
      ajouter = JSON.parse(ajouterTexte || '[]');
    } catch {
      throw new BadRequestException('Choix illisibles : refaites l’essai.');
    }
    const liste = Array.isArray(cles)
      ? cles.filter((x): x is string => typeof x === 'string').slice(0, 20000)
      : [];
    const ajouts = Array.isArray(ajouter)
      ? ajouter
          .filter(
            (x): x is AjoutEcole =>
              !!x &&
              typeof (x as AjoutEcole).cle === 'string' &&
              Number.isInteger((x as AjoutEcole).inspectionId),
          )
          .slice(0, 5000)
      : [];
    return this.service.appliquer(
      u,
      fichierExcel(fichier),
      anneeScolaire(annee),
      liste,
      ajouts,
      fichier?.originalname?.slice(0, 200) ?? 'fichier',
    );
  }
}
