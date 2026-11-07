import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enrôlement (réunion DG du 06/11/2026) : base définitive arrêtée, et répartition des retenus par
 * département (places au choix du critère, brouillon de la commission, validation du DG).
 */
export class RepartitionEnrolement1793660000000 implements MigrationInterface {
  name = 'RepartitionEnrolement1793660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "campagne_enrolement" ADD "baseArreteeLe" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "campagne_enrolement" ADD "baseArreteePar" character varying`,
    );
    await queryRunner.query(
      `CREATE TABLE "repartition_enrolement" ("id" SERIAL NOT NULL, "campagneId" integer NOT NULL, "critere" character varying NOT NULL DEFAULT 'CYCLE', "quotas" jsonb NOT NULL DEFAULT '{}', "placements" jsonb NOT NULL DEFAULT '{}', "modifiePar" character varying, "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), "valideePar" character varying, "valideeLe" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_repartition_enrolement" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_repartition_enrolement_campagne" ON "repartition_enrolement" ("campagneId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_repartition_enrolement_campagne"`,
    );
    await queryRunner.query(`DROP TABLE "repartition_enrolement"`);
    await queryRunner.query(
      `ALTER TABLE "campagne_enrolement" DROP COLUMN "baseArreteePar"`,
    );
    await queryRunner.query(
      `ALTER TABLE "campagne_enrolement" DROP COLUMN "baseArreteeLe"`,
    );
  }
}
