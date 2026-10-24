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
import { MiseEnRouteService } from './mise-en-route.service';
import {
  PilotageEnrolementService,
  type BesoinDto,
} from './pilotage-enrolement.service';
import { RegularisationsService } from './regularisations.service';
import { VolontairesService } from './volontaires.service';

const GESTION = ['CHEF_SERVICE', 'DIRECTEUR', 'DG'] as const;
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

/** Correction en série, régularisations, mises en route, besoins et tableau de bord de l'enrôlement. */
@Controller('enrolement')
export class GestionEnrolementController {
  constructor(
    private readonly volontaires: VolontairesService,
    private readonly regs: RegularisationsService,
    private readonly mer: MiseEnRouteService,
    private readonly pilotage: PilotageEnrolementService,
  ) {}

  /* --------------------------- Correction en série --------------------------- */

  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires-valeurs')
  valeurs(@Query('champ') champ: string) {
    return this.volontaires.valeurs(champ);
  }

  @Roles(...GESTION)
  @Post('volontaires-correction')
  corriger(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    dto: { champ: string; ancienne: string | null; nouvelle: string | null },
  ) {
    return this.volontaires.corrigerEnSerie(u, dto ?? ({} as never));
  }

  /* ------------------------------ Régularisations ------------------------------ */

  @Roles(...ROLES_TRAITEMENT)
  @Get('regularisations')
  regularisations(
    @Query('statut') statut?: string,
    @Query('origine') origine?: string,
    @Query('recherche') recherche?: string,
  ) {
    return this.regs.liste({
      statut: statut || undefined,
      origine: origine || undefined,
      recherche,
    });
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('regularisations/trop-percus')
  tropPercus() {
    return this.regs.tropPercus();
  }

  @Roles(...GESTION)
  @Post('regularisations/trop-percus/retenues')
  retenues(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: { choix?: { volontaireId: string; origine: string }[] },
  ) {
    return this.regs.creerRetenues(u, dto?.choix);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('regularisations/a-recouvrer/excel')
  async aRecouvrer(@Res() res: Response) {
    envoyer(
      res,
      'Sommes à recouvrer - volontaires.xlsx',
      await this.regs.excelARecouvrer(),
    );
  }

  @Roles(...GESTION)
  @Post('regularisations')
  creerRegularisation(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    dto: { volontaireId: string; type: string; montant: number; motif: string },
  ) {
    return this.regs.creer(u, { ...(dto ?? ({} as never)), origine: 'MANUEL' });
  }

  @Roles(...GESTION)
  @Post('regularisations/:id/annulation')
  annuler(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { motif: string },
  ) {
    return this.regs.annuler(u, id, dto?.motif);
  }

  /* ------------------------------ Mise en route ------------------------------ */

  @Roles(...ROLES_TRAITEMENT)
  @Get('mises-en-route')
  misesEnRoute() {
    return this.mer.liste();
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('mises-en-route/notes')
  notesMer() {
    return this.mer.notes();
  }

  @Roles(...GESTION)
  @Post('mises-en-route/analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  analyserMer(@UploadedFile() fichier?: Express.Multer.File) {
    return this.mer.analyser(classeur(fichier));
  }

  @Roles(...GESTION)
  @Post('mises-en-route/import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importerMer(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('feuille') feuille: string,
    @Query('libelle') libelle: string,
    @Query('note') note: string | undefined,
    @Query('essai') essai: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    const contenu = classeur(fichier);
    return this.mer.importer(u, contenu, fichier!.originalname, {
      feuille,
      libelle,
      noteReference: note,
      essai: essai === '1',
    });
  }

  @Roles(...GESTION)
  @Post('mises-en-route')
  preparerMer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: { noteReference: string; libelle?: string; id?: number },
  ) {
    return this.mer.preparer(u, dto ?? ({} as never));
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('mises-en-route/:id')
  detailMer(@Param('id', ParseIntPipe) id: number) {
    return this.mer.detail(id);
  }

  @Roles('DG')
  @Post('mises-en-route/:id/validation')
  validerMer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.mer.valider(u, id);
  }

  @Roles('DG')
  @Post('mises-en-route/:id/reouverture')
  rouvrirMer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { motif: string },
  ) {
    return this.mer.rouvrir(u, id, dto?.motif);
  }

  @Roles(...GESTION)
  @Delete('mises-en-route/:id')
  supprimerMer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.mer.supprimer(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('mises-en-route/:id/excel')
  async excelMer(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { nom, contenu } = await this.mer.excel(id);
    envoyer(res, nom, contenu);
  }

  /* ------------------------------ Besoins ------------------------------ */

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
  @Get('besoins')
  besoins(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('departement') departement?: string,
  ) {
    return this.pilotage.besoinsAvecCouverture(
      u,
      departement && /^\d+$/.test(departement)
        ? Number(departement)
        : undefined,
    );
  }

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
  @Get('besoins/excel')
  async excelBesoins(
    @Utilisateur() u: UtilisateurConnecte,
    @Res() res: Response,
  ) {
    envoyer(
      res,
      'Besoins en volontaires.xlsx',
      await this.pilotage.excelBesoins(u),
    );
  }

  @Roles(...GESTION, 'DDEPPSA')
  @Post('besoins')
  creerBesoin(@Utilisateur() u: UtilisateurConnecte, @Body() dto: BesoinDto) {
    return this.pilotage.creerBesoin(u, dto ?? ({} as never));
  }

  @Roles(...GESTION, 'DDEPPSA')
  @Put('besoins/:id')
  modifierBesoin(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BesoinDto,
  ) {
    return this.pilotage.modifierBesoin(u, id, dto ?? ({} as never));
  }

  @Roles(...GESTION, 'DDEPPSA')
  @Delete('besoins/:id')
  supprimerBesoin(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.pilotage.supprimerBesoin(u, id);
  }

  /* ------------------------------ Tableau de bord ------------------------------ */

  /** Où en est chaque étape des parcours (page d'accueil de l'enrôlement). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('guide')
  guide() {
    return this.pilotage.guide();
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('tableau')
  tableau() {
    return this.pilotage.tableau();
  }
}
