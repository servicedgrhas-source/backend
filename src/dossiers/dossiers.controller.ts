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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import {
  Roles,
  ROLES_CONTROLE,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { normaliser } from '../common/texte';
import { StockageService } from '../common/stockage';
import { ComplementsService } from './complements.service';
import { DossiersService, type FiltresEnvois } from './dossiers.service';
import { RapprochementService } from './rapprochement.service';

class OrigineDto {
  @IsString() @MaxLength(150) libelle: string;
  @IsOptional() @IsBoolean() actif?: boolean;
}

const entier = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

function filtres(q: Record<string, string | undefined>): FiltresEnvois {
  return {
    recherche: q.recherche,
    quota: entier(q.quota),
    transmission: entier(q.transmission),
    statut: q.statut || undefined,
    diplomeCode: q.diplomeCode || undefined,
    departementId: entier(q.departementId),
    lotCommission: q.lotCommission || undefined,
    texte: (['attente', 'recu'].includes(q.texte ?? '')
      ? q.texte
      : '') as FiltresEnvois['texte'],
    page: entier(q.page),
    taille: entier(q.taille),
  };
}

/** Base des envoyés à la FP, fiche complète d'un dossier, recherche globale. */
@Roles(...ROLES_TRAITEMENT)
@Controller()
export class DossiersController {
  constructor(
    private readonly service: DossiersService,
    private readonly complements: ComplementsService,
    private readonly rapprochement: RapprochementService,
    private readonly stockage: StockageService,
  ) {}

  /* --------------- Rapprochement de fichiers (jusqu'à 4 fichiers Excel) --------------- */

  private fichiersRapprochement(fichiers?: Express.Multer.File[]) {
    const liste = (fichiers ?? []).filter((f) =>
      /\.xlsx$/i.test(f.originalname),
    );
    if ((fichiers ?? []).length !== liste.length)
      throw new BadRequestException(
        'Seuls les fichiers Excel (.xlsx) sont acceptés.',
      );
    // Le nom arrive encodé en latin1 par le navigateur : on le remet en UTF-8
    return liste.map((f) => ({
      nom: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      contenu: f.buffer,
    }));
  }

  /** Feuilles choisies par fichier (JSON : [["Traitement"], null, …]) ; null : toutes. */
  private feuillesChoisies(brut?: string) {
    if (!brut) return undefined;
    try {
      const v = JSON.parse(brut) as unknown;
      return Array.isArray(v)
        ? v.map((x) => (Array.isArray(x) ? x.map(String) : null))
        : undefined;
    } catch {
      throw new BadRequestException('Choix des feuilles illisible.');
    }
  }

  /** Les feuilles de chaque fichier, pour choisir celles à comparer. */
  @Roles(...ROLES_TRAITEMENT)
  @Post('rapprochement/feuilles')
  @UseInterceptors(
    FilesInterceptor('fichiers', 4, { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  feuillesRapprochement(
    @UploadedFiles() fichiers: Express.Multer.File[],
    @Body() body: { masquees?: string },
  ) {
    return this.rapprochement.feuilles(
      this.fichiersRapprochement(fichiers),
      body.masquees === '1',
    );
  }

  /** Compare les fichiers entre eux (et avec la base si demandé) ; rien n'est enregistré. */
  @Roles(...ROLES_TRAITEMENT)
  @Post('rapprochement')
  @UseInterceptors(
    FilesInterceptor('fichiers', 4, { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  async rapprocher(
    @UploadedFiles() fichiers: Express.Multer.File[],
    @Body() body: { avecBase?: string; masquees?: string },
  ) {
    const r = await this.rapprochement.comparer(
      this.fichiersRapprochement(fichiers),
      {
        avecBase: body.avecBase === '1',
        masquees: body.masquees === '1',
      },
    );
    const { lignes: _lignes, ...reste } = r;
    void _lignes;
    return reste;
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('rapprochement/excel')
  @UseInterceptors(
    FilesInterceptor('fichiers', 4, { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  async rapprocherExcel(
    @UploadedFiles() fichiers: Express.Multer.File[],
    @Body() body: { avecBase?: string; masquees?: string; feuilles?: string },
    @Res() res: Response,
  ) {
    const contenu = await this.rapprochement.excel(
      this.fichiersRapprochement(fichiers),
      {
        avecBase: body.avecBase === '1',
        masquees: body.masquees === '1',
      },
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="Rapprochement.xlsx"',
    );
    res.send(contenu);
  }

  /* ---------------------- Origines des dossiers ---------------------- */

  @Get('origines')
  origines(@Query('toutes') toutes?: string) {
    return this.complements.listeOrigines(toutes === '1');
  }

  @Roles('DG')
  @Post('origines')
  ajouterOrigine(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: OrigineDto,
  ) {
    return this.complements.enregistrerOrigine(u, null, dto);
  }

  @Roles('DG')
  @Put('origines/:id')
  modifierOrigine(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: OrigineDto,
  ) {
    return this.complements.enregistrerOrigine(u, id, dto);
  }

  @Roles('DG')
  @Delete('origines/:id')
  supprimerOrigine(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.complements.supprimerOrigine(u, id);
  }

  /* ------------- Anciens recrutés : doublons d'une année à l'autre ------------- */

  @Get('anciens')
  anciens() {
    return this.complements.resumeAnciens();
  }

  /** Chercher un nom dans les listes des années passées (vérification à la main). */
  @Get('anciens/chercher')
  async chercherAncien(@Query('nom') nom = '') {
    if (nom.trim().length < 3) return [];
    return (await this.complements.anciensProches(normaliser(nom))).map(
      (x) => ({
        nomComplet: x.nomComplet,
        dateNaissance: x.dateNaissance,
        annee: x.annee,
        source: x.source,
        diplome: x.diplome,
      }),
    );
  }

  @Roles('CHEF_SERVICE', 'DG')
  @Post('anciens/import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 60 * 1024 * 1024 } }),
  )
  importerAnciens(
    @Utilisateur() u: UtilisateurConnecte,
    @UploadedFile() fichier?: Express.Multer.File,
    @Body('annee') annee?: string,
  ) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException('Choisissez un fichier Excel (.xlsx).');
    return this.complements.importerAnciens(
      u,
      fichier.buffer,
      fichier.originalname,
      entier(annee) ?? null,
    );
  }

  @Roles('CHEF_SERVICE', 'DG')
  @Delete('anciens')
  supprimerAnciens(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('source') source: string,
  ) {
    if (!source) throw new BadRequestException('Source manquante.');
    return this.complements.supprimerSource(u, source);
  }

  /* -------------------- Scans joints au dossier -------------------- */

  @Get('dossiers/:id/pieces')
  pieces(@Param('id') id: string) {
    return this.complements.piecesDe(id);
  }

  @Post('dossiers/:id/pieces')
  @UseInterceptors(
    FileInterceptor('fichier', {
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, f, cb) =>
        cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
      // Fichier gardé en mémoire, puis envoyé au stockage (Cloudflare R2 ou disque local)
    }),
  )
  async ajouterPiece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @UploadedFile() fichier?: Express.Multer.File,
    @Body('nature') nature?: string,
    @Body('legalise') legalise?: string,
  ) {
    if (!fichier)
      throw new BadRequestException(
        'Choisissez un scan en PDF, JPG ou PNG (15 Mo au plus).',
      );
    await this.stockage.enregistrer('pieces', fichier);
    return this.complements.ajouterPiece(
      u,
      id,
      fichier,
      nature ?? 'TEXTE',
      legalise === '1' || legalise === 'true',
    );
  }

  @Get('dossiers/:id/pieces/:piece')
  async piece(
    @Param('id') id: string,
    @Param('piece') piece: string,
    @Res() res: Response,
  ) {
    const p = await this.complements.piece(id, piece);
    await this.stockage.servir(res, 'pieces', p.fichier, {
      mime: p.mime,
      nomAffiche: p.nomOrigine,
    });
  }

  @Patch('dossiers/:id/pieces/:piece')
  modifierPiece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Param('piece') piece: string,
    @Body('legalise') legalise: boolean,
  ) {
    return this.complements.modifierPiece(u, id, piece, !!legalise);
  }

  @Roles(...ROLES_CONTROLE)
  @Delete('dossiers/:id/pieces/:piece')
  supprimerPiece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Param('piece') piece: string,
  ) {
    return this.complements.supprimerPiece(u, id, piece);
  }

  @Get('envois')
  envoyes(@Query() q: Record<string, string | undefined>) {
    return this.service.envoyes(filtres(q));
  }

  @Get('envois/filtres')
  filtresEnvois() {
    return this.service.filtresEnvois();
  }

  @Get('envois/excel')
  async excel(
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const contenu = await this.service.exporterEnvois(filtres(q));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('Envoyés à la FP.xlsx')}`,
    );
    res.send(contenu);
  }

  @Get('dossiers/recherche')
  recherche(@Query('q') q: string) {
    return this.service.recherche(q);
  }

  @Get('dossiers/:id')
  dossier(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    // Origine et membre de la commission : informations internes (DG, contrôle)
    const interne = [
      'DG',
      'ADMIN',
      'CHEF_SERVICE',
      'DIRECTEUR',
      'BUREAU_ETUDES',
    ].includes(u.role);
    return this.service.dossier(id, interne);
  }
}
