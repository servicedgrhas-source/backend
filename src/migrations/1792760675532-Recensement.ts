import { MigrationInterface, QueryRunner } from 'typeorm';

export class Recensement1792760675532 implements MigrationInterface {
  name = 'Recensement1792760675532';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "agent_recense" ("id" SERIAL NOT NULL, "numeroFiche" character varying, "statut" character varying NOT NULL, "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "dateNaissance" date, "matricule" character varying, "telephone" character varying, "departementId" integer, "structureId" integer, "donnees" jsonb NOT NULL DEFAULT '{}', "manques" jsonb NOT NULL DEFAULT '{}', "taux" integer NOT NULL DEFAULT '0', "complet" boolean NOT NULL DEFAULT false, "source" character varying NOT NULL DEFAULT 'SAISIE', "creePar" character varying, "modifiePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_04bbacf7467723cc70882fec008" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_54fa3b23eedfc3386a8a2ab32b" ON "agent_recense" ("numeroFiche") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e0c4f54078d9ebd0ef16a53c11" ON "agent_recense" ("statut") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_56996c4382a2e80d1874ec0356" ON "agent_recense" ("nomNormalise") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2efadce0b6749c2e8efc66c04b" ON "agent_recense" ("matricule") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3b5ef87ca32bd7de4ee8ce277e" ON "agent_recense" ("departementId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ba2805006b5fa7e0b2c8c2ea1d" ON "agent_recense" ("structureId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_51268cbc6f1ee41572b439c123" ON "agent_recense" ("complet") `,
    );
    await queryRunner.query(
      `CREATE TABLE "piece_recensement" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "agentId" integer NOT NULL, "type" character varying NOT NULL, "nomOrigine" character varying NOT NULL, "fichier" character varying NOT NULL, "mime" character varying NOT NULL, "taille" integer NOT NULL, "ajoutePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b068b677f8b3982c8a0b0c1d7f3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d7b8607ee11da3b023c4f997e2" ON "piece_recensement" ("agentId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e35f905389b344c4df95332a90" ON "piece_recensement" ("agentId", "type") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e35f905389b344c4df95332a90"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d7b8607ee11da3b023c4f997e2"`,
    );
    await queryRunner.query(`DROP TABLE "piece_recensement"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_51268cbc6f1ee41572b439c123"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ba2805006b5fa7e0b2c8c2ea1d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3b5ef87ca32bd7de4ee8ce277e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2efadce0b6749c2e8efc66c04b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_56996c4382a2e80d1874ec0356"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e0c4f54078d9ebd0ef16a53c11"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_54fa3b23eedfc3386a8a2ab32b"`,
    );
    await queryRunner.query(`DROP TABLE "agent_recense"`);
  }
}
