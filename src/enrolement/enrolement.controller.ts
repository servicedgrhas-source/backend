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
  ) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException(
        'Choisissez la liste Excel (.xlsx) des dossiers déposés.',
      );
    return this.service.importer(u, campagne, fichier.buffer, essai === '1');
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
