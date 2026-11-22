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
    // La table des signalements du terrain a été ajoutée à la migration LocalisationEcoles APRÈS
    // qu'elle eut tourné en ligne : elle peut manquer. Créée ici si besoin (même définition).
    await q.query(`CREATE TABLE IF NOT EXISTS "signalement_terrain" (
      "id" SERIAL PRIMARY KEY,
      "agentId" integer NOT NULL,
      "structureId" integer NOT NULL,
      "etat" character varying NOT NULL,
      "observation" text,
      "par" character varying,
      "le" TIMESTAMP NOT NULL DEFAULT now(),
      "traite" boolean NOT NULL DEFAULT false,
      "traitePar" character varying,
      "traiteLe" TIMESTAMP WITH TIME ZONE
    )`);
    for (const c of ['agentId', 'structureId', 'traite'])
      await q.query(
        `CREATE INDEX IF NOT EXISTS "IDX_signalement_terrain_${c}" ON "signalement_terrain" ("${c}")`,
      );
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
