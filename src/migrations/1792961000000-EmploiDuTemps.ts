import { MigrationInterface, QueryRunner } from 'typeorm';

/** Emplois du temps des collèges et des lycées (DG, 24/10/2026). */
export class EmploiDuTemps1792961000000 implements MigrationInterface {
  name = 'EmploiDuTemps1792961000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "emploi_du_temps" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "structureId" integer NOT NULL, "anneeScolaire" character varying NOT NULL, "jours" jsonb NOT NULL, "creneaux" jsonb NOT NULL, "seances" jsonb NOT NULL, "nonPlaces" jsonb NOT NULL, "charges" jsonb NOT NULL, "heuresTotal" integer NOT NULL, "heuresPlacees" integer NOT NULL, "generePar" character varying, "genereLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_emploi_du_temps" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_127eaa8d8f753f568db6166c54" ON "emploi_du_temps" ("structureId", "anneeScolaire")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_127eaa8d8f753f568db6166c54"`,
    );
    await queryRunner.query(`DROP TABLE "emploi_du_temps"`);
  }
}
