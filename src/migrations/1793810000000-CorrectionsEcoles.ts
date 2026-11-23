import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Les écoles au contrôle (23/11/2026) : l'équipe dit ce que la base a de faux sur une école
 * (localité, département, inspection, cycle) ; le contrôle applique ou refuse, avec un motif.
 */
export class CorrectionsEcoles1793810000000 implements MigrationInterface {
  name = 'CorrectionsEcoles1793810000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "constat_ecole" ADD COLUMN IF NOT EXISTS "correction" jsonb`,
    );
    await q.query(
      `ALTER TABLE "constat_ecole" ADD COLUMN IF NOT EXISTS "decision" character varying`,
    );
    await q.query(
      `ALTER TABLE "constat_ecole" ADD COLUMN IF NOT EXISTS "motif" text`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "constat_ecole" DROP COLUMN IF EXISTS "motif"`);
    await q.query(
      `ALTER TABLE "constat_ecole" DROP COLUMN IF EXISTS "decision"`,
    );
    await q.query(
      `ALTER TABLE "constat_ecole" DROP COLUMN IF EXISTS "correction"`,
    );
  }
}
