import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnroleDejaConnu1793600000000 implements MigrationInterface {
  name = 'EnroleDejaConnu1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "enrole" ADD "dejaConnuVerifie" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "enrole" DROP COLUMN "dejaConnuVerifie"`);
  }
}
