import { MigrationInterface, QueryRunner } from 'typeorm';

export class NotesEnrolementCadrage1793590000000 implements MigrationInterface {
  name = 'NotesEnrolementCadrage1793590000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "colonnesNote" jsonb`,
    );
    await queryRunner.query(`ALTER TABLE "note_service" ADD "additifDe" uuid`);
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "rectificatifDe" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "rectifications" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "rectifications"`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "rectificatifDe"`,
    );
    await queryRunner.query(`ALTER TABLE "note_service" DROP COLUMN "additifDe"`);
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "colonnesNote"`,
    );
  }
}
