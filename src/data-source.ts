/**
 * Source de données de l'outil de migrations TypeORM (voir les scripts « migration:* »
 * de package.json). Même connexion que l'application.
 */
import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { optionsBase } from './base-de-donnees';

config({ quiet: true });

export default new DataSource({
  ...optionsBase(),
  // L'outil compare les entités à la base : jamais d'alignement automatique ici
  synchronize: false,
  migrationsRun: false,
});
