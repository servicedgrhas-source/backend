import { MigrationInterface, QueryRunner } from 'typeorm';

export class GradesAutres1793456729932 implements MigrationInterface {
  name = 'GradesAutres1793456729932';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "regle_diplome" ADD "gradesAutres" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(`ALTER TABLE "agent" ADD "gradeChoisi" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "gradeChoisi"`);
    await queryRunner.query(
      `ALTER TABLE "regle_diplome" DROP COLUMN "gradesAutres"`,
    );
  }
}
