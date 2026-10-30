import { MigrationInterface, QueryRunner } from 'typeorm';

export class PlagesHoraires1793312322700 implements MigrationInterface {
  name = 'PlagesHoraires1793312322700';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "horaire_agent" ADD "plages" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "emploi_du_temps" ADD "heuresProgramme" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "emploi_du_temps" DROP COLUMN "heuresProgramme"`,
    );
    await queryRunner.query(`ALTER TABLE "horaire_agent" DROP COLUMN "plages"`);
  }
}
