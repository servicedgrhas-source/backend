import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Présence (DG, 24/10/2026) : l'heure d'arrivée et l'heure de départ de chaque journée pointée,
 * pour calculer les retards et les heures faites dans la semaine.
 */
export class PresenceHeures1792939210588 implements MigrationInterface {
  name = 'PresenceHeures1792939210588';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "presence" ADD "arrivee" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "presence" ADD "depart" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "presence" DROP COLUMN "depart"`);
    await queryRunner.query(`ALTER TABLE "presence" DROP COLUMN "arrivee"`);
  }
}
