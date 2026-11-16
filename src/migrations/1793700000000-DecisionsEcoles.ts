import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Effectifs par école (Banque mondiale, 16/11/2026) : les décisions sur les écoles qui se
 * ressemblent (même école, deux écoles différentes, pas une école, nom ou DEPPSA corrigés).
 */
export class DecisionsEcoles1793700000000 implements MigrationInterface {
  name = 'DecisionsEcoles1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "decision_ecole" ("id" SERIAL NOT NULL, "cle" character varying NOT NULL, "type" character varying NOT NULL, "autreCle" character varying NOT NULL DEFAULT '', "nom" character varying, "departementId" integer, "cycle" character varying, "motif" text, "par" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_decision_ecole" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_decision_ecole_cle" ON "decision_ecole" ("cle") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_decision_ecole_cle"`);
    await queryRunner.query(`DROP TABLE "decision_ecole"`);
  }
}
