import { MigrationInterface, QueryRunner } from 'typeorm';

export class ListeOublies1793464961462 implements MigrationInterface {
  name = 'ListeOublies1793464961462';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent" ADD "oubli" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent" ADD "oubliPar" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent" ADD "oubliLe" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cc128c56ac0906a50665f71506" ON "agent" ("oubli") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cc128c56ac0906a50665f71506"`,
    );
    await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "oubliLe"`);
    await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "oubliPar"`);
    await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "oubli"`);
  }
}
