import { MigrationInterface, QueryRunner } from 'typeorm';

export class DemandesPrestations1793540000000 implements MigrationInterface {
  name = 'DemandesPrestations1793540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "demande_prestation" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "numero" integer NOT NULL, "type" character varying NOT NULL, "agentId" integer NOT NULL, "agent" jsonb NOT NULL, "objet" text NOT NULL, "precisions" text, "details" jsonb NOT NULL DEFAULT '{}', "canal" character varying NOT NULL DEFAULT 'STRUCTURE', "codeSuivi" character varying, "circuit" jsonb NOT NULL DEFAULT '[]', "etapeCourante" integer, "decideur" character varying, "decision" character varying, "decisionMotivation" text, "decisionPar" character varying, "decisionLe" TIMESTAMP WITH TIME ZONE, "retiree" boolean NOT NULL DEFAULT false, "motifRetrait" text, "creePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_demande_prestation" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_demande_prestation_numero" ON "demande_prestation" ("numero") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_demande_prestation_type" ON "demande_prestation" ("type") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_demande_prestation_agent" ON "demande_prestation" ("agentId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_demande_prestation_decision" ON "demande_prestation" ("decision") `,
    );
    await queryRunner.query(
      `CREATE TABLE "piece_prestation" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "demandeId" uuid NOT NULL, "libelle" character varying NOT NULL, "nomOrigine" character varying NOT NULL, "fichier" character varying NOT NULL, "mime" character varying NOT NULL, "taille" integer NOT NULL, "ajoutePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_piece_prestation" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_piece_prestation_demande" ON "piece_prestation" ("demandeId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "piece_prestation"`);
    await queryRunner.query(`DROP TABLE "demande_prestation"`);
  }
}
