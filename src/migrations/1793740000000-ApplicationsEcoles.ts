import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Les fiches mises à jour par une décision du contrôle des écoles (19/11/2026) : une école des
 * fichiers rattachée à une école de l'organigramme corrige le lieu de service (et la DDEPPSA) des
 * fiches du personnel et du registre concernées. Chaque fiche garde sa valeur d'avant : annuler la
 * décision la remet.
 */
export class ApplicationsEcoles1793740000000 implements MigrationInterface {
  name = 'ApplicationsEcoles1793740000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS "application_ecole" ("id" SERIAL NOT NULL, "decisionId" integer NOT NULL, "cible" character varying NOT NULL, "refId" character varying NOT NULL, "avant" jsonb NOT NULL DEFAULT '{}', "apres" jsonb NOT NULL DEFAULT '{}', "par" character varying, "le" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_application_ecole" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_application_ecole_decision" ON "application_ecole" ("decisionId")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "application_ecole"`);
  }
}
