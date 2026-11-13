import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enrôlement (DG, 12/11/2026) : la liste des écartés, déjà connus ailleurs (recruté de la Fonction
 * publique, personnel, volontaire, communautaire, enrôlé d'une autre année). Les dossiers déjà
 * écartés pour ce motif y entrent.
 */
export class EcartesEnrolement1793690000000 implements MigrationInterface {
  name = 'EcartesEnrolement1793690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "enrole" ADD "ecarteDejaConnu" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "enrole" ADD "dejaConnuDecision" text`,
    );
    await queryRunner.query(
      `UPDATE "enrole" SET "ecarteDejaConnu" = true
        WHERE etat = 'NON_RETENU' AND coalesce("motifDecision", '') LIKE 'Déjà connu%'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "enrole" DROP COLUMN "dejaConnuDecision"`,
    );
    await queryRunner.query(
      `ALTER TABLE "enrole" DROP COLUMN "ecarteDejaConnu"`,
    );
  }
}
