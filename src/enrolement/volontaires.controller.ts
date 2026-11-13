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
import { volontairesExcel, volontairesWord } from './export-volontaires';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { DEPARTEMENTS } from '../common/referentiels';
import { BottinService } from './bottin.service';
import {
  BourseService,
  CONTROLES,
  orientationDocument,
  policeDocument,
} from './bourse.service';
import { ConfigEnrolementService, LIBELLES_DEBUT } from './configuration';
import { CYCLES_ENROLEMENT } from './enrolement.service';
import { EcartsVolontairesService } from '../recensement/ecarts-volontaires.service';
import {
  CHAMPS_MISE_A_JOUR,
  VolontairesService,
  type VolontaireDto,
} from './volontaires.service';

const entierOuRien = (v?: string) =>
  v && /^\d+$/.test(v) ? Number(v) : undefined;

@Controller('enrolement')
export class VolontairesController {
  constructor(
    private readonly volontaires: VolontairesService,
    private readonly bourse: BourseService,
    private readonly bottin: BottinService,
    private readonly config: ConfigEnrolementService,
    private readonly ecarts: EcartsVolontairesService,
  ) {}

  /* ---- Écarts avec la base du personnel (07/11/2026) : registre ↔ fiche du personnel ---- */

  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires/ecarts')
  bilanEcarts(@Query('population') population: string) {
    return this.ecarts.bilan(population);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires/ecarts/liste')
  listeEcarts(
    @Query('population') population: string,
    @Query('cle') cle: string,
    @Query('type') type: string,
    @Query('page') page?: string,
    @Query('recherche') recherche?: string,
  ) {
    return this.ecarts.liste(
      population,
      cle,
      type === 'DIFFERENT' ? 'DIFFERENT' : 'COMPLETER',
      Math.max(1, Number(page) || 1),
      recherche ?? '',
    );
  }

  @Roles('CHEF_SERVICE', 'DG')
  @Post('volontaires/ecarts/appliquer')
  appliquerEcarts(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    corps: {
      population: string;
      cle: string;
      type: 'COMPLETER' | 'DIFFERENT';
      choix: 'PERSONNEL' | 'REGISTRE';
      ids?: string[];
    },
  ) {
    return this.ecarts.appliquer(u, corps ?? ({} as never));
  }

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

  /** Toute la liste filtrée (impression en PDF), avec les libellés. */
  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires/complete')
  listeComplete(
    @Query('recherche') recherche?: string,
    @Query('statut') statut?: string,
    @Query('departement') departement?: string,
    @Query('categorie') categorie?: string,
    @Query('motif') motif?: string,
    @Query('population') population?: string,
    @Query('vague') vague?: string,
  ) {
    return this.volontaires.listeComplete(
      filtresListe({
        recherche,
        statut,
        departement,
        categorie,
        motif,
        population,
        vague,
      }),
    );
  }

  /** La même liste en Excel ou en Word (paysage, mention du système au pied de chaque page). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('volontaires/export')
  async exporterListe(
    @Res() res: Response,
    @Query('format') format: string,
    @Query('titre') titre?: string,
    @Query('recherche') recherche?: string,
    @Query('statut') statut?: string,
    @Query('departement') departement?: string,
    @Query('categorie') categorie?: string,
    @Query('motif') motif?: string,
    @Query('population') population?: string,
    @Query('vague') vague?: string,
  ) {
    if (format !== 'xlsx' && format !== 'docx')
      throw new BadRequestException('Format : xlsx ou docx');
    const pop = population === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRE' : 'VOLONTAIRE';
    const lignes = await this.volontaires.listeComplete(
      filtresListe({
        recherche,
        statut,
        departement,
        categorie,
        motif,
        population,
        vague,
      }),
    );
    const t =
      (titre ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) ||
      (pop === 'COMMUNAUTAIRE'
        ? 'Liste des communautaires'
        : 'Liste des volontaires');
    const contenu =
      format === 'xlsx'
        ? await volontairesExcel(lignes, t, pop)
        : await volontairesWord(lignes, t, pop);
    const nom = `${t.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)}.${format}`;
    res.setHeader(
      'Content-Type',
      format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(nom)}`,
    );
    res.send(contenu);
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

  /** Chercher dans la base du personnel une personne à prendre en charge, avec sa situation. */
  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Get('volontaires/candidats-prise-en-charge')
  candidatsPriseEnCharge(
    @Query('q') q: string,
    @Query('population') population: string,
    @Query('agent') agent?: string,
  ) {
    return this.volontaires.candidatsPriseEnCharge(
      String(q ?? '').slice(0, 80),
      population,
      agent && /^\d+$/.test(agent) ? Number(agent) : null,
    );
  }

  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires')
  creer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    dto: VolontaireDto & {
      forcer?: boolean;
      agentRecenseId?: number;
      forcerFonctionnaire?: boolean;
    },
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

  /** Changer la date de sortie de plusieurs fiches (même population, département, motif, date). */
  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires/dates-sortie')
  changerDatesSortie(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    b: {
      population?: string;
      departementId?: number | null;
      motif?: string | null;
      dateActuelle?: string;
      nouvelleDate?: string;
      essai?: boolean;
    },
  ) {
    return this.volontaires.changerDatesSortie(u, {
      population: String(b?.population ?? ''),
      departementId:
        typeof b?.departementId === 'number' ? b.departementId : null,
      motif: typeof b?.motif === 'string' && b.motif ? b.motif : null,
      dateActuelle: String(b?.dateActuelle ?? ''),
      nouvelleDate: String(b?.nouvelleDate ?? ''),
      essai: b?.essai !== false,
    });
  }

  /** Décisions sur les contrôles de la bourse, une par une ou en masse (cases cochées). */
  @Roles('CHEF_SERVICE', 'DIRECTEUR', 'DG')
  @Post('volontaires/decisions-controles')
  deciderControles(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() b: { decisions?: unknown },
  ) {
    const actions = [
      'SORTIR',
      'VERIFIER',
      'DEUX_PERSONNES',
      'GARDER',
      'COMPLETER',
    ];
    const texte = (x: unknown) => (typeof x === 'string' ? x : undefined);
    const decisions = (Array.isArray(b?.decisions) ? b.decisions : [])
      .filter(
        (d): d is Record<string, unknown> =>
          !!d &&
          typeof d === 'object' &&
          typeof (d as Record<string, unknown>).id === 'string' &&
          actions.includes(String((d as Record<string, unknown>).action)),
      )
      .map((d) => ({
        action: d.action as
          'SORTIR' | 'VERIFIER' | 'DEUX_PERSONNES' | 'GARDER' | 'COMPLETER',
        id: String(d.id),
        autreId: texte(d.autreId),
        controle: texte(d.controle),
        motif: texte(d.motif),
        date: texte(d.date),
        note: texte(d.note)?.slice(0, 500),
        departementId:
          typeof d.departementId === 'number' ? d.departementId : undefined,
        categorie: texte(d.categorie),
        premierMois: texte(d.premierMois),
      }));
    return this.volontaires.deciderControles(u, { decisions });
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

  /**
   * Nouvelle liste des communautaires d'un département (DG, 12/11/2026) : ceux de la liste restent
   * ou entrent, les autres de ce département sortent. `essai=1` : le rapport, sans rien enregistrer.
   */
  @Roles('CHEF_SERVICE', 'DG')
  @Post('volontaires/remplacer-departement')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  remplacerDepartement(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('departementId') departementId: string,
    @Query('premierMois') premierMois: string,
    @Query('dateSortie') dateSortie: string,
    @Query('essai') essai: string,
    @Body() body: { memes?: string },
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    let memes: string[] = [];
    try {
      const v = JSON.parse(body?.memes || '[]') as unknown;
      if (Array.isArray(v))
        memes = v
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 5000);
    } catch {
      throw new BadRequestException('Confirmations illisibles.');
    }
    return this.volontaires.remplacerDepartement(
      u,
      this.classeur(fichier),
      fichier!.originalname,
      {
        departementId: Number(departementId) || 0,
        premierMois,
        dateSortie,
        memes,
        essai: essai === '1',
      },
    );
  }

  /**
   * Aligner le registre des volontaires sur la bourse payée d'un mois (DG, 12/11/2026 : septembre,
   * puis octobre). `essai=1` : le rapport, sans rien enregistrer.
   */
  @Roles('CHEF_SERVICE', 'DG')
  @Post('volontaires/aligner-bourse')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  alignerSurBourse(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('mois') mois: string,
    @Query('feuille') feuille: string,
    @Query('retraits') retraits: string | undefined,
    @Query('essai') essai: string,
    @Body() body: { memes?: string },
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    let memes: string[] = [];
    try {
      const v = JSON.parse(body?.memes || '[]') as unknown;
      if (Array.isArray(v))
        memes = v
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 5000);
    } catch {
      throw new BadRequestException('Confirmations illisibles.');
    }
    return this.volontaires.alignerSurBourse(
      u,
      this.classeur(fichier),
      fichier!.originalname,
      {
        mois,
        feuille,
        feuilleRetraits: retraits || undefined,
        memes,
        essai: essai === '1',
      },
    );
  }

  /**
   * Aligner le registre des communautaires sur un état de paiement mis à jour (DG, 13/11/2026), une
   * feuille par département lues ensemble. Corps : `feuilles` (noms), `memes` (paires confirmées),
   * `choix` (nouveaux : ajouter ou non, département, cycle). `essai=1` : le rapport seulement.
   */
  @Roles('CHEF_SERVICE', 'DG')
  @Post('volontaires/aligner-communautaires')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  alignerCommunautaires(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('mois') mois: string,
    @Query('retraits') retraits: string | undefined,
    @Query('essai') essai: string,
    @Body() body: { feuilles?: string; memes?: string; choix?: string },
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    const lire = (texte: string | undefined, quoi: string): unknown => {
      try {
        return JSON.parse(texte || 'null') as unknown;
      } catch {
        throw new BadRequestException(`${quoi} illisibles.`);
      }
    };
    const chaines = (v: unknown, max: number) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string').slice(0, max)
        : [];
    const brut = lire(body?.choix, 'Choix des nouveaux');
    const choix: Record<
      string,
      {
        ajouter?: boolean;
        departementId?: number | null;
        categorie?: string | null;
      }
    > = {};
    if (brut && typeof brut === 'object' && !Array.isArray(brut))
      for (const [k, x] of Object.entries(
        brut as Record<string, unknown>,
      ).slice(0, 20000)) {
        if (!x || typeof x !== 'object') continue;
        const c = x as Record<string, unknown>;
        choix[k] = {
          ...(typeof c.ajouter === 'boolean' ? { ajouter: c.ajouter } : {}),
          ...(c.departementId === null ||
          (typeof c.departementId === 'number' &&
            Number.isInteger(c.departementId))
            ? { departementId: c.departementId }
            : {}),
          ...(c.categorie === null || typeof c.categorie === 'string'
            ? { categorie: c.categorie }
            : {}),
        };
      }
    return this.volontaires.alignerCommunautaires(
      u,
      this.classeur(fichier),
      fichier!.originalname,
      {
        mois,
        feuilles: chaines(lire(body?.feuilles, 'Feuilles'), 100),
        feuilleRetraits: retraits || undefined,
        memes: chaines(lire(body?.memes, 'Confirmations'), 5000),
        choix,
        essai: essai === '1',
      },
    );
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
    // Fiches déjà dans le registre : « VIDES » (compléter, par défaut) ou « NON » ; rubriques
    // dont la valeur du fichier remplace celle du registre (« dateNaissance,telephone »)
    @Query('miseAJour') miseAJour: string | undefined,
    @Query('remplacer') remplacer: string | undefined,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (
      type !== 'EN_POSTE' &&
      type !== 'SORTI' &&
      type !== 'NOTE' &&
      type !== 'MISE_A_JOUR'
    )
      throw new BadRequestException(
        'Type de liste : volontaires en poste, sortants, note de service ou mise à jour des fiches.',
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
        miseAJour: miseAJour === 'NON' ? 'NON' : 'VIDES',
        remplacer: (remplacer ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x in CHAMPS_MISE_A_JOUR),
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
  async word(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
    @Query('police') police?: string,
    @Query('orientation') orientation?: string,
  ) {
    const { nom, contenu } = await this.bourse.word(
      id,
      policeDocument(police),
      orientationDocument(orientation),
    );
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
    @Query('police') police?: string,
  ) {
    const { nom, contenu } = await this.bourse.payesDeuxFoisExcel(
      id,
      policeDocument(police),
    );
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

  /** Fiche de prise en charge : département × cycle, montants mensuel, trimestriel, annuel. */
  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id/prise-en-charge')
  async priseEnCharge(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
    @Query('police') police?: string,
  ) {
    const { nom, contenu } = await this.bourse.priseEnChargeExcel(
      id,
      policeDocument(police),
    );
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

  @Roles(...ROLES_TRAITEMENT)
  @Get('bourse/:id/excel')
  async excel(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
    @Query('police') police?: string,
  ) {
    const { nom, contenu } = await this.bourse.excel(
      id,
      policeDocument(police),
    );
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

/** Filtres de la liste lus dans l'adresse (comme l'écran, sans page). */
function filtresListe(q: Record<string, string | undefined>) {
  const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return {
    population: q.population,
    vague:
      q.vague === undefined || q.vague === ''
        ? undefined
        : q.vague === 'aucune'
          ? null
          : Number(q.vague),
    recherche: q.recherche,
    statut: q.statut || undefined,
    departementId: n(q.departement),
    categorie: q.categorie || undefined,
    motif: q.motif || undefined,
  };
}
