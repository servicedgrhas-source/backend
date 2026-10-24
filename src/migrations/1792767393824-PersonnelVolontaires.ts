import { MigrationInterface, QueryRunner } from 'typeorm';

export class PersonnelVolontaires1792767393824 implements MigrationInterface {
  name = 'PersonnelVolontaires1792767393824';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_recense" ADD "volontaireId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" ADD "liaison" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_14ba909ac2d7c08854da6b721b" ON "agent_recense" ("volontaireId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_14ba909ac2d7c08854da6b721b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" DROP COLUMN "liaison"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" DROP COLUMN "volontaireId"`,
    );
  }
}
