import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import {
  OriginesEnrolementService,
  voitOrigine,
} from './origines-enrolement.service';

/**
 * Origine des enrôlés (DG, 16/11/2026) : groupes, statistiques et incidence, regroupements, et
 * récupération depuis les fichiers de saisie. Pour la DGRHAS seulement.
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('enrolement')
export class OriginesEnrolementController {
  constructor(private readonly origines: OriginesEnrolementService) {}

  private dgrhas(u: UtilisateurConnecte) {
    if (!voitOrigine(u))
      throw new ForbiddenException(
        'L’origine des enrôlés est réservée à la DGRHAS.',
      );
  }

  private fichier(f?: Express.Multer.File) {
    if (!f || !/\.xlsx$/i.test(f.originalname))
      throw new BadRequestException('Choisissez un fichier Excel (.xlsx).');
    return {
      contenu: f.buffer,
      nom: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    };
  }

  @Get('origines')
  groupes(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('campagne', ParseIntPipe) campagne: number,
  ) {
    this.dgrhas(u);
    return this.origines.groupes(campagne);
  }

  @Post('origines/rattacher')
  rattacher(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() b: { cle?: string; cible?: string | null },
  ) {
    this.dgrhas(u);
    return this.origines.rattacher(
      u,
      String(b?.cle ?? '').slice(0, 200),
      b?.cible ? String(b.cible).slice(0, 200) : null,
    );
  }

  @Post('origines/renommer')
  renommer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() b: { cle?: string; libelle?: string | null },
  ) {
    this.dgrhas(u);
    if (!b?.cle) throw new BadRequestException('Origine inconnue.');
    return this.origines.renommer(
      u,
      String(b.cle).slice(0, 200),
      b.libelle ? String(b.libelle) : null,
    );
  }

  @Post('origines/analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  analyser(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('campagne', ParseIntPipe) campagne: number,
    @UploadedFile() f?: Express.Multer.File,
  ) {
    this.dgrhas(u);
    return this.origines.analyser(this.fichier(f).contenu, campagne);
  }

  @Post('origines/recuperer')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  recuperer(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('campagne', ParseIntPipe) campagne: number,
    @UploadedFile() f?: Express.Multer.File,
  ) {
    this.dgrhas(u);
    const x = this.fichier(f);
    return this.origines.appliquer(u, x.contenu, x.nom, campagne);
  }

  @Patch('dossiers/:id/origine')
  definir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() b: { origine?: string | null },
  ) {
    this.dgrhas(u);
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new BadRequestException('Enrôlé inconnu.');
    return this.origines.definir(u, id, b?.origine ?? null);
  }
}
