import { MigrationInterface, QueryRunner } from 'typeorm';

export class AmpliationsAjoutees1793530000000 implements MigrationInterface {
  name = 'AmpliationsAjoutees1793530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "ampliationsAjoutees" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "ampliationsAjoutees"`,
    );
  }
}
