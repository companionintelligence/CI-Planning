import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { status } from '../src/mcp/ollama.js';
// NOTE: the data facade's SQLite backend is installed by src/db/index.ts on import, so
// it is live for every test — including the many that never import this harness. Doing
// it here as well was not enough: a test that imports a service directly would still
// have hit "store not initialised".

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** Start the Koa app on an ephemeral port. */
export async function startTestServer(): Promise<TestServer> {
  const app = await buildApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Clear task-related tables; keep owner / prefs / scheduled_jobs seeded by setup. */
export function resetDb(): void {
  sqlite.exec(`
    DELETE FROM audit_log;
    DELETE FROM sync_events;
    DELETE FROM reminders;
    DELETE FROM push_subscriptions;
    DELETE FROM task_dependencies;
    DELETE FROM possible_task_tags;
    DELETE FROM entity_tags;
    DELETE FROM entity_categories;
    DELETE FROM time_entries;
    DELETE FROM outbound_queue;
    DELETE FROM external_events;
    DELETE FROM sync_state;
    DELETE FROM connection_tokens;
    DELETE FROM time_blocks;
    DELETE FROM block_templates;
    DELETE FROM possible_tasks;
    DELETE FROM flight_plan;
    DELETE FROM tasks;
    DELETE FROM tags;
    DELETE FROM job_runs;
    DELETE FROM daily_recap;
    DELETE FROM daily_plan;
    DELETE FROM plan_hints;
    DELETE FROM replan_suggestions;
    DELETE FROM day_assignments;
    DELETE FROM day_of_week_map;
    DELETE FROM reflections;
    DELETE FROM objective_tasks;
    DELETE FROM objectives;
    DELETE FROM estimate_calibration;
    -- 0138: append-only in production BY DESIGN (nothing prunes it), which makes it a
    -- cross-test contaminant unless cleared here — a backdated reading from one test
    -- collides with the next test's on the (owner, scope, date) key.
    DELETE FROM calibration_history;
    DELETE FROM calibration_combo_pins;
    -- 0140: append-only by design (the Triality learning corpus) — same
    -- cross-test contamination argument as calibration_history above.
    DELETE FROM triality_log;
    -- 0142: learned weights are derived state, but a row left behind would
    -- silently re-weight another test file's scoring (the engine reads them).
    DELETE FROM triality_weights;
    DELETE FROM copy_history;
    DELETE FROM life_priorities;
    DELETE FROM planning_sessions;
  `);
  // Prune any extra owners a multi-tenant isolation test created, so they don't
  // leak across the shared pid-keyed DB into later files (resetDb kept only the
  // system owner before). Clear owner-scoped tables first — several `owner_id` FKs are NO-ACTION:
  // scheduling_prefs, tag_prefs (owner_id), patterns and pattern_types. patterns before pattern_types
  // (patterns.type_id), pattern_tasks cascades off patterns.
  sqlite.prepare(`DELETE FROM scheduling_prefs WHERE owner_id != ?`).run(SYSTEM_OWNER);
  sqlite.prepare(`DELETE FROM tag_prefs WHERE owner_id != ?`).run(SYSTEM_OWNER);
  sqlite.prepare(`DELETE FROM patterns WHERE owner_id != ?`).run(SYSTEM_OWNER);
  sqlite.prepare(`DELETE FROM pattern_types WHERE owner_id != ?`).run(SYSTEM_OWNER);
  sqlite.prepare(`DELETE FROM owners WHERE id != ?`).run(SYSTEM_OWNER);
  // Pin the scheduling prefs that drive Auto placement / recurrence / recall back to
  // a deterministic baseline. resetDb keeps the prefs ROW, and files run in a
  // non-guaranteed order sharing one DB — so a test that leaves e.g.
  // `auto_fill_workday = 0` or a non-UTC timezone would otherwise leak into a later
  // file's Auto tests and flake them. timezone is forced to UTC (not the NULL
  // schema default → system tz) so CI == local. Tests that need other values still
  // override in their own beforeEach, which runs after this.
  sqlite.exec(`
    UPDATE scheduling_prefs SET
      timezone = 'UTC',
      workday_start = '09:00',
      workday_end = '18:00',
      auto_fill_workday = 1,
      fill_order = 'priority',
      enable_rituals = 0,
      max_focus_block_minutes = 90,
      min_break_minutes = 10,
      planning_horizon_days = 7,
      recurrence_horizon_days = 7,
      recall_keeps_pattern = 0,
      day_theme = NULL,
      planning_mode = 'basic',
      trust_mode = 'balanced',
      auto_defense_enabled = 0,
      time_sense_enabled = 0,
      focus_ritual_enabled = 1,
      haptic_cues_enabled = 1,
      ambient_color_enabled = 1,
      calibration_loop_enabled = 1,
      z_experiment_arm = NULL,
      view_prefs = NULL,
      memory_pull_enabled = 0,
      -- 0147: both windows gate what an ingest READS, so a leaked value silently
      -- resizes another file's fixture expectations (a widened memory window pulls
      -- an extra event; a narrowed email lookback filters every message away).
      memory_window_days = 2,
      email_lookback_days = 7,
      -- 0012: the Settings group (per-owner model overrides + Companion Memory PUSH).
      -- settings-models-memory.test.ts pins these in its own beforeEach but not on the
      -- way out, so its last test's successful push (sync on, account 'liam@x.io', a
      -- freshly stamped watermark) survived the file and flaked graphql-prefs' grouped
      -- shape assertion. The baseline owns them now, not the courtesy of whoever writes them.
      fast_model = NULL,
      quality_model = NULL,
      embed_model = NULL,
      memory_sync_enabled = 0,
      memory_sync_completed = 1,
      memory_sync_habits = 1,
      memory_sync_reflections = 1,
      memory_account = NULL,
      memory_last_synced_at = NULL,
      triality_enabled = 0,
      sleep_hours_per_week = 63;
  `);
}

/** Convenience JSON fetch wrapper. */
export async function api<T = any>(
  base: string,
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<{ status: number; body: T }> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${base}${path}`, {
    ...rest,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
}

let _ollamaUp: boolean | null = null;
/** Cached Ollama readiness so LLM-dependent tests can skip when service/models are unavailable. */
export async function ollamaAvailable(): Promise<boolean> {
  if (_ollamaUp === null) {
    const s = await status();
    const models = new Set(s.models);
    _ollamaUp =
      s.available &&
      models.has(s.smallModel) &&
      models.has(s.mediumModel) &&
      models.has(s.embedModel);
  }
  return _ollamaUp;
}

/** Deterministic 2nd-owner id for multi-tenant isolation tests. */
export const SECOND_OWNER_ID = '00000000-0000-7000-8000-0000000000b2';

/**
 * Create an additional owner for multi-tenant isolation tests, with a valid
 * scheduling_prefs row cloned from the system owner (so we needn't enumerate the
 * 30+ prefs columns — schema-drift-proof), timezone overridable. Returns the id.
 * Cleaned up by resetDb(), which prunes non-system owners.
 */
export function createOwner(id: string = SECOND_OWNER_ID, name = 'Owner B', tz = 'UTC'): string {
  sqlite
    .prepare(`INSERT OR IGNORE INTO owners (id, name, email) VALUES (?, ?, ?)`)
    .run(id, name, `${id}@test.local`);
  const cols = (sqlite.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map(
    (c) => c.name
  );
  if (cols.length) {
    const params: unknown[] = [];
    const sel = cols
      .map((c) => {
        if (c === 'id') return 'uuid7()'; // fresh PK — copying the source row's id PK-collides (silently swallowed by OR IGNORE)
        if (c === 'owner_id') {
          params.push(id);
          return '?';
        }
        if (c === 'timezone') {
          params.push(tz);
          return '?';
        }
        return c;
      })
      .join(', ');
    params.push(SYSTEM_OWNER); // WHERE owner_id = ?
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO scheduling_prefs (${cols.join(', ')}) SELECT ${sel} FROM scheduling_prefs WHERE owner_id = ? LIMIT 1`
      )
      .run(...params);
  }
  return id;
}

/** Create a 2nd owner (thin alias; T1/T2 extend with owned domain rows). */
export function seedSecondOwnerData(id: string = SECOND_OWNER_ID): string {
  return createOwner(id);
}

