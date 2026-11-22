import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Localisation (GPS) des écoles et de leurs bâtiments (DG, 21/11/2026) : la mission de terrain
 * prélève la position avec la tablette ; une école peut avoir une annexe ou un bâtiment ailleurs,
 * chaque bâtiment a donc aussi sa position.
 */
export class LocalisationEcoles1793760000000 implements MigrationInterface {
  name = 'LocalisationEcoles1793760000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const t of ['structure', 'batiment']) {
      await q.query(
        `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "latitude" double precision`,
      );
      await q.query(
        `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "longitude" double precision`,
      );
      await q.query(
        `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "precisionGps" real`,
      );
      await q.query(
        `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "localiseLe" TIMESTAMP WITH TIME ZONE`,
      );
      await q.query(
        `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "localisePar" character varying`,
      );
    }
    // Ce que l'équipe constate pour un agent (absent, parti, inconnu ici), à traiter par la DGRHAS
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
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "signalement_terrain"`);
    for (const t of ['structure', 'batiment'])
      for (const c of [
        'localisePar',
        'localiseLe',
        'precisionGps',
        'longitude',
        'latitude',
      ])
        await q.query(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS "${c}"`);
  }
}
