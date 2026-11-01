import { MigrationInterface, QueryRunner } from 'typeorm';

export class AmpliationsExclues1793520000000 implements MigrationInterface {
  name = 'AmpliationsExclues1793520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "ampliationsExclues" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "ampliationsExclues"`,
    );
  }
}
