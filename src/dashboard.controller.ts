import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public, Roles, ROLES_TRAITEMENT } from './auth/auth';
import { ParametresService } from './core/core.service';

type Ligne = Record<string, string | number | null>;

// IS NOT DISTINCT FROM : vrai ou faux, jamais NULL (sinon NOT (…) perd les demandes sans décision)
const ACCORDEE = `(decision IS NOT DISTINCT FROM 'ACCORDEE' OR (decision IS NULL AND "instructionMinistre" IS NOT DISTINCT FROM 'ACCORDEE'))`;
const REFUSEE = `(decision IS NOT DISTINCT FROM 'REJETEE' OR (decision IS NULL AND "instructionMinistre" IS NOT DISTINCT FROM 'REFUSEE'))`;

@Controller()
export class DashboardController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly params: ParametresService,
  ) {}

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

  /**
   * Tableau de bord de la DGRHAS (chiffres de tout le pays). Les comptes du circuit
   * (DDEPPSA, cabinet, secrétariat) ont le leur : GET circuit/tableau.
   */
  @Roles(...ROLES_TRAITEMENT)
  @Get('tableau-de-bord')
  async tableau() {
    // Tout le pays en un seul aller-retour (sous-requêtes agrégées) ; les paquets à part, en parallèle
    const [[t], lots] = await Promise.all([
      this.db.query<Record<string, unknown>[]>(
        `SELECT
          (SELECT json_build_object(
             'total', count(*),
             'textesRecus', count(*) FILTER (WHERE "lotPublicationId" IS NOT NULL),
             'anomalies', count(*) FILTER (WHERE jsonb_array_length(anomalies) > 0)) FROM agent) AS agents,
          (SELECT coalesce(json_agg(x), '[]') FROM (SELECT statut, count(*)::int AS n FROM affectation GROUP BY 1) x) AS affectations,
          (SELECT coalesce(json_agg(x), '[]') FROM (SELECT module, statut, count(*)::int AS n FROM note_service GROUP BY 1, 2) x) AS notes,
          (SELECT json_build_object(
             'enAttente', count(*) FILTER (WHERE statut = 'EN_ATTENTE'),
             'avisDirecteur', count(*) FILTER (WHERE statut = 'EN_ATTENTE' AND etape = 'AVIS_DIRECTEUR'),
             'decisionDg', count(*) FILTER (WHERE statut = 'EN_ATTENTE' AND etape = 'DECISION_DG'),
             'total', count(*)) FROM recommandation) AS recommandations,
          (SELECT json_build_object(
             'total', count(*) FILTER (WHERE mutation),
             'accordees', count(*) FILTER (WHERE mutation AND accordee),
             'refusees', count(*) FILTER (WHERE mutation AND refusee),
             'enInstance', count(*) FILTER (WHERE mutation AND decision = 'EN_INSTANCE'),
             'enCours', count(*) FILTER (WHERE mutation AND NOT accordee AND NOT refusee AND decision IS DISTINCT FROM 'EN_INSTANCE'),
             'anomalies', count(*) FILTER (WHERE mutation AND NOT accordee AND NOT refusee AND jsonb_array_length(anomalies) > 0),
             'autres', count(*) FILTER (WHERE NOT mutation),
             'autresEnCours', count(*) FILTER (WHERE NOT mutation AND "etapeCourante" IS NOT NULL),
             'enRetard', count(*) FILTER (WHERE "etapeCourante" IS NOT NULL
                AND (circuit -> "etapeCourante" ->> 'arriveeLe')::timestamptz < now() - interval '7 days'))
           FROM (SELECT d.decision, d.anomalies, d.circuit, d."etapeCourante",
                   ${ACCORDEE.replaceAll('decision', 'd.decision').replaceAll('"instructionMinistre"', 'd."instructionMinistre"')} AS accordee,
                   ${REFUSEE.replaceAll('decision', 'd.decision').replaceAll('"instructionMinistre"', 'd."instructionMinistre"')} AS refusee,
                   (d."typePrestation" IS NULL OR d."typePrestation" ~ '^(MUTATION|PERMUTATION)' OR t."motifMutation" IS NOT NULL) AS mutation
                 FROM demande_mutation d LEFT JOIN type_prestation t ON t.code = d."typePrestation"
                 WHERE NOT d.retiree) m) AS demandes,
          (SELECT json_build_object(
             'total', count(*) FILTER (WHERE admise),
             'complets', count(*) FILTER (WHERE admise AND complet),
             'incomplets', count(*) FILTER (WHERE admise AND NOT complet),
             'aControler', count(*) FILTER (WHERE contentieux->>'etat' = 'EN_COURS'),
             'aDecider', count(*) FILTER (WHERE contentieux->>'etat' = 'CONTROLE'),
             'sansStructure', count(*) FILTER (WHERE admise AND "structureId" IS NULL),
             'doublons', (SELECT count(*) FROM (SELECT 1 FROM agent_recense WHERE "dateNaissance" IS NOT NULL
                 GROUP BY "nomNormalise", "dateNaissance" HAVING count(*) > 1) x),
             'parStatut', (SELECT coalesce(json_object_agg(statut, n), '{}') FROM (
                SELECT statut, count(*)::int AS n FROM agent_recense
                 WHERE coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME' GROUP BY 1) s))
           FROM (SELECT complet, contentieux, "structureId",
                   coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME' AS admise FROM agent_recense) a) AS personnel,
          (SELECT json_build_object(
             'volontaires', count(*) FILTER (WHERE population = 'VOLONTAIRE' AND statut = 'EN_POSTE'),
             'communautaires', count(*) FILTER (WHERE population = 'COMMUNAUTAIRE' AND statut = 'EN_POSTE'),
             'sansCategorie', count(*) FILTER (WHERE statut = 'EN_POSTE' AND categorie IS NULL),
             'sansDepartement', count(*) FILTER (WHERE statut = 'EN_POSTE' AND "departementId" IS NULL)) FROM volontaire) AS registre,
          -- Structures à compléter (Administration › Organigramme) : cycle, inspection, supérieure
          (SELECT json_build_object(
             'sansCycle', count(*) FILTER (WHERE type IN ('INSPECTION', 'ETABLISSEMENT') AND cycle IS NULL),
             'ecolesSansInspection', count(*) FILTER (WHERE type = 'ETABLISSEMENT' AND "parentId" IS NULL),
             'sansSuperieure', count(*) FILTER (WHERE "parentId" IS NULL AND type IN
               ('INSPECTION', 'DIRECTION_CENTRALE', 'SERVICE', 'BUREAU', 'DIRECTION_DGRHAS', 'SERVICE_DGRHAS', 'BUREAU_DGRHAS')))
             FROM structure WHERE actif) AS structures,
          (SELECT coalesce(json_agg(x), '[]') FROM (
             SELECT population, statut, effectif, total FROM etat_bourse WHERE mois = to_char(now(), 'YYYY-MM')) x) AS "paiementsDuMois",
          (SELECT json_build_object('ecoles', count(DISTINCT "structureId"), 'classes', count(*)) FROM classe
             WHERE "anneeScolaire" = $1) AS ecoles`,
        [this.params.get('ANNEE_SCOLAIRE')],
      ),
      // Textes reçus : par paquet (anciens lots rangés par date de réception), puis par lot de
      // publication de la base (« Arrêtés — lot VIII », DG 30/10/2026) : décrets puis arrêtés, les
      // listes du tableau de bord partant de la fin (arrêtés lot VIII en tête)
      this.db.query<Ligne[]>(`
        SELECT * FROM (
          SELECT 'P' || p.id AS cle, p.numero, p."dateReception"::text AS "dateReception",
            NULL::text AS "typeTexte", NULL::int AS "numeroFichier", count(a.id)::int AS agents,
            count(f.id) FILTER (WHERE f.statut = 'AFFECTE')::int AS affectes,
            count(DISTINCT l.id)::int AS lots, 0 AS groupe, p."dateReception" AS d1, 0 AS d2
          FROM paquet_reception p JOIN lot_publication l ON l."paquetId" = p.id
          LEFT JOIN agent a ON a."lotPublicationId" = l.id
          LEFT JOIN affectation f ON f."agentId" = a.id
          GROUP BY p.id
          UNION ALL
          SELECT 'L' || l.id, l.numero, NULL, l."typeTexte", l."numeroFichier", count(a.id)::int,
            count(f.id) FILTER (WHERE f.statut = 'AFFECTE')::int, 1,
            CASE l."typeTexte" WHEN 'DECRET' THEN 1 ELSE 2 END, NULL, l."numeroFichier"
          FROM lot_publication l
          LEFT JOIN agent a ON a."lotPublicationId" = l.id
          LEFT JOIN affectation f ON f."agentId" = a.id
          WHERE l."numeroFichier" IS NOT NULL
          GROUP BY l.id
        ) x ORDER BY groupe, d1 NULLS LAST, d2, numero`),
    ]);
    const d = t.demandes as Record<string, number>;
    return {
      ...t,
      // Noms d'avant, gardés pour les écrans qui les lisent
      mutations: {
        total: d.total,
        accordees: d.accordees,
        refusees: d.refusees,
        enCours: d.enCours,
        enInstance: d.enInstance,
      },
      anneeScolaire: this.params.get('ANNEE_SCOLAIRE'),
      lots,
    };
  }
}
