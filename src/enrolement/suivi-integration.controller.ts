import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles, ROLES_TRAITEMENT } from '../auth/auth';
import {
  type FiltresSuivi,
  SuiviIntegrationService,
} from './suivi-integration.service';

/**
 * Suivi de l'intégration des enseignants volontaires et communautaires (Banque mondiale,
 * 16/11/2026) : synthèse, liste nominative, Excel et Word. Lecture seule.
 */
@Controller('enrolement/suivi-integration')
export class SuiviIntegrationController {
  constructor(private readonly suivi: SuiviIntegrationService) {}

  private filtres(q: Record<string, string | undefined>): FiltresSuivi {
    const nombre = (x?: string) =>
      x && /^\d+$/.test(x) ? Number(x) : undefined;
    return {
      population:
        q.population === 'VOLONTAIRE' || q.population === 'COMMUNAUTAIRE'
          ? q.population
          : undefined,
      departementId: nombre(q.departementId),
      categorie: q.categorie || undefined,
      vague: nombre(q.vague),
      annee: q.annee && /^\d{4}$/.test(q.annee) ? q.annee : undefined,
      situation: q.situation || undefined,
      recherche: q.recherche?.slice(0, 100) || undefined,
      aRegler: q.aRegler === '1',
    };
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get()
  lire(@Query() q: Record<string, string | undefined>) {
    return this.suivi.suivi(
      this.filtres(q),
      Number(q.page) || 1,
      Math.min(200, Number(q.taille) || 50),
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('excel')
  async excel(
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const { nom, contenu } = await this.suivi.excel(this.filtres(q));
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
  @Get('word')
  async word(
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const { nom, contenu } = await this.suivi.word(this.filtres(q));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(nom)}`,
    );
    res.send(contenu);
  }
}
