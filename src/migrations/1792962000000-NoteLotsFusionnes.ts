import { MigrationInterface, QueryRunner } from 'typeorm';

/** Une note d'affectation peut réunir plusieurs lots (DG, 26/10/2026). */
export class NoteLotsFusionnes1792962000000 implements MigrationInterface {
  name = 'NoteLotsFusionnes1792962000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "lotsFusionnes" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "lotsFusionnes"`,
    );
  }
}
