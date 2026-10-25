import { MigrationInterface, QueryRunner } from 'typeorm';

/** Pièce d'une ligne de tableau : l'acte de naissance de chaque enfant (DG, 24/10/2026). */
export class PieceLigne1792960000000 implements MigrationInterface {
  name = 'PieceLigne1792960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "piece_recensement" ADD "ligne" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "piece_recensement" DROP COLUMN "ligne"`,
    );
  }
}
