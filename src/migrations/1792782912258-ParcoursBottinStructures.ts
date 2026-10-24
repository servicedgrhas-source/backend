import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParcoursBottinStructures1792782912258 implements MigrationInterface {
  name = 'ParcoursBottinStructures1792782912258';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ligne_bottin" ("id" SERIAL NOT NULL, "mois" character varying(7) NOT NULL, "matricule" character varying, "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "dateNaissance" date, "departement" character varying, "grade" character varying, "indice" integer, "brut" integer, "banque" character varying, "source" character varying, "importePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c645e825ac4f2d0505d9a6e70fa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_19d22662b87983a9502ea96392" ON "ligne_bottin" ("mois") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_537a82e1ba6131fe7d99fd5388" ON "ligne_bottin" ("matricule") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_75da76b3d336cf0224b9c19db7" ON "ligne_bottin" ("nomNormalise") `,
    );
    await queryRunner.query(
      `ALTER TABLE "structure" ADD "cycle" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "structure" ADD "typeLocalite" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "structure" ADD "localite" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" ADD "parcours" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" ADD "contentieux" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" ADD "distinctes" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_recense" DROP COLUMN "distinctes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" DROP COLUMN "contentieux"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_recense" DROP COLUMN "parcours"`,
    );
    await queryRunner.query(`ALTER TABLE "structure" DROP COLUMN "localite"`);
    await queryRunner.query(
      `ALTER TABLE "structure" DROP COLUMN "typeLocalite"`,
    );
    await queryRunner.query(`ALTER TABLE "structure" DROP COLUMN "cycle"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_75da76b3d336cf0224b9c19db7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_537a82e1ba6131fe7d99fd5388"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_19d22662b87983a9502ea96392"`,
    );
    await queryRunner.query(`DROP TABLE "ligne_bottin"`);
  }
}
