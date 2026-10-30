import {
  BadRequestException,
  Body,
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
import type { Response } from 'express';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import {
  type FiltresNominations,
  NominationsService,
} from './nominations.service';

const nombre = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** Nominations des cadres de gestion (DGRHAS et directions départementales). */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
@Controller('nominations')
export class NominationsController {
  constructor(private readonly service: NominationsService) {}

  private filtres(q: Record<string, string | undefined>): FiltresNominations {
    return {
      annee: q.annee,
      departement: nombre(q.departement),
      categorie: q.categorie || undefined,
      groupe: q.groupe || undefined,
      statut: q.statut || undefined,
      observation: q.observation || undefined,
      recherche: q.recherche || undefined,
      modifiees: q.modifiees === '1',
      doublons: q.doublons === '1',
    };
  }

  @Get()
  liste(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.service.liste(u, this.filtres(q));
  }

  @Get('excel')
  async excel(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const contenu = await this.service.excel(u, this.filtres(q));
    const nom = `Nominations ${q.annee ?? ''}.xlsx`.replace('  ', ' ');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nom}"; filename*=UTF-8''${encodeURIComponent(nom)}`,
    );
    res.send(contenu);
  }

  @Get('candidats')
  candidats(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('q') q: string,
    @Query('categorie') categorie?: string,
  ) {
    return this.service.candidats(u, q ?? '', categorie);
  }

  /** Circonscriptions déjà écrites dans les nominations du département (pour les choisir). */
  @Get('circonscriptions')
  circonscriptions(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('departement') departement?: string,
    @Query('annee') annee?: string,
  ) {
    return this.service.circonscriptions(
      u,
      Number(departement) || undefined,
      annee,
    );
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importer(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('annee') annee: string,
    @Query('feuille') feuille: string | undefined,
    @Query('essai') essai: string | undefined,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException(
        'Choisissez le classeur Excel (.xlsx) de la base des nominations.',
      );
    return this.service.importer(u, fichier.buffer, {
      annee,
      feuille,
      essai: essai !== '0',
    });
  }

  @Post('annee')
  preparerAnnee(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: { annee: string },
  ) {
    return this.service.preparerAnnee(u, dto?.annee);
  }

  @Post('decision')
  decider(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: { ids: number[]; decision: string; avis?: string },
  ) {
    return this.service.decider(u, dto);
  }

  @Post()
  ajouter(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.service.ajouter(u, dto ?? {});
  }

  @Put(':id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.service.modifier(u, id, dto ?? {});
  }

  @Delete(':id')
  supprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.supprimer(u, id);
  }
}
