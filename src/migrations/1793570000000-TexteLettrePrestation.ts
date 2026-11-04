import { MigrationInterface, QueryRunner } from 'typeorm';

/** Paragraphe du soit-transmis modifié à la main (« Modifier l'introduction », 05/11/2026). */
export class TexteLettrePrestation1793570000000 implements MigrationInterface {
  name = 'TexteLettrePrestation1793570000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_prestation" ADD "texteLettre" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_prestation" DROP COLUMN "texteLettre"`,
    );
  }
}
