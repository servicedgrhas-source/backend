import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Outil de détection (08/11/2026) : suspension d'un compte signalé, et journal de sécurité des
 * règles franchies.
 */
export class Securite1793670000000 implements MigrationInterface {
  name = 'Securite1793670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "utilisateur" ADD "suspenduLe" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" ADD "suspensionMotif" text`,
    );
    await queryRunner.query(
      `CREATE TABLE "evenement_securite" ("id" SERIAL NOT NULL, "utilisateurId" uuid NOT NULL, "regle" character varying NOT NULL, "points" integer NOT NULL DEFAULT '0', "score" integer NOT NULL DEFAULT '0', "chemin" character varying, "ip" character varying, "navigateur" character varying, "details" jsonb, "creeLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_evenement_securite" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_evenement_securite_utilisateur" ON "evenement_securite" ("utilisateurId", "creeLe") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_evenement_securite_utilisateur"`,
    );
    await queryRunner.query(`DROP TABLE "evenement_securite"`);
    await queryRunner.query(
      `ALTER TABLE "utilisateur" DROP COLUMN "suspensionMotif"`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" DROP COLUMN "suspenduLe"`,
    );
  }
}
