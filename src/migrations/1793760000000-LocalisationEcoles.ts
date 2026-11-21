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
  }

  public async down(q: QueryRunner): Promise<void> {
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
