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
import * as m0021 from './0021_concept_tags.js';
import * as m0022 from './0022_template_tasks.js';
import * as m0023 from './0023_block_parent.js';
import * as m0024 from './0024_feature_flags.js';
import * as m0025 from './0025_pattern_recurrence.js';
import * as m0026 from './0026_drop_place_patterns_cron.js';
import * as m0027 from './0027_ingest_dedupe.js';
import * as m0028 from './0028_auto_fill_workday.js';
import * as m0029 from './0029_review_reschedule.js';
import * as m0030 from './0030_uuidv7_identity.js';
import * as m0031 from './0031_block_type_rename.js';
import * as m0032 from './0032_task_subtype.js';
import * as m0033 from './0033_entity_tags.js';
import * as m0034 from './0034_block_recurrence.js';
import * as m0035 from './0035_recall_keeps_pattern.js';
import * as m0036 from './0036_tag_directions.js';
import * as m0037 from './0037_pattern_blocks.js';
import * as m0038 from './0038_pattern_rename.js';
import * as m0039 from './0039_pattern_prefs.js';
import * as m0040 from './0040_pattern_default_minutes.js';
import * as m0041 from './0041_drop_task_tags.js';
import * as m0042 from './0042_fix_recurrence_subtype.js';
import * as m0043 from './0043_rename_tag_directions.js';
import * as m0044 from './0044_notifications.js';
import * as m0045 from './0045_reminder_source.js';
import * as m0046 from './0046_audit_log.js';
import * as m0047 from './0047_snapshot_job.js';
import * as m0048 from './0048_drop_habit_booleans.js';

export interface Migration {
  id: string;
  up: (db: Database) => void;
  /** Run outside the auto-transaction (manages its own tx + FK pragma). CON-1. */
  manual?: boolean;
}

/**
 * Ordered list of migrations. Explicit (not a glob / dynamic import) so order is
 * deterministic and the set is bundler-safe. Append new migrations to the end.
 */
export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0017, m0018, m0019, m0020, m0021, m0022, m0023, m0024, m0025, m0026, m0027, m0028, m0029, m0030, m0031, m0032, m0033, m0034, m0035, m0036, m0037, m0038, m0039, m0040, m0041, m0042, m0043, m0044, m0045, m0046, m0047, m0048];
