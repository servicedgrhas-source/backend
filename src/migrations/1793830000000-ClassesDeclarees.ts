import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nombre de classes déclaré par école et par année scolaire (DG, 26/11/2026 : fichier des
 * allocations budgétaires 2026). Il sert au besoin en enseignants tant que les classes ne sont pas
 * saisies une par une.
 */
export class ClassesDeclarees1793830000000 implements MigrationInterface {
  name = 'ClassesDeclarees1793830000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS "classes_declarees" (
      "structureId" integer NOT NULL,
      "anneeScolaire" character varying NOT NULL,
      "nombre" integer NOT NULL,
      "source" character varying,
      "importePar" character varying,
      "importeLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_classes_declarees" PRIMARY KEY ("structureId", "anneeScolaire")
    )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "classes_declarees"`);
  }
}
