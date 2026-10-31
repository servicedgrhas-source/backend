import { MigrationInterface, QueryRunner } from "typeorm";

export class DoublonsDistincts1793438541925 implements MigrationInterface {
    name = 'DoublonsDistincts1793438541925'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "doublon_distinct" ("id" SERIAL NOT NULL, "base" character varying NOT NULL, "a" character varying NOT NULL, "b" character varying NOT NULL, "motif" text, "par" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_85a7f0d60c995a521f3a2a0ca6d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a1d299b50485e0615050712b6a" ON "doublon_distinct" ("base", "a", "b") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a1d299b50485e0615050712b6a"`);
        await queryRunner.query(`DROP TABLE "doublon_distinct"`);
    }

}
