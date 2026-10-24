import { MigrationInterface, QueryRunner } from 'typeorm';

export class DossierCarriere1792834740734 implements MigrationInterface {
  name = 'DossierCarriere1792834740734';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "evenement_carriere" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "agentId" integer NOT NULL, "type" character varying NOT NULL, "dateEffet" date, "acteNature" character varying, "acteNumero" character varying, "acteDate" date, "nouveau" jsonb NOT NULL DEFAULT '{}', "avant" jsonb NOT NULL DEFAULT '{}', "reporte" boolean NOT NULL DEFAULT false, "commentaire" text, "fichier" character varying, "nomOrigine" character varying, "mime" character varying, "creePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_580f2bdca7737496b54a3e54227" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2f4fe8b9cbf6208b837155fc8c" ON "evenement_carriere" ("agentId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2f4fe8b9cbf6208b837155fc8c"`,
    );
    await queryRunner.query(`DROP TABLE "evenement_carriere"`);
  }
}
