import { MigrationInterface, QueryRunner } from 'typeorm';

/** Jours de cours, créneaux et heures des enseignants propres à une école (DG, 28/10/2026). */
export class ReglagesEdtEcole1792964000000 implements MigrationInterface {
  name = 'ReglagesEdtEcole1792964000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "structure" ADD "reglagesEdt" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "structure" DROP COLUMN "reglagesEdt"`,
    );
  }
}
