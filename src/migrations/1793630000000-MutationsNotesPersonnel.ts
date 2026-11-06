import { MigrationInterface, QueryRunner } from 'typeorm';

export class MutationsNotesPersonnel1793630000000 implements MigrationInterface {
  name = 'MutationsNotesPersonnel1793630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" ADD "lotRangement" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "reportePersonnelLe" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "reportePersonnelPar" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" ADD "libelleLot" character varying`,
    );
    // Les notes de mutation déjà signées ont été reportées automatiquement (avant le 06/11/2026)
    await queryRunner.query(
      `UPDATE "note_service" SET "reportePersonnelLe" = now(), "reportePersonnelPar" = 'Report automatique (avant le 06/11/2026)' WHERE module = 'MUTATION' AND statut = 'SIGNEE'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "libelleLot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "reportePersonnelPar"`,
    );
    await queryRunner.query(
      `ALTER TABLE "note_service" DROP COLUMN "reportePersonnelLe"`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" DROP COLUMN "lotRangement"`,
    );
  }
}
