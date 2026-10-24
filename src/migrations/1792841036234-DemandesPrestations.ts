import { MigrationInterface, QueryRunner } from 'typeorm';

export class DemandesPrestations1792841036234 implements MigrationInterface {
  name = 'DemandesPrestations1792841036234';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" ADD "dateDebut" date`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" ADD "dateFin" date`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" ADD "agentId" integer`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d05cf7167ca4b1647a91bd5723" ON "demande_mutation" ("agentId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d05cf7167ca4b1647a91bd5723"`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" DROP COLUMN "agentId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" DROP COLUMN "dateFin"`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" DROP COLUMN "dateDebut"`,
    );
  }
}
