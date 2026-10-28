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
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { StockageService } from '../common/stockage';
import { JournalService } from '../core/core.service';
import { CarriereService, type EvenementDto } from './carriere.service';
import {
  RetardsEchelonsService,
  type FiltresRetards,
} from './retards-echelons.service';
import { configDefaut, LIBELLES_TYPES } from './configuration';
import { ExcelRecensementService } from './excel-recensement.service';
import {
  RecensementService,
  type ChangementStatutDto,
  type FicheDto,
  type FiltresAgents,
} from './recensement.service';

/** Agents de la DGRHAS, DDEPPSA (leur département), comptes d'établissement ou d'inspection (leurs agents). */
const ROLES_RECENSEMENT = [
  ...ROLES_TRAITEMENT,
  'DDEPPSA',
  'STRUCTURE',
] as const;
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function envoyer(res: Response, nom: string, contenu: Buffer) {
  res.setHeader('Content-Type', XLSX);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${nom.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nom)}`,
  );
  res.send(contenu);
}

function classeur(fichier?: Express.Multer.File) {
  if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
    throw new BadRequestException('Choisissez un fichier Excel (.xlsx).');
  return fichier.buffer;
}

const nombre = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
function filtres(q: Record<string, string | undefined>): FiltresAgents {
  return {
    recherche: q.recherche,
    statut: q.statut || undefined,
    departement: nombre(q.departement),
    structure: nombre(q.structure),
    complet: q.complet === 'oui' || q.complet === 'non' ? q.complet : undefined,
    manque: q.manque || undefined,
    controle: q.controle || undefined,
    ajout: q.ajout || undefined,
    page: nombre(q.page),
  };
}

/** Recensement du personnel : fiches de renseignements, pièces, import et export Excel, contrôles. */
@Roles(...ROLES_RECENSEMENT)
@Controller('recensement')
export class RecensementController {
  constructor(
    private readonly rec: RecensementService,
    private readonly excel: ExcelRecensementService,
    private readonly stockage: StockageService,
    private readonly journal: JournalService,
    private readonly carriere: CarriereService,
    private readonly retards: RetardsEchelonsService,
  ) {}

  /* ------------------------------ Configuration ------------------------------ */

  @Get('configuration')
  configuration() {
    return {
      configuration: this.rec.config.get(),
      defaut: configDefaut(),
      types: LIBELLES_TYPES,
    };
  }

  @Roles('DG')
  @Put('configuration')
  async enregistrerConfiguration(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: unknown,
  ) {
    const c = await this.rec.config.enregistrer(corps);
    // Ce qui manque à chaque fiche dépend de la configuration : tout est recalculé
    await this.rec.reevaluer();
    await this.journal.log(
      u,
      'RECENSEMENT_CONFIGURATION',
      'parametre',
      'RECENSEMENT_CONFIG',
      {
        rubriques: c.champs.length,
        pieces: c.pieces.length,
      },
    );
    return c;
  }

  /* ------------------------------ Agents ------------------------------ */

  @Get('structures')
  structures(@Utilisateur() u: UtilisateurConnecte) {
    return this.rec.structuresPermises(u);
  }

  @Get('agents')
  liste(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.rec.liste(u, filtres(q));
  }

  /** Bottin imprimable : toute la liste filtrée, par ordre alphabétique. */
  @Get('bottin')
  bottin(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.rec.bottin(u, filtres(q));
  }

  @Get('agents/:id')
  fiche(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.rec.fiche(u, id);
  }

  @Post('agents')
  creer(@Utilisateur() u: UtilisateurConnecte, @Body() dto: FicheDto) {
    return this.rec.creer(u, dto);
  }

  @Put('agents/:id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FicheDto,
  ) {
    return this.rec.modifier(u, id, dto);
  }

  @Delete('agents/:id')
  supprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.rec.supprimer(u, id);
  }

  /** Statut proposé à l'intégration (âge à la date du texte, catégorie du diplôme). */
  @Get('agents/:id/statut-prevu')
  statutPrevu(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Query('date') date?: string,
  ) {
    return this.rec.statutPrevu(u, id, date);
  }

  /** Changement de statut de la même personne (intégration…). */
  @Post('agents/:id/statut')
  changerStatut(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangementStatutDto,
  ) {
    return this.rec.changerStatut(u, id, dto);
  }

  /** Bureau du contrôle : avis sur un agent ajouté au recensement, avant la décision du DG. */
  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'BUREAU_ETUDES')
  @Post('agents/:id/controle')
  controlerContentieux(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() corps: { avis: string; note?: string },
  ) {
    return this.rec.controlerContentieux(u, id, corps.avis, corps.note);
  }

  @Roles('DG')
  @Post('agents/:id/contentieux')
  deciderContentieux(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() corps: { decision: string; note?: string },
  ) {
    return this.rec.deciderContentieux(u, id, corps.decision, corps.note);
  }

  @Get('agents/:id/memes-personnes')
  memesPersonnes(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.rec.memesPersonnes(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('agents/:id/fusionner')
  fusionner(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body('avec', ParseIntPipe) avec: number,
  ) {
    return this.rec.fusionner(u, id, avec);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('agents/:id/distinct')
  distinguer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body('de', ParseIntPipe) de: number,
  ) {
    return this.rec.distinguer(u, id, de);
  }

  /* ------------------------------ Dossier de carrière ------------------------------ */

  @Get('agents/:id/carriere')
  dossierCarriere(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.carriere.dossier(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('agents/:id/carriere')
  ajouterEvenement(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EvenementDto,
  ) {
    return this.carriere.ajouter(u, id, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put('agents/:id/carriere/:ev')
  modifierEvenement(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('ev') ev: string,
    @Body() dto: EvenementDto,
  ) {
    return this.carriere.modifier(u, id, ev, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Delete('agents/:id/carriere/:ev')
  supprimerEvenement(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('ev') ev: string,
  ) {
    return this.carriere.supprimer(u, id, ev);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('agents/:id/carriere/:ev/acte')
  @UseInterceptors(
    FileInterceptor('fichier', {
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, f, cb) =>
        cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
    }),
  )
  joindreActe(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('ev') ev: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier)
      throw new BadRequestException(
        'Choisissez le scan de l’acte en PDF, JPG ou PNG (15 Mo au plus).',
      );
    return this.carriere.joindreActe(u, id, ev, fichier);
  }

  @Get('agents/:id/carriere/:ev/acte')
  async acteEvenement(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('ev') ev: string,
    @Res() res: Response,
  ) {
    const e = await this.carriere.acteFichier(u, id, ev);
    await this.stockage.servir(res, 'recensement', e.fichier!, {
      mime: e.mime ?? undefined,
      nomAffiche: e.nomOrigine ?? undefined,
    });
  }

  /* ------------------------------ Pièces ------------------------------ */

  @Post('agents/:id/pieces')
  @UseInterceptors(
    FileInterceptor('fichier', {
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, f, cb) =>
        cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
    }),
  )
  ajouterPiece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body('type') type: string,
    @Body('ligne') ligne?: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier)
      throw new BadRequestException(
        'Choisissez un scan en PDF, JPG ou PNG (15 Mo au plus).',
      );
    const n = Number(ligne);
    return this.rec.ajouterPiece(
      u,
      id,
      type,
      fichier,
      Number.isInteger(n) && n >= 1 && n <= 50 ? n : null,
    );
  }

  @Get('agents/:id/pieces/:piece')
  async piece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('piece') piece: string,
    @Res() res: Response,
  ) {
    const p = await this.rec.piece(u, id, piece);
    await this.stockage.servir(res, 'recensement', p.fichier, {
      mime: p.mime,
      nomAffiche: p.nomOrigine,
    });
  }

  @Delete('agents/:id/pieces/:piece')
  supprimerPiece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('piece') piece: string,
  ) {
    return this.rec.supprimerPiece(u, id, piece);
  }

  @Post('pieces')
  @UseInterceptors(
    FilesInterceptor('fichiers', 50, {
      limits: { fileSize: 15 * 1024 * 1024 },
    }),
  )
  piecesEnMasse(
    @Utilisateur() u: UtilisateurConnecte,
    @UploadedFiles() fichiers?: Express.Multer.File[],
  ) {
    if (!fichiers?.length)
      throw new BadRequestException('Choisissez les scans à déposer.');
    return this.rec.piecesEnMasse(u, fichiers);
  }

  /* ------------------------------ Excel ------------------------------ */

  @Get('modele')
  async modele(
    @Utilisateur() u: UtilisateurConnecte,
    @Res() res: Response,
    @Query('statut') statut?: string,
  ) {
    const s = statut ? this.rec.config.statut(statut) : null;
    envoyer(
      res,
      `Fiche de renseignements${s ? ` - ${s.libelle}` : ''}.xlsx`,
      await this.excel.classeur(u, { statut: s?.code }),
    );
  }

  @Get('export')
  async exporter(
    @Utilisateur() u: UtilisateurConnecte,
    @Res() res: Response,
    @Query() q: Record<string, string | undefined>,
  ) {
    envoyer(
      res,
      'Base du personnel.xlsx',
      await this.excel.exporter(u, filtres(q)),
    );
  }

  @Post('analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  analyser(@UploadedFile() fichier?: Express.Multer.File) {
    return this.excel.analyser(classeur(fichier));
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importer(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('feuille') feuille: string,
    @Query('statut') statut: string | undefined,
    @Query('essai') essai: string | undefined,
    @Query('mode') mode: string | undefined,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    return this.excel.importer(u, classeur(fichier), {
      feuille,
      statutDefaut: statut || undefined,
      essai: essai !== '0',
      recensement: mode === 'recensement',
    });
  }

  /* ------------------------------ Tableau de bord ------------------------------ */

  @Get('tableau')
  tableau(@Utilisateur() u: UtilisateurConnecte) {
    return this.rec.tableau(u);
  }

  /* ---------------- Échelons en retard (commission administrative paritaire) ---------------- */

  private filtresRetards(
    q: Record<string, string | undefined>,
  ): FiltresRetards {
    const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    return {
      departement: n(q.departement),
      structure: n(q.structure),
      annee: n(q.annee),
      categorie: q.categorie || undefined,
      cycle: q.cycle || undefined,
      dus: q.dus || undefined,
      statut: q.statut || undefined,
      recherche: q.recherche || undefined,
    };
  }

  @Get('retards-echelons')
  retardsEchelons(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.retards.calculer(u, this.filtresRetards(q));
  }

  @Get('retards-echelons/excel')
  async retardsExcel(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const contenu = await this.retards.excel(u, this.filtresRetards(q));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('Échelons en retard.xlsx')}`,
    );
    res.send(contenu);
  }

  @Get('retards-echelons/word')
  async retardsWord(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const contenu = await this.retards.word(u, this.filtresRetards(q));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('Échelons en retard.docx')}`,
    );
    res.send(contenu);
  }
}
