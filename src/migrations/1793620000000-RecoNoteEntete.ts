import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecoNoteEntete1793620000000 implements MigrationInterface {
  name = 'RecoNoteEntete1793620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD "specialite" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "enteteLibre" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "enteteLibre"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP COLUMN "specialite"`,
    );
  }
}
