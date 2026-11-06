import { MigrationInterface, QueryRunner } from 'typeorm';

export class AnomaliesVerifiees1793640000000 implements MigrationInterface {
  name = 'AnomaliesVerifiees1793640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" ADD "anomaliesVerifiees" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" DROP COLUMN "anomaliesVerifiees"`,
    );
  }
}
