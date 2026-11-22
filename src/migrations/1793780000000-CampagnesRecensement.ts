import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recensements (DG, 22/11/2026 : « ouvrir un recensement ») : nom, année, année scolaire, début,
 * fin facultative. Les agents ajoutés, les fiches modifiées, les signalements du terrain et les
 * recenseurs sont rangés sous le recensement ouvert à ce moment.
 */
export class CampagnesRecensement1793780000000 implements MigrationInterface {
  name = 'CampagnesRecensement1793780000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS "campagne_recensement" (
      "id" SERIAL PRIMARY KEY,
      "nom" character varying NOT NULL,
      "annee" integer NOT NULL,
      "anneeScolaire" character varying,
      "debut" date NOT NULL,
      "fin" date,
      "observation" text,
      "clotureLe" TIMESTAMP WITH TIME ZONE,
      "creePar" character varying,
      "creeLe" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
    for (const [table, colonne] of [
      ['recenseur', 'campagneId'],
      ['modification_recensement', 'campagneId'],
      ['signalement_terrain', 'campagneId'],
      ['agent_recense', 'campagneRecensementId'],
    ]) {
      await q.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${colonne}" integer`,
      );
      await q.query(
        `CREATE INDEX IF NOT EXISTS "IDX_${table}_${colonne}" ON "${table}" ("${colonne}")`,
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [table, colonne] of [
      ['recenseur', 'campagneId'],
      ['modification_recensement', 'campagneId'],
      ['signalement_terrain', 'campagneId'],
      ['agent_recense', 'campagneRecensementId'],
    ])
      await q.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${colonne}"`,
      );
    await q.query(`DROP TABLE IF EXISTS "campagne_recensement"`);
  }
}
