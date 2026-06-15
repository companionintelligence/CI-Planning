import type { Database } from 'better-sqlite3';
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_columns.js';
import * as m0003 from './0003_seed_defaults.js';

export interface Migration {
  id: string;
  up: (db: Database) => void;
}

/**
 * Ordered list of migrations. Explicit (not a glob / dynamic import) so order is
 * deterministic and the set is bundler-safe. Append new migrations to the end.
 */
export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003];
