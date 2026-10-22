import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from './auth/auth';

type Ligne = Record<string, string | number | null>;

@Controller()
export class DashboardController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Public()
  @Get('sante')
  sante() {
    return { ok: true };
  }

  /** Travail en attente par rubrique : compteurs du menu et des pages d'accueil. */
  @Get('menu/compteurs')
  async compteurs() {
    const [c] = await this.db.query<Record<string, number>[]>(`
      SELECT
        (SELECT count(*) FROM agent WHERE "origineFiche" = 'SAISIE' AND feuille = 'MEPPSA'
           AND "etatFiche" = 'A_CONTROLER'
           AND ("contentieuxAge" IS NULL OR "contentieuxAge" = 'APPROUVE'))::int AS "aControler",
        (SELECT count(*) FROM agent WHERE "origineFiche" = 'SAISIE' AND feuille = 'MEPPSA'
           AND "etatFiche" = 'CONTROLEE'
           AND ("contentieuxAge" IS NULL OR "contentieuxAge" = 'APPROUVE'))::int AS "aValider",
        (SELECT count(*) FROM agent WHERE "contentieuxAge" = 'EN_ATTENTE')::int AS contentieux,
        (SELECT count(*) FROM agent WHERE "origineFiche" = 'SAISIE' AND feuille = 'MEPPSA'
           AND "etatFiche" = 'VALIDEE' AND "transmissionNumero" IS NULL
           AND ("contentieuxAge" IS NULL OR "contentieuxAge" = 'APPROUVE'))::int AS "pretesFP",
        (SELECT count(*) FROM agent WHERE "transmissionNumero" IS NOT NULL
           AND "lotPublicationId" IS NULL)::int AS "textesAttendus",
        (SELECT count(*) FROM lot_publication l WHERE
           (EXISTS (SELECT 1 FROM agent a WHERE a."lotPublicationId" = l.id AND a."typeTexte" = 'ARRETE') AND l."dateSignatureArretes" IS NULL)
           OR (EXISTS (SELECT 1 FROM agent a WHERE a."lotPublicationId" = l.id AND a."typeTexte" = 'DECRET') AND l."dateSignatureDecrets" IS NULL))::int AS "lotsSansDate",
        (SELECT count(*) FROM affectation WHERE statut = 'A_TRAITER')::int AS "pasAffectes",
        (SELECT count(*) FROM recommandation WHERE statut = 'EN_ATTENTE')::int AS "recommandations",
        (SELECT count(*) FROM demande_mutation WHERE NOT retiree AND "instructionMinistre" IS NULL)::int AS "mutationsEnCours",
        (SELECT count(*) FROM note_service WHERE module = 'AFFECTATION' AND statut = 'BROUILLON')::int AS "notesAffASoumettre",
        (SELECT count(*) FROM note_service WHERE module = 'AFFECTATION' AND statut = 'SOUMISE')::int AS "notesAffSoumises",
        (SELECT count(*) FROM note_service WHERE module = 'MUTATION' AND statut = 'BROUILLON')::int AS "notesMutASoumettre",
        (SELECT count(*) FROM note_service WHERE module = 'MUTATION' AND statut = 'SOUMISE')::int AS "notesMutSoumises"`);
    return c;
  }

  @Get('tableau-de-bord')
  async tableau() {
    const [agents] = await this.db.query<Ligne[]>(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE "lotPublicationId" IS NOT NULL)::int AS "textesRecus",
        count(*) FILTER (WHERE jsonb_array_length(anomalies) > 0)::int AS anomalies
      FROM agent`);
    const affectations = await this.db.query<Ligne[]>(
      `SELECT statut, count(*)::int AS n FROM affectation GROUP BY 1`,
    );
    const notes = await this.db.query<Ligne[]>(
      `SELECT module, statut, count(*)::int AS n FROM note_service GROUP BY 1, 2`,
    );
    const [recos] = await this.db.query<Ligne[]>(
      `SELECT count(*) FILTER (WHERE statut = 'EN_ATTENTE')::int AS "enAttente", count(*)::int AS total FROM recommandation`,
    );
    const [mutations] = await this.db.query<Ligne[]>(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE NOT retiree AND "instructionMinistre" = 'ACCORDEE')::int AS accordees,
        count(*) FILTER (WHERE NOT retiree AND "instructionMinistre" = 'REFUSEE')::int AS refusees,
        count(*) FILTER (WHERE NOT retiree AND "instructionMinistre" IS NULL)::int AS "enCours"
      FROM demande_mutation`);
    // Textes reçus par paquet (un envoi de la FP)
    const lots = await this.db.query<Ligne[]>(`
      SELECT p.numero, p."dateReception"::text AS "dateReception", count(a.id)::int AS agents,
        count(f.id) FILTER (WHERE f.statut = 'AFFECTE')::int AS affectes,
        count(DISTINCT l.id)::int AS lots
      FROM paquet_reception p JOIN lot_publication l ON l."paquetId" = p.id
      LEFT JOIN agent a ON a."lotPublicationId" = l.id
      LEFT JOIN affectation f ON f."agentId" = a.id
      GROUP BY p.id ORDER BY p."dateReception" NULLS LAST, p.numero`);
    return {
      agents,
      affectations,
      notes,
      recommandations: recos,
      mutations,
      lots,
    };
  }
}
