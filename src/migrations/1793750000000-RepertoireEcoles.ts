import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Répertoire officiel des établissements publics (DGRHAS, 20/11/2026) : les écoles prennent le nom
 * du répertoire et gardent leurs anciens noms (pour rester reconnues dans les fiches et les
 * fichiers) ; la zone urbaine ou rurale du répertoire est conservée.
 */
export class RepertoireEcoles1793750000000 implements MigrationInterface {
  name = 'RepertoireEcoles1793750000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "structure" ADD COLUMN IF NOT EXISTS "zone" character varying`,
    );
    await q.query(
      `ALTER TABLE "structure" ADD COLUMN IF NOT EXISTS "anciensNoms" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "structure" DROP COLUMN IF EXISTS "anciensNoms"`,
    );
    await q.query(`ALTER TABLE "structure" DROP COLUMN IF EXISTS "zone"`);
  }
}
