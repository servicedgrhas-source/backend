import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Le terrain, pour de vrai (22/11/2026) :
 * - constat_agent : ce que l'équipe a constaté pour chaque agent, par recensement et par école
 *   (présent, absent avec son motif, parti, inconnu, décédé…) : le bilan dit qui n'a jamais été vu ;
 * - constat_ecole : l'école elle-même (fonctionne, fermée, introuvable, autre nom, responsable
 *   trouvé), « école terminée » par l'équipe, et les écoles absentes de la liste signalées ;
 * - envoi_terrain : un envoi rejoué (réseau coupé avant la réponse) n'est pas appliqué deux fois ;
 * - cle_terrain : la clé de secours d'un appareil (code oublié : le mot de passe rouvre les données).
 */
export class ConstatsRecensement1793790000000 implements MigrationInterface {
  name = 'ConstatsRecensement1793790000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS "constat_agent" (
      "id" SERIAL PRIMARY KEY,
      "campagneId" integer NOT NULL DEFAULT 0,
      "agentId" integer NOT NULL,
      "structureId" integer NOT NULL,
      "presence" character varying NOT NULL,
      "observation" text,
      "par" character varying,
      "utilisateurId" uuid,
      "le" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_constat_agent_unique" ON "constat_agent" ("campagneId", "agentId", "structureId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_constat_agent_structure" ON "constat_agent" ("structureId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_constat_agent_agent" ON "constat_agent" ("agentId")`,
    );
    await q.query(`CREATE TABLE IF NOT EXISTS "constat_ecole" (
      "id" SERIAL PRIMARY KEY,
      "campagneId" integer NOT NULL DEFAULT 0,
      "structureId" integer,
      "etat" character varying,
      "nomSurPlace" character varying,
      "responsable" character varying,
      "telephone" character varying,
      "observation" text,
      "proposition" jsonb,
      "termineeLe" TIMESTAMP WITH TIME ZONE,
      "par" character varying,
      "utilisateurId" uuid,
      "le" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "traite" boolean NOT NULL DEFAULT false,
      "traitePar" character varying,
      "traiteLe" TIMESTAMP WITH TIME ZONE
    )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_constat_ecole_unique" ON "constat_ecole" ("campagneId", "structureId") WHERE "structureId" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_constat_ecole_traite" ON "constat_ecole" ("traite")`,
    );
    await q.query(`CREATE TABLE IF NOT EXISTS "envoi_terrain" (
      "cle" character varying(64) PRIMARY KEY,
      "resultat" jsonb NOT NULL,
      "le" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE TABLE IF NOT EXISTS "cle_terrain" (
      "utilisateurId" uuid NOT NULL,
      "appareil" character varying(64) NOT NULL,
      "cle" character varying NOT NULL,
      "creeLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      PRIMARY KEY ("utilisateurId", "appareil")
    )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "cle_terrain"`);
    await q.query(`DROP TABLE IF EXISTS "envoi_terrain"`);
    await q.query(`DROP TABLE IF EXISTS "constat_ecole"`);
    await q.query(`DROP TABLE IF EXISTS "constat_agent"`);
  }
}
