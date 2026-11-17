import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rapprochement des rapports de fin d'année des DDEPPSA (Banque mondiale, 17/11/2026) : les
 * rapports importés et chaque personne qu'ils citent, avec son rapprochement et sa décision.
 */
export class RapportsPersonnel1793710000000 implements MigrationInterface {
  name = 'RapportsPersonnel1793710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "rapport_personnel" ("id" SERIAL NOT NULL, "departementId" integer, "anneeScolaire" character varying NOT NULL DEFAULT '', "nomFichier" character varying NOT NULL DEFAULT '', "lignes" integer NOT NULL DEFAULT 0, "importePar" character varying, "importeLe" TIMESTAMP NOT NULL DEFAULT now(), "calculeLe" TIMESTAMP, CONSTRAINT "PK_rapport_personnel" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "ligne_rapport_personnel" ("id" SERIAL NOT NULL, "rapportId" integer NOT NULL, "ordre" integer NOT NULL DEFAULT 0, "rubrique" character varying, "cycle" character varying, "secteur" character varying, "numero" character varying, "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "anneeNaissance" integer, "dateNaissance" date, "statut" character varying, "matricule" character varying, "ecole" character varying, "fonction" character varying, "priseService" character varying, "donnees" jsonb NOT NULL DEFAULT '{}', "resultat" character varying NOT NULL DEFAULT 'ABSENT', "methode" character varying, "agentId" integer, "volontaireId" uuid, "ecarts" jsonb NOT NULL DEFAULT '[]', "candidats" jsonb NOT NULL DEFAULT '[]', "decision" character varying, "decidePar" character varying, "decideLe" TIMESTAMP, "applique" jsonb, "appliquePar" character varying, "appliqueLe" TIMESTAMP, CONSTRAINT "PK_ligne_rapport_personnel" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ligne_rapport_personnel_rapport" ON "ligne_rapport_personnel" ("rapportId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ligne_rapport_personnel_rapport"`,
    );
    await queryRunner.query(`DROP TABLE "ligne_rapport_personnel"`);
    await queryRunner.query(`DROP TABLE "rapport_personnel"`);
  }
}
