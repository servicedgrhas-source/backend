import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recenseurs de la mission de terrain (DG, 22/11/2026) : comptes RECENSEUR planifiés à l'avance
 * (identifiant RG-001-CO…), départements de la mission, dates, téléphones, blocage, effacement à
 * distance ; positions relevées par les tablettes (suivi depuis Brazzaville).
 */
export class Recenseurs1793770000000 implements MigrationInterface {
  name = 'Recenseurs1793770000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS "recenseur" (
      "utilisateurId" uuid PRIMARY KEY,
      "code" character varying NOT NULL,
      "departements" integer[] NOT NULL DEFAULT '{}',
      "telephones" character varying[] NOT NULL DEFAULT '{}',
      "debut" date,
      "fin" date,
      "effacerLe" TIMESTAMP WITH TIME ZONE,
      "effaceLe" TIMESTAMP WITH TIME ZONE,
      "bloqueLe" TIMESTAMP WITH TIME ZONE,
      "bloquePar" character varying,
      "creePar" character varying,
      "creeLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_recenseur_code" ON "recenseur" ("code")`,
    );
    // Positions relevées par les tablettes pendant la mission (suivi depuis Brazzaville)
    await q.query(`CREATE TABLE IF NOT EXISTS "position_recenseur" (
      "id" BIGSERIAL PRIMARY KEY,
      "utilisateurId" uuid NOT NULL,
      "latitude" double precision,
      "longitude" double precision,
      "precision" real,
      "etat" character varying NOT NULL DEFAULT 'OK',
      "le" TIMESTAMP WITH TIME ZONE NOT NULL,
      "recuLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_position_recenseur_utilisateur_le" ON "position_recenseur" ("utilisateurId", "le")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "position_recenseur"`);
    await q.query(`DROP TABLE IF EXISTS "recenseur"`);
  }
}
