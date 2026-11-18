import { MigrationInterface, QueryRunner } from 'typeorm';

/** Propositions d'ajout du volet Banque mondiale : personnes et écoles (18/11/2026). */
export class PropositionsBm1793730000000 implements MigrationInterface {
  name = 'PropositionsBm1793730000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS "proposition_bm" ("id" SERIAL NOT NULL, "type" character varying NOT NULL, "donnees" jsonb NOT NULL DEFAULT '{}', "source" text, "origine" character varying, "etat" character varying NOT NULL DEFAULT 'A_CONTROLER', "faitePar" character varying, "faiteLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "controlePar" character varying, "controleLe" TIMESTAMP WITH TIME ZONE, "note" text, "resultatId" integer, CONSTRAINT "PK_proposition_bm" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_proposition_bm_type" ON "proposition_bm" ("type")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_proposition_bm_origine" ON "proposition_bm" ("origine")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_proposition_bm_etat" ON "proposition_bm" ("etat")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "proposition_bm"`);
  }
}
