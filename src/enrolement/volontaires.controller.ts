import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
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
import { DEPARTEMENTS } from '../common/referentiels';
import { BottinService } from './bottin.service';
import { BourseService, CONTROLES } from './bourse.service';
import { ConfigEnrolementService, LIBELLES_DEBUT } from './configuration';
import { CYCLES_ENROLEMENT } from './enrolement.service';
import { VolontairesService, type VolontaireDto } from './volontaires.service';

const entierOuRien = (v?: string) =>
  v && /^\d+$/.test(v) ? Number(v) : undefined;

@Controller('enrolement')
export class VolontairesController {
  constructor(
    private readonly volontaires: VolontairesService,
    private readonly bourse: BourseService,
    private readonly bottin: BottinService,
    private readonly config: ConfigEnrolementService,
  ) {}

  /* ---------------------------- Configuration ---------------------------- */

  /** Configuration en vigueur, ses libellés et la bourse de chaque cycle des campagnes. */
  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
  @Get('configuration')
  configuration() {
    const c = this.config.get();
    return {
      configuration: c,
      defaut: this.config.defaut(),
      departements: DEPARTEMENTS.map((d) => ({ code: d.code, nom: d.nom })),
      reglesDebut: LIBELLES_DEBUT,
      controles: {
        ...CONTROLES,
        MISE_EN_ROUTE: {
          libelle: 'Mise en route déjà payée',
          gravite: 'BLOQUANT',
        },
      },
      boursesParCycle: Object.fromEntries(
        CYCLES_ENROLEMENT.map((cy) => [
          cy,
          this.config.categorieDepuisTexte(cy)?.bourse ?? 0,
        ]),
      ),
    };
  }

  @Roles('DG')
  @Put('configuration')
  enregistrerConfiguration(@Body() dto: unknown) {
    return this.config.enregistrer(dto);
  }

  /* ------------------------------ Registre ------------------------------ */

  /** Le rapport du dernier import de liste, gardé pour le revoir après coup. */
  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires/dernier-import')
  dernierImport(@Query('population') population?: string) {
    return this.volontaires.dernierImport(
      population === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRE' : 'VOLONTAIRE',
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires')
  liste(
    @Query('recherche') recherche?: string,
    @Query('statut') statut?: string,
    @Query('departement') departement?: string,
    @Query('categorie') categorie?: string,
    @Query('motif') motif?: string,
    @Query('page') page?: string,
    @Query('taille') taille?: string,
    @Query('population') population?: string,
    @Query('vague') vague?: string,
  ) {
    return this.volontaires.liste({
      population,
      // « aucune » : les volontaires dont la vague n'est pas reconnue
      vague:
        vague === undefined || vague === ''
          ? undefined
          : vague === 'aucune'
            ? null
            : Number(vague),
      recherche,
      statut: statut || undefined,
      departementId: entierOuRien(departement),
      categorie: categorie || undefined,
      motif: motif || undefined,
      page: entierOuRien(page),
      taille: entierOuRien(taille),
    });
  }

  /** Enrôlés des notes signées qui ne sont pas encore dans le registre. */
  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires/a-integrer')
  async aIntegrer() {
    const l = await this.volontaires.enAttente();
    return l.map((e) => ({
      id: e.id,
      nomComplet: e.nomComplet,
      cycle: e.cycle,
      note: e.noteNumero,
    }));
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires/integration')
  integrer(@Utilisateur() u: UtilisateurConnecte) {
    return this.volontaires.integrerNotes(u);
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires')
  creer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: VolontaireDto & { forcer?: boolean },
  ) {
    return this.volontaires.creer(u, dto ?? {});
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires/:id')
  fiche(@Param('id', ParseUUIDPipe) id: string) {
    return this.volontaires.fiche(id);
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Put('volontaires/:id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VolontaireDto,
  ) {
    return this.volontaires.modifier(u, id, dto ?? {});
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires/sortie')
  sortirPlusieurs(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    dto: {
      ids: string[];
      motif: string;
      date: string;
      observation?: string;
      observations?: Record<string, string>;
    },
  ) {
    return this.volontaires.sortirPlusieurs(u, dto ?? ({} as never));
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires/:id/sortie')
  sortir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { motif: string; date: string; observation?: string },
  ) {
    return this.volontaires.sortir(u, id, dto ?? ({} as never));
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires/:id/reintegration')
  reintegrer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { date: string; observation?: string },
  ) {
    return this.volontaires.reintegrer(u, id, dto ?? ({} as never));
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires/:id/verification')
  verifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { controle: string; note: string },
  ) {
    return this.volontaires.verifier(u, id, dto ?? ({} as never));
  }

  /** Feuilles d'un fichier de bourse (avant de choisir celle à reprendre). */
  @Roles('CHEF_SERVICE', 'DG')
  @Post('volontaires/analyse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  analyser(@UploadedFile() fichier?: Express.Multer.File) {
    return this.volontaires.analyser(this.classeur(fichier));
  }

  @Roles('CHEF_SERVICE', 'DG')
  @Post('volontaires/import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importer(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('feuille') feuille: string,
    @Query('type') type: string,
    @Query('motif') motif: string | undefined,
    @Query('premierMois') premierMois: string | undefined,
    @Query('note') note: string | undefined,
    @Query('dateNote') dateNote: string | undefined,
    @Query('categorie') categorie: string | undefined,
    @Query('essai') essai: string,
    @Query('population') population: string | undefined,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (type !== 'EN_POSTE' && type !== 'SORTI' && type !== 'NOTE')
      throw new BadRequestException(
        'Type de liste : volontaires en poste, sortants ou note de service.',
      );
    if (!feuille)
      throw new BadRequestException('Choisissez la feuille à reprendre.');
    return this.volontaires.importer(
      u,
      this.classeur(fichier),
      fichier!.originalname,
      {
        feuille,
        type,
        motif: motif || undefined,
        premierMois: premierMois || undefined,
        noteReference: note || undefined,
        dateNote: dateNote || undefined,
        categorie: categorie || undefined,
        population: population || undefined,
        essai: essai === '1',
      },
    );
  }

  private classeur(fichier?: Express.Multer.File) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException('Choisissez un fichier Excel (.xlsx).');
    return fichier.buffer;
  }

  /* ------------------------------- Bottin de la solde ------------------------------- */

  @Roles(...ROLES_TRAITEMENT)
  @Get('bottin')
  moisBottin() {
    return this.bottin.mois();
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('bottin/import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importerBottin(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('mois') mois: string,
    @Query('essai') essai: string | undefined,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier || !/\.(xlsx|pdf)$/i.test(fichier.originalname))
      throw new BadRequestException(
        'Choisissez un fichier Excel (.xlsx) ou le PDF « Liste des agents pris en charge » de la Solde.',
      );
    return this.bottin.importer(u, fichier.buffer, fichier.originalname, {
      mois,
      essai: essai !== '0',
    });
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Delete('bottin/:mois')
  supprimerBottin(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('mois') mois: string,
  ) {
    return this.bottin.supprimerMois(u, mois);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('bottin/pointage')
  pointage() {
    return this.bottin.pointage();
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('bottin/sortie')
  sortirPointes(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: { choix: { volontaireId: string; ligneId: number }[] },
  ) {
    return this.bottin.sortir(u, dto?.choix);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('bottin/ecart/:id')
  ecarterBottin(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { note: string },
  ) {
    return this.bottin.ecarter(u, id, dto?.note);
  }

  /* ------------------------------- Bourse ------------------------------- */

  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse')
  etats(@Query('population') population?: string) {
    return this.bourse.liste(population);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id')
  detail(
    @Param('id', ParseIntPipe) id: number,
    @Query('recherche') recherche?: string,
    @Query('departement') departement?: string,
    @Query('categorie') categorie?: string,
    @Query('page') page?: string,
    @Query('taille') taille?: string,
  ) {
    return this.bourse.detail(id, {
      recherche,
      departementId: entierOuRien(departement),
      categorie: categorie || undefined,
      page: entierOuRien(page),
      taille: entierOuRien(taille),
    });
  }

  /** Prépare ou recalcule l'état d'un mois. */
  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('bourse')
  preparer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: { mois: string; population?: string },
  ) {
    return this.bourse.preparer(u, dto?.mois, dto?.population);
  }

  @Roles('DG')
  @Post('bourse/:id/validation')
  valider(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.bourse.valider(u, id);
  }

  @Roles('DG')
  @Post('bourse/:id/reouverture')
  rouvrir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { motif: string },
  ) {
    return this.bourse.rouvrir(u, id, dto?.motif);
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Delete('bourse/:id')
  supprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.bourse.supprimer(u, id);
  }

  /** État de paiement au modèle officiel, pour l'impression (PDF). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id/etat-paiement')
  etatPaiement(@Param('id', ParseIntPipe) id: number) {
    return this.bourse.etatPaiement(id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id/word')
  async word(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { nom, contenu } = await this.bourse.word(id);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nom}"; filename*=UTF-8''${encodeURIComponent(nom)}`,
    );
    res.send(contenu);
  }

  /** Payés deux fois : inscrits deux fois, ou payés aussi sur l'autre liste (une ligne par paire). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id/payes-deux-fois')
  payesDeuxFois(@Param('id', ParseIntPipe) id: number) {
    return this.bourse.payesDeuxFois(id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id/payes-deux-fois/excel')
  async payesDeuxFoisExcel(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const { nom, contenu } = await this.bourse.payesDeuxFoisExcel(id);
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

  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id/excel')
  async excel(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { nom, contenu } = await this.bourse.excel(id);
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
}
