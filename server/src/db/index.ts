import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { runSetup } from './setup.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const sqlite = new BetterSqlite3(config.dbPath);
logger.info('SQLite database opened', { path: config.dbPath });

runSetup(sqlite);
logger.info('Schema ready');

export const db = drizzle(sqlite, { schema });
export { sqlite };
