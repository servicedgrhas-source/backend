import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pied de page : « Adresse : … » et non « Contacts : … » (retour du 05/11/2026). Seule la valeur
 * déjà enregistrée qui commence par « Contact(s) : » change ; une adresse réécrite par le DG reste.
 */
export class AdressePied1793580000000 implements MigrationInterface {
  name = 'AdressePied1793580000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "parametre" SET "valeur" = regexp_replace("valeur", '^\s*Contacts?\s*:\s*', 'Adresse : ') WHERE "cle" = 'ADRESSE_PIED' AND "valeur" ~* '^\s*Contacts?\s*:'`,
    );
  }

  public async down(): Promise<void> {
    // Rien : l'ancienne mention n'est pas remise
  }
}
