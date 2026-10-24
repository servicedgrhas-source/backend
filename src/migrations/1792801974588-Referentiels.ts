import { MigrationInterface, QueryRunner } from 'typeorm';

export class Referentiels1792801974588 implements MigrationInterface {
  name = 'Referentiels1792801974588';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "referentiel" ("id" SERIAL NOT NULL, "type" character varying NOT NULL, "code" character varying NOT NULL, "libelle" character varying NOT NULL, "libelleNormalise" character varying NOT NULL, "parent" character varying, "departementId" integer, "donnees" jsonb NOT NULL DEFAULT '{}', "actif" boolean NOT NULL DEFAULT true, "ordre" integer NOT NULL DEFAULT '0', "source" character varying NOT NULL DEFAULT 'SAISIE', "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_55af18493dc054952ae95534535" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c4c4571ffdca18aef7a9acc57c" ON "referentiel" ("type") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e0023c3df4543f34d12c388f77" ON "referentiel" ("libelleNormalise") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f5279c406e7fd7187987e35b91" ON "referentiel" ("parent") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_de174188a4d81d5e522706e764" ON "referentiel" ("departementId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_0e14986d268edf8286576fee1d" ON "referentiel" ("type", "code") `,
    );
    await queryRunner.query(
      `ALTER TABLE "structure" ADD "code" character varying`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0c0078498c73689a6c72dd5bf5" ON "structure" ("code") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0c0078498c73689a6c72dd5bf5"`,
    );
    await queryRunner.query(`ALTER TABLE "structure" DROP COLUMN "code"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0e14986d268edf8286576fee1d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_de174188a4d81d5e522706e764"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f5279c406e7fd7187987e35b91"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e0023c3df4543f34d12c388f77"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c4c4571ffdca18aef7a9acc57c"`,
    );
    await queryRunner.query(`DROP TABLE "referentiel"`);
  }
}
