import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { sqlite } from '../src/db/index.js';
import { status } from '../src/mcp/ollama.js';

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** Start the Koa app on an ephemeral port. */
export async function startTestServer(): Promise<TestServer> {
  const app = buildApp();
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
    DELETE FROM reminders;
    DELETE FROM push_subscriptions;
    DELETE FROM task_dependencies;
    DELETE FROM possible_task_tags;
    DELETE FROM entity_tags;
    DELETE FROM time_entries;
    DELETE FROM outbound_queue;
    DELETE FROM external_events;
    DELETE FROM sync_state;
    DELETE FROM connection_tokens;
    DELETE FROM time_blocks;
    DELETE FROM possible_tasks;
    DELETE FROM flight_plan;
    DELETE FROM tasks;
    DELETE FROM tags;
    DELETE FROM job_runs;
    DELETE FROM daily_summaries;
    DELETE FROM daily_plan;
    DELETE FROM plan_hints;
    DELETE FROM replan_suggestions;
    DELETE FROM day_assignments;
    DELETE FROM day_of_week_map;
    DELETE FROM reflections;
    DELETE FROM objective_tasks;
    DELETE FROM objectives;
    DELETE FROM estimate_calibration;
    DELETE FROM day_stars;
  `);
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
      auto_defense_enabled = 0;
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

