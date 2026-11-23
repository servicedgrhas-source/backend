import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Base des retraits (23/11/2026) : la marque d'une fiche retirée des effectifs (volontaires et
 * communautaires non payés en bourse). Aucune fiche n'est touchée par la migration : la mise en
 * retrait se fait ensuite par le DG, groupe par groupe.
 */
export class RetraitsPersonnel1793820000000 implements MigrationInterface {
  name = 'RetraitsPersonnel1793820000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "agent_recense" ADD COLUMN IF NOT EXISTS "retrait" jsonb`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "agent_recense" DROP COLUMN IF EXISTS "retrait"`,
    );
  }
}
