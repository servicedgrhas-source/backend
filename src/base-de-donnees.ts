import type { DataSourceOptions } from 'typeorm';
import { ENTITES } from './entities';

/**
 * Connexion à PostgreSQL, partagée par l'application et par l'outil de migrations.
 *
 * - En ligne (Supabase) : `DATABASE_URL` (« postgresql://… »), en SSL.
 * - Sur le poste : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, sans SSL.
 *
 * Les tables sont créées et modifiées par les migrations (dossier `src/migrations`),
 * jouées au démarrage. Sur le poste (base locale, DB_SYNC absent ou true), TypeORM aligne
 * les tables tout seul, comme avant. En ligne : DB_SYNC=false (ou absent avec DATABASE_URL).
 */
export function optionsBase(
  env: Record<string, string | undefined> = process.env,
): DataSourceOptions {
  const url = env.DATABASE_URL?.trim() || undefined;
  // Non précisé : comme avant sur le poste (base locale), migrations en ligne (DATABASE_URL)
  const synchronize =
    env.DB_SYNC !== undefined
      ? env.DB_SYNC === 'true'
      : !url && env.NODE_ENV !== 'production';
  // SSL : obligatoire chez Supabase ; DB_SSL=false pour une base locale donnée par URL
  const ssl =
    env.DB_SSL !== undefined
      ? env.DB_SSL === 'true'
      : !!url && !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return {
    type: 'postgres',
    ...(url
      ? { url }
      : {
          host: env.DB_HOST ?? 'localhost',
          port: Number(env.DB_PORT ?? 5432),
          username: env.DB_USER ?? 'postgres',
          password: env.DB_PASSWORD,
          database: env.DB_NAME ?? 'inrap',
        }),
    ssl: ssl ? { rejectUnauthorized: false } : false,
    entities: ENTITES,
    // gen_random_uuid() : intégré à PostgreSQL (13+), aucune extension à installer
    uuidExtension: 'pgcrypto',
    // Code compilé (dist) : les .js seulement (pas les déclarations .d.ts) ; outil (ts-node) : les .ts
    migrations: [
      `${__dirname}/migrations/*.${__filename.endsWith('.ts') ? 'ts' : 'js'}`,
    ],
    migrationsTableName: 'migrations',
    synchronize,
    migrationsRun: !synchronize,
    // Peu de connexions : le pooler de Supabase (mode session) en limite le nombre
    extra: { max: Number(env.DB_POOL_MAX ?? 5) },
  };
}
