import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { SuiviService } from './suivi.service';

const nombre = (v?: string | number) =>
  v !== undefined && /^\d+$/.test(String(v)) ? Number(v) : undefined;

/** Présence et évaluation du personnel (chefs de structure, DDEPPSA, DGRHAS). */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE')
@Controller()
export class SuiviController {
  constructor(private readonly service: SuiviService) {}

  /* ------------------------------ Présence ------------------------------ */

  @Get('presence/semaine')
  semaine(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('structure') structure: string,
    @Query('date') date?: string,
  ) {
    return this.service.semaine(u, nombre(structure) ?? 0, date);
  }

  @Put('presence/semaine')
  pointer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    body: {
      structureId: number;
      saisies: {
        agentId: number;
        date: string;
        statut: string | null;
        motif?: string | null;
      }[];
    },
  ) {
    return this.service.pointer(
      u,
      nombre(body?.structureId) ?? 0,
      body?.saisies,
    );
  }

  @Post('presence/semaine/valider')
  valider(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() body: { structureId: number; date?: string },
  ) {
    return this.service.valider(u, nombre(body?.structureId) ?? 0, body?.date);
  }

  @Put('presence/horaires/:agentId')
  horaire(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('agentId', ParseIntPipe) agentId: number,
    @Body()
    body: {
      structureId: number;
      jours: Record<string, { debut?: string | null; fin?: string | null }>;
    },
  ) {
    return this.service.horaire(
      u,
      nombre(body?.structureId) ?? 0,
      agentId,
      body?.jours,
    );
  }

  /** Les alertes de présence récentes (panneau « Alertes »). */
  @Get('presence/alertes')
  alertes(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('du') du?: string,
    @Query('au') au?: string,
  ) {
    return this.service.alertesPresence(u, { du, au });
  }

  @Get('presence/rapport')
  rapport(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.service.rapport(u, {
      departement: nombre(q.departement),
      structure: nombre(q.structure),
      du: q.du,
      au: q.au,
    });
  }

  /* ------------------------------ Évaluation ------------------------------ */

  @Get('evaluations')
  campagne(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.service.campagne(u, {
      annee: q.annee,
      structure: nombre(q.structure),
      departement: nombre(q.departement),
      q: q.q,
      etat: q.etat,
      page: nombre(q.page),
    });
  }

  @Get('evaluations/agents/:id')
  evaluationsAgent(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.evaluationsAgent(u, id);
  }

  @Get('evaluations/agents/:id/fiche/:ev')
  ficheEvaluation(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('ev') ev: string,
  ) {
    return this.service.ficheEvaluation(u, id, ev);
  }

  @Post('evaluations/agents/:id')
  evaluer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Parameters<SuiviService['evaluer']>[2],
  ) {
    return this.service.evaluer(u, id, dto);
  }

  @Delete('evaluations/agents/:id/:ev')
  supprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('ev') ev: string,
  ) {
    return this.service.supprimerEvaluation(u, id, ev);
  }
}
