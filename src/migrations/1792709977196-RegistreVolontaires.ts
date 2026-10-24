import { MigrationInterface, QueryRunner } from 'typeorm';

export class RegistreVolontaires1792709977196 implements MigrationInterface {
  name = 'RegistreVolontaires1792709977196';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "volontaire" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "dateNaissance" date, "lieuNaissance" character varying, "telephone" character varying, "diplome" character varying, "specialite" character varying, "categorie" character varying, "cycleBrut" character varying, "departementId" integer, "departementBrut" character varying, "etablissement" character varying, "vague" character varying, "noteReference" character varying, "dateNote" date, "datePriseService" date, "premierMois" character varying(7), "statut" character varying NOT NULL DEFAULT 'EN_POSTE', "motifSortie" character varying, "dateSortie" date, "observation" text, "source" character varying, "enroleId" uuid, "verifications" jsonb NOT NULL DEFAULT '{}', "creePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b3692a038980f6a331a972658e9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_feae034e29d43fa298481e24a7" ON "volontaire" ("nomNormalise") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_21a432f91c75736904515230ff" ON "volontaire" ("categorie") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_002388604c923bdcd0bdb4a1a9" ON "volontaire" ("departementId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6c0a47bd3136eaab8d6c97023c" ON "volontaire" ("statut") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5680eb2ea04b9153bbc9e9b1c0" ON "volontaire" ("enroleId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "mouvement_volontaire" ("id" SERIAL NOT NULL, "volontaireId" uuid NOT NULL, "type" character varying NOT NULL, "dateEffet" date, "motif" character varying, "details" jsonb, "par" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d3739c48a060efb6a93ebc19b4c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3b33ac2d154da669b0da10ab9e" ON "mouvement_volontaire" ("volontaireId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "etat_bourse" ("id" SERIAL NOT NULL, "mois" character varying(7) NOT NULL, "statut" character varying NOT NULL DEFAULT 'BROUILLON', "effectif" integer NOT NULL DEFAULT '0', "total" bigint NOT NULL DEFAULT '0', "anomalies" jsonb NOT NULL DEFAULT '[]', "preparePar" character varying, "calculeLe" TIMESTAMP WITH TIME ZONE, "validePar" character varying, "valideLe" TIMESTAMP WITH TIME ZONE, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e3a15526075762e79fac313b496" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f92cbae62a95024277ad4cc727" ON "etat_bourse" ("mois") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ligne_bourse" ("id" SERIAL NOT NULL, "etatId" integer NOT NULL, "volontaireId" uuid NOT NULL, "nomComplet" character varying NOT NULL, "categorie" character varying, "departementId" integer, "etablissement" character varying, "vague" character varying, "telephone" character varying, "montant" integer NOT NULL, "mois" integer NOT NULL DEFAULT '1', "total" integer NOT NULL, "observation" character varying, CONSTRAINT "PK_647738393ce661b25cfde29fc9a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_892ad61ad6f4a9a694697292e7" ON "ligne_bourse" ("etatId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_573a8fc98ebf7ebad07b26755d" ON "ligne_bourse" ("volontaireId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_573a8fc98ebf7ebad07b26755d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_892ad61ad6f4a9a694697292e7"`,
    );
    await queryRunner.query(`DROP TABLE "ligne_bourse"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f92cbae62a95024277ad4cc727"`,
    );
    await queryRunner.query(`DROP TABLE "etat_bourse"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3b33ac2d154da669b0da10ab9e"`,
    );
    await queryRunner.query(`DROP TABLE "mouvement_volontaire"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5680eb2ea04b9153bbc9e9b1c0"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6c0a47bd3136eaab8d6c97023c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_002388604c923bdcd0bdb4a1a9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_21a432f91c75736904515230ff"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_feae034e29d43fa298481e24a7"`,
    );
    await queryRunner.query(`DROP TABLE "volontaire"`);
  }
}
