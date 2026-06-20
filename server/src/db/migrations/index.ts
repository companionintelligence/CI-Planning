import type { Database } from 'better-sqlite3';
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_columns.js';
import * as m0003 from './0003_seed_defaults.js';
import * as m0004 from './0004_task_scheduling_columns.js';
import * as m0005 from './0005_task_dependencies.js';
import * as m0006 from './0006_actual_minutes.js';
import * as m0007 from './0007_time_entries.js';
import * as m0008 from './0008_recurrence.js';
import * as m0010 from './0010_block_all_day.js';
import * as m0011 from './0011_recurrence_job.js';
import * as m0012 from './0012_settings_models_memory.js';
import * as m0013 from './0013_patterns.js';
import * as m0014 from './0014_habit_patterns_backfill.js';
import * as m0015 from './0015_time_blocks.js';
import * as m0016 from './0016_flight_plan.js';
import * as m0017 from './0017_pattern_settings.js';
import * as m0018 from './0018_timeblock_prefs.js';
import * as m0019 from './0019_timeblock_types.js';
import * as m0020 from './0020_fast_tasks.js';

export interface Migration {
  id: string;
  up: (db: Database) => void;
}

/**
 * Ordered list of migrations. Explicit (not a glob / dynamic import) so order is
 * deterministic and the set is bundler-safe. Append new migrations to the end.
 */
export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0017, m0018, m0019, m0020];
