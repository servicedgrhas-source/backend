import { MigrationInterface, QueryRunner } from 'typeorm';

export class RegularisationsMiseEnRoute1792742269997 implements MigrationInterface {
  name = 'RegularisationsMiseEnRoute1792742269997';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "regularisation" ("id" SERIAL NOT NULL, "volontaireId" uuid NOT NULL, "type" character varying NOT NULL, "montant" integer NOT NULL, "reste" integer NOT NULL, "motif" text NOT NULL, "origine" character varying NOT NULL DEFAULT 'MANUEL', "statut" character varying NOT NULL DEFAULT 'EN_ATTENTE', "applications" jsonb NOT NULL DEFAULT '[]', "creePar" character varying, "annulePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7150afb9672b1a949d1465dc3e8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f097ab89c745ac6b1bd9a012ca" ON "regularisation" ("volontaireId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f92ea8bd26fde1367ca1edfb50" ON "regularisation" ("origine") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4160dc3be041ddabcef15f1bc8" ON "regularisation" ("statut") `,
    );
    await queryRunner.query(
      `CREATE TABLE "mise_en_route" ("id" SERIAL NOT NULL, "libelle" character varying NOT NULL, "noteReference" character varying, "statut" character varying NOT NULL DEFAULT 'BROUILLON', "source" character varying NOT NULL DEFAULT 'CALCUL', "effectif" integer NOT NULL DEFAULT '0', "total" bigint NOT NULL DEFAULT '0', "anomalies" jsonb NOT NULL DEFAULT '[]', "preparePar" character varying, "validePar" character varying, "valideLe" TIMESTAMP WITH TIME ZONE, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_996eb676ff8d74a6af40b72e78d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e254d2f62f486d68e9a1bffda1" ON "mise_en_route" ("noteReference") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ligne_mise_en_route" ("id" SERIAL NOT NULL, "miseEnRouteId" integer NOT NULL, "volontaireId" uuid, "nomComplet" character varying NOT NULL, "dateNaissance" date, "lieuNaissance" character varying, "categorie" character varying, "specialite" character varying, "departementId" integer, "etablissement" character varying, "telephone" character varying, "equipement" integer NOT NULL DEFAULT '0', "billet" integer NOT NULL DEFAULT '0', "bagages" integer NOT NULL DEFAULT '0', "total" integer NOT NULL DEFAULT '0', "observation" character varying, CONSTRAINT "PK_ee72e3137efef8f93833e839bc3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bac199b66ac7cdedd1a9666cae" ON "ligne_mise_en_route" ("miseEnRouteId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_827b93fc964940a7f5e708cf0f" ON "ligne_mise_en_route" ("volontaireId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "besoin_etablissement" ("id" SERIAL NOT NULL, "departementId" integer NOT NULL, "etablissement" character varying NOT NULL, "etablissementNormalise" character varying NOT NULL, "categorie" character varying NOT NULL, "specialite" character varying, "nombre" integer NOT NULL, "anneeScolaire" character varying, "observation" text, "creePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_414debe37549fef553ee1dfb3f7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8d5295c7e523fb9083177a28b4" ON "besoin_etablissement" ("departementId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eace34f4ab5160806782501285" ON "besoin_etablissement" ("etablissementNormalise") `,
    );
    await queryRunner.query(
      `ALTER TABLE "ligne_bourse" ADD "du" character varying(7)`,
    );
    await queryRunner.query(
      `ALTER TABLE "ligne_bourse" ADD "au" character varying(7)`,
    );
    await queryRunner.query(
      `ALTER TABLE "ligne_bourse" ADD "regularisation" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "ligne_bourse" ADD "regularisations" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ligne_bourse" DROP COLUMN "regularisations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ligne_bourse" DROP COLUMN "regularisation"`,
    );
    await queryRunner.query(`ALTER TABLE "ligne_bourse" DROP COLUMN "au"`);
    await queryRunner.query(`ALTER TABLE "ligne_bourse" DROP COLUMN "du"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eace34f4ab5160806782501285"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8d5295c7e523fb9083177a28b4"`,
    );
    await queryRunner.query(`DROP TABLE "besoin_etablissement"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_827b93fc964940a7f5e708cf0f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bac199b66ac7cdedd1a9666cae"`,
    );
    await queryRunner.query(`DROP TABLE "ligne_mise_en_route"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e254d2f62f486d68e9a1bffda1"`,
    );
    await queryRunner.query(`DROP TABLE "mise_en_route"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4160dc3be041ddabcef15f1bc8"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f92ea8bd26fde1367ca1edfb50"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f097ab89c745ac6b1bd9a012ca"`,
    );
    await queryRunner.query(`DROP TABLE "regularisation"`);
  }
}
