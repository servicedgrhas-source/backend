import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Communautaires (DG, 12/11/2026) : l'alphabétisation était rangée au primaire, et l'état de
 * paiement ne la montrait pas. Les fiches déjà dans le registre passent :
 * - au post-alpha quand leur spécialité dit « Post-Alphabétisation » (payé comme le collège) ;
 * - à l'alphabétisation (Alpha/Resco/ORA) quand leur cycle le dit (payé comme le primaire).
 * Les états de bourse déjà calculés ne changent pas : ils se recalculent à la prochaine préparation.
 */
export class CommunautairesAlpha1793680000000 implements MigrationInterface {
  name = 'CommunautairesAlpha1793680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "volontaire" SET categorie = 'COM_POST_ALPHA'
        WHERE population = 'COMMUNAUTAIRE'
          AND coalesce(specialite, '') ~* 'po(st|ts)\\W*alph'`,
    );
    await queryRunner.query(
      `UPDATE "volontaire" SET categorie = 'COM_ALPHABETISATION'
        WHERE population = 'COMMUNAUTAIRE'
          AND (categorie IS NULL OR categorie = 'COM_PRIMAIRE')
          AND coalesce("cycleBrut", '') ~* '(alph|resco|\\mora\\M)'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "volontaire" SET categorie = 'COM_PRIMAIRE'
        WHERE population = 'COMMUNAUTAIRE'
          AND categorie IN ('COM_ALPHABETISATION', 'COM_POST_ALPHA')`,
    );
  }
}
