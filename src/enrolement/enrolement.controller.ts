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
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import {
  Roles,
  ROLES_CONTROLE,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import {
  CYCLES_ENROLEMENT,
  DIPLOMES_ENROLEMENT,
  EnrolementService,
  SPECIALITES_ENROLEMENT,
  type EnroleDto,
} from './enrolement.service';

@Controller('enrolement')
export class EnrolementController {
  constructor(private readonly service: EnrolementService) {}

  @Get('diplomes')
  diplomes() {
    return Object.entries(DIPLOMES_ENROLEMENT).map(([code, d]) => ({
      code,
      ...d,
    }));
  }

  /** Cycles, et spécialités proposées dans la saisie (liste déroulante). */
  @Get('referentiel')
  referentiel() {
    return { cycles: CYCLES_ENROLEMENT, specialites: SPECIALITES_ENROLEMENT };
  }

  /* ------------------------------ Campagnes ------------------------------ */

  @Roles(...ROLES_TRAITEMENT)
  @Get('campagnes')
  campagnes() {
    return this.service.listeCampagnes();
  }

  @Roles('DG')
  @Post('campagnes')
  ouvrir(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    dto: {
      annee: number;
      anneeScolaire?: string;
      quota?: number;
      enveloppe?: number;
      placesParCycle?: Record<string, number>;
      montantsParCycle?: Record<string, number>;
      observation?: string | null;
    },
  ) {
    return this.service.enregistrerCampagne(u, null, dto);
  }

  @Roles('DG')
  @Put('campagnes/:id')
  modifierCampagne(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    dto: {
      annee: number;
      anneeScolaire?: string;
      quota?: number;
      enveloppe?: number;
      placesParCycle?: Record<string, number>;
      montantsParCycle?: Record<string, number>;
      ouverte?: boolean;
      observation?: string | null;
    },
  ) {
    return this.service.enregistrerCampagne(u, id, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('campagnes/:id/compteurs')
  compteurs(@Param('id', ParseIntPipe) id: number) {
    return this.service.compteurs(id);
  }

  /* ------------------------------ Commission ------------------------------ */

  @Roles(...ROLES_TRAITEMENT)
  @Get('membres')
  membres(@Query('campagne', ParseIntPipe) campagne: number) {
    return this.service.listeMembres(campagne);
  }

  @Roles('DG')
  @Post('membres')
  ajouterMembre(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    dto: {
      campagneId: number;
      nom: string;
      fonction?: string | null;
      places: number;
    },
  ) {
    return this.service.enregistrerMembre(u, null, dto);
  }

  @Roles('DG')
  @Put('membres/:id')
  modifierMembre(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body()
    dto: {
      campagneId: number;
      nom: string;
      fonction?: string | null;
      places: number;
    },
  ) {
    return this.service.enregistrerMembre(u, id, dto);
  }

  @Roles('DG')
  @Delete('membres/:id')
  retirerMembre(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.service.supprimerMembre(u, id);
  }

  /* ------------------------------- Dossiers ------------------------------- */

  @Roles(...ROLES_TRAITEMENT)
  @Get('dossiers')
  dossiers(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Query('etat') etat?: string,
    @Query('recherche') recherche?: string,
    @Query('diplome') diplome?: string,
    @Query('departement') departement?: string,
  ) {
    return this.service.liste({
      campagneId: campagne,
      etat: etat || undefined,
      recherche,
      diplome: diplome || undefined,
      departementId: Number(departement) || undefined,
    });
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('dossiers/:id/fiche')
  fiche(@Param('id') id: string) {
    return this.service.fiche(id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('doublons')
  doublons(
    @Query('nom') nom: string,
    @Query('naissance') naissance?: string,
    @Query('exclure') exclure?: string,
  ) {
    return this.service.doublons(
      nom ?? '',
      naissance || null,
      exclure || undefined,
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('dossiers')
  creer(@Utilisateur() u: UtilisateurConnecte, @Body() dto: EnroleDto) {
    return this.service.creer(u, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put('dossiers/:id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: EnroleDto,
  ) {
    return this.service.modifier(u, id, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put('dossiers/:id/placement')
  placer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body()
    dto: { departementRetenuId?: number | null; etablissement?: string | null },
  ) {
    return this.service.placer(u, id, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Delete('dossiers/:id')
  supprimer(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.supprimer(u, id);
  }

  @Roles(...ROLES_CONTROLE)
  @Post('controler')
  controler(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() body: { ids: string[]; conforme: boolean; remarque?: string },
  ) {
    return this.service.controler(
      u,
      body?.ids ?? [],
      !!body?.conforme,
      body?.remarque,
    );
  }

  /** Dossiers qui ressemblent à un recruté, un volontaire ou un enrôlé d'avant (06/11/2026). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('deja-connus')
  dejaConnus(@Query('campagne', ParseIntPipe) campagne: number) {
    return this.service.dejaConnus(campagne);
  }

  /** Envoyer des dossiers dans une autre note (lycée, collège, primaire, préscolaire) ou à la règle. */
  @Roles(...ROLES_TRAITEMENT)
  @Post('dossiers/note')
  changerNote(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    body: { ids: string[]; cible: string | null; specialite?: string | null },
  ) {
    return this.service.changerNote(
      u,
      Array.isArray(body?.ids) ? body.ids.map(String) : [],
      body?.cible ? String(body.cible) : null,
      body?.specialite ? String(body.specialite).slice(0, 120) : null,
    );
  }

  /** Spécialité de dossiers choisis ; vide : la règle (préscolaire, primaire). */
  @Roles(...ROLES_TRAITEMENT)
  @Post('dossiers/specialite')
  ecrireSpecialite(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() body: { ids: string[]; specialite?: string | null },
  ) {
    return this.service.ecrireSpecialite(
      u,
      Array.isArray(body?.ids) ? body.ids.map(String) : [],
      body?.specialite ? String(body.specialite).slice(0, 120) : null,
    );
  }

  /** Spécialités proposées (liste de référence et celles déjà écrites dans la campagne). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('specialites')
  specialitesConnues(@Query('campagne', ParseIntPipe) campagne: number) {
    return this.service.specialitesConnues(campagne);
  }

  @Roles(...ROLES_CONTROLE)
  @Post('deja-connus')
  trancherDejaConnu(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    body: { ids: string[]; decision: 'ECARTER' | 'DIFFERENT'; motif?: string },
  ) {
    if (!['ECARTER', 'DIFFERENT'].includes(body?.decision))
      throw new BadRequestException('Décision inconnue.');
    return this.service.trancherDejaConnu(
      u,
      Array.isArray(body?.ids) ? body.ids.map(String) : [],
      body.decision,
      body.motif,
    );
  }

  @Roles('DG')
  @Post('decider')
  decider(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    body: { ids: string[]; decision: 'RETENU' | 'NON_RETENU'; motif?: string },
  ) {
    if (body?.decision !== 'RETENU' && body?.decision !== 'NON_RETENU')
      throw new BadRequestException(
        'Décision attendue : retenu ou non retenu.',
      );
    return this.service.decider(u, body.ids ?? [], body.decision, body.motif);
  }

  @Roles('DG')
  @Post('dossiers/:id/annuler-decision')
  annulerDecision(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.service.annulerDecision(u, id);
  }

  @Roles('CHEF_SERVICE', 'DG')
  @Post('import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 40 * 1024 * 1024 } }),
  )
  importer(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('campagne', ParseIntPipe) campagne: number,
    @Query('essai') essai: string,
    @UploadedFile() fichier?: Express.Multer.File,
    // Feuilles choisies et décisions prises sur l'essai (06/11/2026), en champs du formulaire
    @Body() corps?: { feuilles?: string; decisions?: string },
  ) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException(
        'Choisissez la liste Excel (.xlsx) des dossiers déposés.',
      );
    const lire = <T>(v: string | undefined, defaut: T): T => {
      try {
        return v ? (JSON.parse(v) as T) : defaut;
      } catch {
        throw new BadRequestException('Décisions de l’import illisibles.');
      }
    };
    const feuilles = lire<string[] | null>(corps?.feuilles, null);
    const decisions = lire<Record<string, string>>(corps?.decisions, {});
    return this.service.importer(
      u,
      campagne,
      fichier.buffer,
      essai === '1',
      Array.isArray(feuilles) ? feuilles.map(String) : null,
      decisions && typeof decisions === 'object' ? decisions : {},
    );
  }

  /** Statistiques de l'enrôlement : cycle et diplôme, spécialités du collège et du lycée. */
  @Roles(...ROLES_TRAITEMENT)
  @Get('statistiques')
  statistiques(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Query('parmi') parmi?: string,
  ) {
    return this.service.statistiques(
      campagne,
      parmi === 'reste' ? 'reste' : 'tous',
    );
  }

  /** Les mêmes statistiques en Excel (une feuille). */
  @Roles(...ROLES_TRAITEMENT)
  @Get('statistiques/excel')
  async statistiquesExcel(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Query('parmi') parmi: string | undefined,
    @Res() res: Response,
  ) {
    const s = await this.service.statistiques(
      campagne,
      parmi === 'reste' ? 'reste' : 'tous',
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statistiques');
    const titre = (t: string) => {
      ws.addRow([]);
      ws.addRow([t]).font = { bold: true, size: 12 };
    };
    const entete = (cols: string[]) => {
      const r = ws.addRow(cols);
      r.font = { bold: true };
      r.eachCell((c) => {
        c.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE6F0EA' },
        };
        c.border = { bottom: { style: 'thin' } };
      });
    };
    ws.addRow([
      `ENRÔLEMENT ${s.campagne.annee} (${s.campagne.anneeScolaire}) — STATISTIQUES`,
    ]).font = { bold: true, size: 13 };
    titre('1. Par cycle et diplôme');
    entete([
      'Cycle',
      'Diplôme',
      'Base générale',
      'Affectés',
      'Non retenus',
      'Reste à affecter',
    ]);
    for (const l of s.parDiplome)
      ws.addRow([
        l.cycle,
        l.diplome,
        l.total,
        l.affectes,
        l.nonRetenus,
        l.reste,
      ]);
    ws.addRow([
      'Total',
      '',
      s.total.total,
      s.total.affectes,
      s.total.nonRetenus,
      s.total.reste,
    ]).font = { bold: true };
    const parmiTexte =
      s.parmi === 'reste' ? 'reste à affecter' : 'tous les dossiers';
    for (const [t, b] of [
      [`2. Spécialités du collège (${parmiTexte})`, s.college],
      [`3. Spécialités du lycée (${parmiTexte})`, s.lycee],
    ] as const) {
      titre(t);
      entete(['Spécialité', ...b.colonnes, 'Cumul']);
      for (const l of b.lignes)
        ws.addRow([l.specialite, ...l.valeurs, l.cumul]);
      ws.addRow([
        'Total',
        ...b.colonnes.map((_, i) =>
          b.lignes.reduce((a, l) => a + l.valeurs[i], 0),
        ),
        b.lignes.reduce((a, l) => a + l.cumul, 0),
      ]).font = { bold: true };
    }
    // Face à l'enveloppe (DG, 06/11/2026)
    titre(`4. Face à l’enveloppe de bourse (${s.budget.mois} mois)`);
    entete([
      'Cycle',
      'Dossiers',
      'Places prévues',
      'Bourse par mois',
      'Coût si tous',
    ]);
    for (const l of s.budget.parCycle)
      ws.addRow([l.cycle, l.dossiers, l.places || '', l.bourse, l.coutTous]);
    ws.addRow(['Total', '', '', '', s.budget.coutTous]).font = { bold: true };
    ws.addRow(['Enveloppe', '', '', '', s.budget.enveloppe || 'non fixée']);
    if (s.budget.ecart !== null)
      ws.addRow([
        s.budget.ecart >= 0 ? 'Reste' : 'Dépassement',
        '',
        '',
        '',
        Math.abs(s.budget.ecart),
      ]).font = { bold: true };
    ws.columns = [
      { width: 24 },
      { width: 26 },
      { width: 16 },
      { width: 12 },
      { width: 13 },
      { width: 17 },
    ];
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`Statistiques enrôlement ${s.campagne.annee}.xlsx`)}`,
    );
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }

  /** Base des enrôlés (ou une étape) en Excel. */
  @Roles(...ROLES_TRAITEMENT)
  @Get('dossiers/excel')
  async excel(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Query('etat') etat: string | undefined,
    @Res() res: Response,
  ) {
    const c = await this.service.campagne(campagne);
    const liste = await this.service.liste({
      campagneId: campagne,
      etat: etat || undefined,
    });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Enrôlés');
    ws.addRow([
      `ENROLEMENT ${c.annee} (${c.anneeScolaire})${etat ? ` — ${etat}` : ''}`,
    ]).font = { bold: true };
    ws.addRow([
      'N°',
      'Noms et prénoms',
      'Date de nais.',
      'Lieu de nais.',
      'Diplôme',
      'Promotion',
      'Cycle',
      'Spécialité',
      'Départements souhaités',
      'Département retenu',
      'Établissement',
      'Téléphone',
      'Origine',
      'Membre de la commission',
      'Étape',
    ]).font = { bold: true };
    liste.forEach((e, i) =>
      ws.addRow([
        i + 1,
        e.nomComplet,
        e.dateNaissance,
        e.lieuNaissance,
        e.diplomeLibelle,
        e.promotion,
        e.cycle,
        e.specialite,
        e.departementsSouhaitesNoms.join(', '),
        e.departementRetenu,
        e.etablissement,
        e.telephone,
        e.origineBrute,
        e.membre,
        e.etat,
      ]),
    );
    ws.columns.forEach((col) => (col.width = 18));
    ws.getColumn(2).width = 36;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Enrolement ${c.annee}.xlsx"`,
    );
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
}
