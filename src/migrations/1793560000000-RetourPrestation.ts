import { MigrationInterface, QueryRunner } from 'typeorm';

/** Retour du service destinataire d'une demande de prestation (DG, 03/11/2026). */
export class RetourPrestation1793560000000 implements MigrationInterface {
  name = 'RetourPrestation1793560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_prestation" ADD "retourEtat" character varying, ADD "retourNote" text, ADD "retourPar" character varying, ADD "retourLe" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_prestation" DROP COLUMN "retourLe", DROP COLUMN "retourPar", DROP COLUMN "retourNote", DROP COLUMN "retourEtat"`,
    );
  }
}
