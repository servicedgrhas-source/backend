import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles, ROLES_TRAITEMENT } from '../auth/auth';
import {
  EffectifsEcolesService,
  type FiltresEcoles,
} from './effectifs-ecoles.service';

/**
 * Effectifs par école (Banque mondiale, 16/11/2026) : volontaires, communautaires, contractuels et
 * fonctionnaires de chaque école, par DEPPSA ; écoles sous le seuil de fonctionnaires. Lecture seule.
 */
@Controller('enrolement/effectifs-ecoles')
export class EffectifsEcolesController {
  constructor(private readonly ecoles: EffectifsEcolesService) {}

  private filtres(q: Record<string, string | undefined>): FiltresEcoles {
    const seuil = Number(q.seuil);
    return {
      cycle:
        q.cycle === undefined
          ? 'PRESCOLAIRE'
          : /^(PRESCOLAIRE|PRIMAIRE|COLLEGE|LYCEE|ALPHABETISATION|SANS)$/.test(
                q.cycle,
              )
            ? q.cycle
            : undefined,
      departementId:
        q.departementId && /^\d+$/.test(q.departementId)
          ? Number(q.departementId)
          : undefined,
      seuil: Number.isInteger(seuil) && seuil >= 1 && seuil <= 50 ? seuil : 3,
      sousSeuil: q.sousSeuil === '1',
      recherche: q.recherche?.slice(0, 100) || undefined,
    };
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get()
  lire(@Query() q: Record<string, string | undefined>) {
    return this.ecoles.effectifs(
      this.filtres(q),
      Math.max(1, Number(q.page) || 1),
      Math.min(200, Number(q.taille) || 50),
    );
  }

  @Roles(...ROLES_TRAITEMENT)
  @Get('excel')
  async excel(
    @Query() q: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const { nom, contenu } = await this.ecoles.excel(this.filtres(q));
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
