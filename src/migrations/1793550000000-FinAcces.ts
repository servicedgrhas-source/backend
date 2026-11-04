import { MigrationInterface, QueryRunner } from 'typeorm';

/** Date de fin d'accès d'un compte (comptes visiteurs, DG 04/11/2026). */
export class FinAcces1793550000000 implements MigrationInterface {
  name = 'FinAcces1793550000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "utilisateur" ADD "finAcces" date`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "utilisateur" DROP COLUMN "finAcces"`);
  }
}
