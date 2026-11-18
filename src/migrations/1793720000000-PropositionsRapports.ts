import { MigrationInterface, QueryRunner } from 'typeorm';

/** Propositions à la base du personnel depuis les rapports des DDEPPSA (17/11/2026). */
export class PropositionsRapports1793720000000 implements MigrationInterface {
  name = 'PropositionsRapports1793720000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "modification_recensement" ADD COLUMN IF NOT EXISTS "proposition" boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `ALTER TABLE "modification_recensement" ADD COLUMN IF NOT EXISTS "source" text`,
    );
    await q.query(
      `ALTER TABLE "ligne_rapport_personnel" ADD COLUMN IF NOT EXISTS "propositionId" integer`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "ligne_rapport_personnel" DROP COLUMN IF EXISTS "propositionId"`,
    );
    await q.query(
      `ALTER TABLE "modification_recensement" DROP COLUMN IF EXISTS "source"`,
    );
    await q.query(
      `ALTER TABLE "modification_recensement" DROP COLUMN IF EXISTS "proposition"`,
    );
  }
}
