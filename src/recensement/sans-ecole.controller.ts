import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { SansEcoleService } from './sans-ecole.service';

/** Agents sans école : lieux écrits à rattacher, lieux écrits qui contredisent l'école. */
@Roles(...ROLES_TRAITEMENT)
@Controller('recensement/sans-ecole')
export class SansEcoleController {
  constructor(private readonly service: SansEcoleService) {}

  @Get()
  analyse() {
    return this.service.analyse();
  }

  /** Exactement les fiches d'un groupe (un lieu écrit, ou un écart lieu écrit ≠ école). */
  @Get('fiches')
  fiches(@Query('sorte') sorte: string, @Query('cle') cle: string) {
    return this.service.fichesDe(
      sorte === 'ecart' ? 'ecart' : 'lieu',
      cle ?? '',
    );
  }

  /** L'Excel des situations à faire vérifier par les DDEPPSA (une, ou toutes). */
  @Get('excel')
  async excel(
    @Query('departement') departement: string | undefined,
    @Query('tout') tout: string | undefined,
    @Res() res: Response,
  ) {
    const dep = Number(departement) || null;
    const { tampon } = await this.service.excel(dep, tout === '1');
    const jour = new Date().toLocaleDateString('fr-FR').replaceAll('/', '-');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Agents sans ecole - a verifier par les DDEPPSA - ${jour}.xlsx"`,
    );
    res.send(tampon);
  }

  /** Rattacher et aligner (DG et administrateurs) : touche des milliers de fiches d'un coup. */
  @Roles('DG')
  @Post('appliquer')
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { rattacher?: unknown; aligner?: unknown },
  ) {
    const rattacher = Array.isArray(corps?.rattacher)
      ? (corps.rattacher as { cle?: unknown; structureId?: unknown }[])
          .filter(
            (x) =>
              typeof x?.cle === 'string' && Number.isInteger(x?.structureId),
          )
          .map((x) => ({
            cle: x.cle as string,
            structureId: x.structureId as number,
          }))
          .slice(0, 20000)
      : [];
    const aligner = Array.isArray(corps?.aligner)
      ? corps.aligner
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 20000)
      : [];
    return this.service.appliquer(u, { rattacher, aligner });
  }
}
