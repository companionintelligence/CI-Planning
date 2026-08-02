import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PLANNING_ENTITIES } from './entities/index.js';
import { logger } from '../lib/logger.js';

/**
 * TypeORM DataSource for the `planning` schema — the same ORM CI-Server's API uses, so
 * data code reads the same across the two repos.
 *
 * Two settings are deliberate and should not be "helpfully" flipped:
 *
 *   synchronize: false   — dbmate owns the schema (db/postgres/migrations), exactly as
 *                          in CI-Server. `synchronize: true` would let TypeORM infer and
 *                          apply DDL from the entities at boot, which on a schema shared
 *                          with CI-Server could drop or rewrite columns it does not know
 *                          about. It is off permanently, not just in production.
 *   migrations: []       — for the same reason. dbmate is the single migration runner;
 *                          TypeORM must never open a second, competing history table.
 *
 * The entities are generated FROM the ported schema rather than being its source, so
 * they follow the same conservative typing (`text` columns typed `string`, 0/1 flags
 * typed `number`) — see the baseline migration's header for why.
 */
export function createPlanningDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    schema: 'planning',
    entities: PLANNING_ENTITIES,
    synchronize: false,
    migrations: [],
    logging: process.env.TYPEORM_LOGGING === 'true',
  });
}

let ds: DataSource | undefined;

/** Initialise once and reuse. Safe to call repeatedly. */
export async function initPlanningDataSource(url: string): Promise<DataSource> {
  if (ds?.isInitialized) return ds;
  ds = createPlanningDataSource(url);
  await ds.initialize();
  logger.info('TypeORM DataSource initialised', { schema: 'planning', entities: PLANNING_ENTITIES.length });
  return ds;
}

export function planningDataSource(): DataSource {
  if (!ds?.isInitialized) throw new Error('DataSource not initialised — call initPlanningDataSource()');
  return ds;
}

export async function closePlanningDataSource(): Promise<void> {
  if (ds?.isInitialized) await ds.destroy();
  ds = undefined;
}
