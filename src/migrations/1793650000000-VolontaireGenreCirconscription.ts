import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registre des volontaires et communautaires (07/11/2026) : le sexe et la circonscription, lus
 * dans la base de l'enrôlement biométrique et la base des communautaires lors d'une mise à jour.
 */
export class VolontaireGenreCirconscription1793650000000 implements MigrationInterface {
  name = 'VolontaireGenreCirconscription1793650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "volontaire" ADD "genre" character varying(1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "volontaire" ADD "circonscription" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "volontaire" DROP COLUMN "circonscription"`,
    );
    await queryRunner.query(`ALTER TABLE "volontaire" DROP COLUMN "genre"`);
  }
}
