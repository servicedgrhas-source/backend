import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Response } from 'express';
import { Repository } from 'typeorm';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { JournalService } from '../core/core.service';
import { CampagneEnrolement, Enrole } from '../entities';
import { RepartitionService } from './repartition.service';

/**
 * Commission de l'enrôlement (réunion DG du 06/11/2026) : la base définitive arrêtée, puis la
 * répartition des retenus par département sur un brouillon, validée par le DG.
 */
@Controller('enrolement')
export class RepartitionController {
  constructor(
    private readonly service: RepartitionService,
    @InjectRepository(CampagneEnrolement)
    private readonly campagnes: Repository<CampagneEnrolement>,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------- Base définitive ------------------------- */

  /** Où en est la base : arrêtée ou non, et ce qui a été ajouté depuis. */
  @Roles(...ROLES_TRAITEMENT)
  @Get('base-definitive')
  async baseDefinitive(@Query('campagne', ParseIntPipe) campagne: number) {
    const c = await this.campagnes.findOne({ where: { id: campagne } });
    if (!c) throw new NotFoundException('Campagne introuvable');
    const [{ total, aControler, aDecider }] = await this.enroles.query<
      { total: number; aControler: number; aDecider: number }[]
    >(
      `SELECT count(*) FILTER (WHERE etat <> 'NON_RETENU')::int AS total,
              count(*) FILTER (WHERE etat = 'A_CONTROLER')::int AS "aControler",
              count(*) FILTER (WHERE etat = 'CONTROLE')::int AS "aDecider"
         FROM enrole WHERE "campagneId" = $1`,
      [campagne],
    );
    // Comparé dans la base (même fuseau pour les deux dates)
    const [{ ajoutes }] = await this.enroles.query<{ ajoutes: number }[]>(
      `SELECT count(e.*)::int AS ajoutes FROM enrole e JOIN campagne_enrolement c ON c.id = e."campagneId"
        WHERE e."campagneId" = $1 AND c."baseArreteeLe" IS NOT NULL AND e."creeLe" > c."baseArreteeLe"`,
      [campagne],
    );
    return {
      arreteeLe: c.baseArreteeLe,
      arreteePar: c.baseArreteePar,
      ajoutesDepuis: ajoutes,
      total,
      aControler,
      aDecider,
    };
  }

  /** Arrêter (ou rouvrir) la base définitive : réservé au DG. */
  @Roles('DG')
  @Post('base-definitive')
  async arreterBase(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { campagne: number; arreter: boolean },
  ) {
    const c = await this.campagnes.findOne({
      where: { id: Number(corps?.campagne) },
    });
    if (!c) throw new NotFoundException('Campagne introuvable');
    const arreter = corps.arreter !== false;
    await this.campagnes.update(c.id, {
      baseArreteeLe: arreter ? new Date() : null,
      baseArreteePar: arreter ? u.nom : null,
    });
    await this.journal.log(
      u,
      arreter ? 'BASE_ENROLEMENT_ARRETEE' : 'BASE_ENROLEMENT_ROUVERTE',
      'campagne_enrolement',
      String(c.id),
    );
    return { ok: true };
  }

  /* --------------------------- Répartition --------------------------- */

  @Roles(...ROLES_TRAITEMENT)
  @Get('repartition')
  grille(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Query('critere') critere?: string,
  ) {
    return this.service.grille(campagne, critere);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('repartition/case')
  candidatsCase(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Query('departement', ParseIntPipe) departement: number,
    @Query('valeur') valeur: string,
    @Query('tous') tous?: string,
  ) {
    return this.service.candidatsCase(
      campagne,
      departement,
      valeur ?? '',
      tous === '1',
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put('repartition/quota')
  quota(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    corps: {
      campagne: number;
      departement: number;
      valeur: string;
      places: number;
    },
  ) {
    return this.service.fixerQuota(
      u,
      Number(corps?.campagne),
      Number(corps?.departement),
      String(corps?.valeur ?? ''),
      Number(corps?.places),
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('repartition/placer')
  placer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    corps: { campagne: number; ids: string[]; departement: number | null },
  ) {
    if (!Array.isArray(corps?.ids))
      throw new BadRequestException('Aucun candidat choisi.');
    return this.service.placer(
      u,
      Number(corps.campagne),
      corps.ids.map(String),
      corps.departement ? Number(corps.departement) : null,
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('repartition/proposer')
  proposer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { campagne: number },
  ) {
    return this.service.proposer(u, Number(corps?.campagne));
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('repartition/vider')
  vider(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { campagne: number },
  ) {
    return this.service.vider(u, Number(corps?.campagne));
  }

  @Roles('DG')
  @Post('repartition/valider')
  valider(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { campagne: number },
  ) {
    return this.service.valider(u, Number(corps?.campagne));
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('repartition/excel')
  async excel(
    @Query('campagne', ParseIntPipe) campagne: number,
    @Res() res: Response,
  ) {
    const { nom, contenu } = await this.service.excel(campagne);
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
}
