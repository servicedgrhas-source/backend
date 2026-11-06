import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnrolementLotsTextes1793610000000 implements MigrationInterface {
  name = 'EnrolementLotsTextes1793610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "enrole" ADD "noteForcee" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "enrole" ADD "lotRangement" integer`);
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "lotRangement" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "textesLibres" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "textesLibres"`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "lotRangement"`,
    );
    await queryRunner.query(`ALTER TABLE "enrole" DROP COLUMN "lotRangement"`);
    await queryRunner.query(`ALTER TABLE "enrole" DROP COLUMN "noteForcee"`);
  }
}
