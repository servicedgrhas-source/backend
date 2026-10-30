import { MigrationInterface, QueryRunner } from 'typeorm';

export class ModificationsRecensement1793358732887 implements MigrationInterface {
  name = 'ModificationsRecensement1793358732887';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "modification_recensement" ("id" SERIAL NOT NULL, "agentId" integer NOT NULL, "champs" jsonb NOT NULL, "etat" character varying NOT NULL DEFAULT 'A_CONTROLER', "faitePar" character varying, "faiteLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "controlePar" character varying, "controleLe" TIMESTAMP WITH TIME ZONE, "note" text, CONSTRAINT "PK_cb686c23df9dd1ecdd3af38554c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b1c23af73c3faed62124ddcf03" ON "modification_recensement" ("agentId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_74d793e5950391197015a560ff" ON "modification_recensement" ("etat") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_74d793e5950391197015a560ff"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b1c23af73c3faed62124ddcf03"`,
    );
    await queryRunner.query(`DROP TABLE "modification_recensement"`);
  }
}
