import { MigrationInterface, QueryRunner } from 'typeorm';

/** Cadre organique et besoins en personnel des structures administratives (DG, 28/10/2026). */
export class BesoinsAdministratifs1792963000000 implements MigrationInterface {
  name = 'BesoinsAdministratifs1792963000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "cadre_organique" ("id" SERIAL NOT NULL, "structureId" integer NOT NULL, "poste" character varying NOT NULL, "effectif" integer NOT NULL, "modifiePar" character varying, "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_cadre_organique" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_3f5b10ded34efbd743aa8c60de" ON "cadre_organique" ("structureId", "poste")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a24f2dac02a992387241f34f1a" ON "cadre_organique" ("structureId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "besoin_personnel" ("id" SERIAL NOT NULL, "structureId" integer NOT NULL, "poste" character varying NOT NULL, "nombre" integer NOT NULL, "motif" text NOT NULL, "statut" character varying NOT NULL DEFAULT 'EN_ATTENTE', "nombreAccorde" integer, "decision" text, "decidePar" character varying, "decideLe" TIMESTAMP WITH TIME ZONE, "creePar" character varying, "creeParId" uuid, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_besoin_personnel" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d639788c7ed4d8e29cb2ed98d3" ON "besoin_personnel" ("structureId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a714d08094e024d40ac43b9abf" ON "besoin_personnel" ("statut")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "besoin_personnel"`);
    await queryRunner.query(`DROP TABLE "cadre_organique"`);
  }
}
