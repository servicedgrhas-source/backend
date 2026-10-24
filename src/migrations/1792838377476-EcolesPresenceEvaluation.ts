import { MigrationInterface, QueryRunner } from 'typeorm';

export class EcolesPresenceEvaluation1792838377476 implements MigrationInterface {
  name = 'EcolesPresenceEvaluation1792838377476';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "batiment" ("id" SERIAL NOT NULL, "structureId" integer NOT NULL, "nom" character varying NOT NULL, "type" character varying, "niveaux" integer NOT NULL DEFAULT '1', "anneeConstruction" integer, "etat" character varying NOT NULL DEFAULT 'BON', "observation" text, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5c944344fcc044185aa88729115" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_63584e449bfa7ffa94541a094f" ON "batiment" ("structureId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "salle" ("id" SERIAL NOT NULL, "structureId" integer NOT NULL, "batimentId" integer, "nom" character varying NOT NULL, "type" character varying, "capacite" integer, "etat" character varying NOT NULL DEFAULT 'BON', "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e85e090433d93f866a116d0c5b4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f4da67b44296f901a7344c0a3c" ON "salle" ("structureId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ee9ee19add992d1981767337a2" ON "salle" ("batimentId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "classe" ("id" SERIAL NOT NULL, "structureId" integer NOT NULL, "anneeScolaire" character varying NOT NULL, "niveau" character varying NOT NULL, "nom" character varying NOT NULL, "salleId" integer, "effectif" integer, "effectifFilles" integer, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f5164b0fb85545cd6d8e86b6b70" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0f4809f35a8a48e88b73eb13bb" ON "classe" ("structureId", "anneeScolaire") `,
    );
    await queryRunner.query(
      `CREATE TABLE "horaire_agent" ("agentId" integer NOT NULL, "structureId" integer NOT NULL, "jours" jsonb NOT NULL DEFAULT '{}', "modifiePar" character varying, "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0a0c6ce6f884c64579a20882388" PRIMARY KEY ("agentId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_86abad73484035a94c2f5d2d1b" ON "horaire_agent" ("structureId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "presence" ("id" SERIAL NOT NULL, "agentId" integer NOT NULL, "structureId" integer NOT NULL, "date" date NOT NULL, "statut" character varying NOT NULL, "motif" character varying, "saisiPar" character varying, "saisiLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e0088b38d7cf2dc6ad815d33e7d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4e7d8d959529a00cc540eee18d" ON "presence" ("structureId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5829af0dc42c391574242cd9f3" ON "presence" ("date") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_00c60d4c0a5c46285bb2b1f4b9" ON "presence" ("agentId", "date") `,
    );
    await queryRunner.query(
      `CREATE TABLE "semaine_presence" ("id" SERIAL NOT NULL, "structureId" integer NOT NULL, "lundi" date NOT NULL, "valideePar" character varying, "valideeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d107b861aee16be15a61bfed987" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_eec5e7659165c270fff9683dc4" ON "semaine_presence" ("structureId", "lundi") `,
    );
    await queryRunner.query(
      `CREATE TABLE "evaluation_agent" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "agentId" integer NOT NULL, "annee" character varying NOT NULL, "date" date NOT NULL, "competenceProfessionnelle" integer NOT NULL, "competenceSociale" integer NOT NULL, "globale" real NOT NULL, "appreciation" character varying NOT NULL, "decision" character varying, "commentaireProfessionnel" text, "commentaireSocial" text, "structureId" integer, "evaluateur" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_270127aa84e51775e00feeb6b72" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f4d4cdecad940bb5f6ccd3ae9b" ON "evaluation_agent" ("agentId", "annee") `,
    );
    await queryRunner.query(
      `ALTER TABLE "structure" ADD "responsableId" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "structure" ADD "responsableInterim" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "structure" DROP COLUMN "responsableInterim"`,
    );
    await queryRunner.query(
      `ALTER TABLE "structure" DROP COLUMN "responsableId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f4d4cdecad940bb5f6ccd3ae9b"`,
    );
    await queryRunner.query(`DROP TABLE "evaluation_agent"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eec5e7659165c270fff9683dc4"`,
    );
    await queryRunner.query(`DROP TABLE "semaine_presence"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_00c60d4c0a5c46285bb2b1f4b9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5829af0dc42c391574242cd9f3"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4e7d8d959529a00cc540eee18d"`,
    );
    await queryRunner.query(`DROP TABLE "presence"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_86abad73484035a94c2f5d2d1b"`,
    );
    await queryRunner.query(`DROP TABLE "horaire_agent"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0f4809f35a8a48e88b73eb13bb"`,
    );
    await queryRunner.query(`DROP TABLE "classe"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ee9ee19add992d1981767337a2"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f4da67b44296f901a7344c0a3c"`,
    );
    await queryRunner.query(`DROP TABLE "salle"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_63584e449bfa7ffa94541a094f"`,
    );
    await queryRunner.query(`DROP TABLE "batiment"`);
  }
}
