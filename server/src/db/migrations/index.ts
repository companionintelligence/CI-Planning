import type { Database } from 'better-sqlite3';
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_columns.js';
import * as m0003 from './0003_seed_defaults.js';
import * as m0004 from './0004_task_scheduling_columns.js';
import * as m0005 from './0005_task_dependencies.js';
import * as m0006 from './0006_actual_minutes.js';
import * as m0007 from './0007_time_entries.js';
import * as m0008 from './0008_recurrence.js';

export interface Migration {
  id: string;
  up: (db: Database) => void;
}

/**
 * Ordered list of migrations. Explicit (not a glob / dynamic import) so order is
 * deterministic and the set is bundler-safe. Append new migrations to the end.
 */
export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008];
