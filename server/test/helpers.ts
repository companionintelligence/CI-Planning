import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { embed, generate, status } from '../src/mcp/ollama.js';
import { setInstalledModels } from '../src/lib/models.js';
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
    DELETE FROM possible_task_people;
    DELETE FROM entity_tags;
    DELETE FROM entity_categories;
    DELETE FROM entity_people;
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
    -- 0149: classification_log is append-only by design (durable learning evidence,
    -- the twin of triality_log) — same cross-test contamination argument as
    -- triality_log above. classification_exemplars and classification_accuracy are
    -- derived/measured state keyed by (owner, field, date), so a row left behind by
    -- one test file collides with or leaks into another's on that key.
    DELETE FROM classification_log;
    DELETE FROM classification_exemplars;
    DELETE FROM classification_accuracy;
    DELETE FROM copy_history;
    DELETE FROM life_priorities;
    DELETE FROM planning_sessions;
    -- 0162: plan_revision_log/plan_loop_runs are append-only by design (the §A0
    -- authoring loop's evidence) — same cross-test contamination argument as
    -- calibration_history above.
    DELETE FROM plan_revision_log;
    DELETE FROM plan_loop_runs;
    DELETE FROM plan_loop_stats;
    -- 0157: append-only evidence log (the dismissal-learning corpus) — same
    -- cross-test contamination argument as classification_log/triality_log above.
    DELETE FROM possible_outcome_log;
    -- 0157: rollup is read by a production path (the extraction prompt), so a
    -- leftover row would silently bend another test file's prompt.
    DELETE FROM possible_dismissal_exemplars;
    -- 0157: measurement is appended per (owner, computed_date) run; clear so a
    -- backdated reading from one test doesn't collide with the next test's.
    DELETE FROM possible_dismissal_rate;
    -- 0165: append-only weekly balance snapshot (first-freeze-wins, UNIQUE(owner_id,
    -- week_start, category)) — same cross-test contamination argument as
    -- calibration_history/triality_log/possible_outcome_log above: a leftover row for
    -- the same (owner, week, category) would silently no-op a later test's insert.
    DELETE FROM balance_week_log;
  `);
  // Prune any extra owners a multi-tenant isolation test created, so they don't
  // leak across the shared pid-keyed DB into later files (resetDb kept only the
  // system owner before). Clear owner-scoped tables first — several `owner_id` FKs are NO-ACTION:
  // scheduling_prefs, tag_prefs (owner_id), patterns and pattern_types. patterns before pattern_types
  // (patterns.type_id), pattern_tasks cascades off patterns.
  // 0151: keep each owner's SELF row (account_id = owner_id) — it is owner scaffolding
  // seeded by the migration, exactly like scheduling_prefs, and the "me" shortcut has
  // nothing to point at without it. Everything a test created goes.
  sqlite.exec(`DELETE FROM people WHERE account_id IS NULL OR account_id <> owner_id`);
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
      sleep_hours_per_week = 63,
      capacity_hours_per_week = 56,
      balance_bias_enabled = 1;
  `);
}

/**
 * 0156 — OPT-IN placement baseline. The deterministic "an undirected task lands
 * somewhere in the workday" default used to come from the `workday_start`/
 * `workday_end` prefs resetDb pinned to 09:00-18:00. That pref is gone: Auto's
 * fallback fill now reads the union of the **work** and **community** directions'
 * `pattern_blocks` windows instead. This seeds the equivalent 09:00-18:00 window for
 * both builtin day types.
 *
 * Deliberately NOT called from resetDb, even though production's `provisionOwner`
 * really does seed base direction tags + default windows for every owner: resetDb
 * wipes `tags`, and a large family of tag-vocabulary tests depends on that blank
 * slate (they create their own `work` tag — UNIQUE(owner_id, name) — or assert on
 * exact tag lists). Placement-focused files call this explicitly in their own
 * beforeEach instead; a file needing different windows just seeds its own.
 */
export function seedFallbackFillWindow(ownerId: string = SYSTEM_OWNER): void {
  for (const name of ['work', 'community']) {
    sqlite
      .prepare(`INSERT OR IGNORE INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'direction')`)
      .run(ownerId, name);
    const tagId = (sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ?`).get(ownerId, name) as { id: string }).id;
    for (const dayType of ['workday', 'weekend']) {
      sqlite
        .prepare(
          `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
           VALUES (uuid7(), ?, ?, ?, '09:00', '18:00')`,
        )
        .run(ownerId, tagId, dayType);
    }
  }
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

/**
 * Prime the installed-model cache from the live probe, so `isReady()` — and the production
 * gates built on it — answer truthfully for the duration of one test. Returns a restore fn.
 *
 * status() deliberately skips setInstalledModels() under NODE_ENV=test, which is what keeps
 * the rest of the suite on its deterministic degrade path. The side effect is that
 * isInstalled() is false for every model here, so `status().ready` and isReady() are
 * structurally false — and a test named for an LLM path silently gets the fallback instead.
 * plan.ts's authorPlanOrder gates on isReady() (2e713fa, which replaced the old
 * `available` predicate), so it returned 'deterministic' every time. ollama.ts names
 * setInstalledModels() as the sanctioned way in for tests that need the real answer.
 *
 * Capabilities are left empty, which is safe rather than merely convenient: callers gate on
 * ollamaAvailable() first, so every configured model is installed, and resolveConfiguredDetailed
 * returns a configured-and-installed model as 'default' before it ever consults the
 * capability-based auto-selector (models.ts:238). Priming therefore cannot change WHICH model
 * runs — only whether isReady() tells the truth about it. Were that order to change, an empty
 * capability list would stop generationCandidates() excluding 'thinking' models, which return
 * "" under format:json.
 *
 * ALWAYS restore in a finally — a leaked cache turns auto-selection on for whatever runs next.
 */
export async function primeInstalledModels(): Promise<() => void> {
  const s = await status();
  setInstalledModels(s.models.map((name) => ({ name, capabilities: [], paramB: null })));
  return () => setInstalledModels(null);
}

/**
 * Bound how many fixture emails a single Gmail ingest processes, for the tests that run
 * one for real against Ollama.
 *
 * The fixture client rebases emails.json into the last few days (rebaseEmailsToRecent),
 * so the baseline's 7-day window now takes in all 24 — each one a real generation at
 * tier 'quality', which runs past even a 300s budget. One day always holds at least the
 * newest message, since the rebase lands it inside 24h by construction, so this bounds
 * the cost without making the assertion vacuous.
 *
 * Deliberately not folded into resetDb(): ingest-windows.test.ts asserts the baseline
 * still reports the shipped 7-day default.
 */
export function boundEmailLookbackToOneDay(): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET email_lookback_days = 1`).run();
}

/**
 * Is `want` present in `installed`, tolerating a missing tag — `nomic-embed-text`
 * matches installed `nomic-embed-text:latest`. Same rule as matchInstalled() in
 * src/lib/models.ts, reimplemented against the raw name list on purpose: status()
 * deliberately skips setInstalledModels() under NODE_ENV=test (see its "Never
 * auto-select during tests" note), so the shared cache is null and isInstalled() /
 * s.missingModels report false-negative for everything here.
 */
function hasModel(installed: string[], want: string | null | undefined): boolean {
  if (!want) return false;
  const w = want.trim().toLowerCase();
  if (!w) return false;
  return installed.some((m) => {
    const n = m.toLowerCase();
    return n === w || n.split(':')[0] === w;
  });
}

/**
 * Per-probe budget below. Generous on purpose: it has to cover a COLD model load on a
 * healthy box (tens of seconds for a large quality model), because skipping a suite that
 * would actually have passed is the worse error of the two. Past this it is not a slow
 * box, it is a box that cannot run these tests.
 *
 * `hookTimeout` in vitest.config.ts must clear THREE of these, since several suites spend
 * this call from `beforeAll` and a healthy-but-cold box pays each probe in turn. If the
 * hook is killed first the suite fails instead of skipping, which is what the probe exists
 * to prevent. The two move together.
 */
const OLLAMA_PROBE_TIMEOUT_MS = 45_000;

let _ollamaUp: boolean | null = null;
/**
 * Cached Ollama readiness so LLM-dependent tests can skip when the service, the models,
 * or the machine itself cannot actually serve them.
 *
 * Reachability and model presence are necessary but NOT sufficient, and treating them as
 * sufficient is what made this gate lie. On a box where another process holds the GPU the
 * daemon still answers and still lists every model, so the gate said "up", the suites ran,
 * and every generation then timed out. That used to hide behind the old ingest fallback —
 * a timeout became a title-only stub, so `possibles > 0` and the test passed without a
 * single real extraction having happened. Now that an outage correctly DEFERS instead of
 * stubbing, the same condition surfaces as a bare assertion failure: honest, but pointing
 * at the wrong thing, because the code under test is fine and the box simply cannot serve it.
 *
 * Hence the last check exercises all THREE capabilities the presence check above already
 * promises — a fast generation, a quality generation, and an embedding. Symmetry is the
 * point: proving one model serves proves nothing about the other two, and the failure
 * this guards against is precisely a box that can load ONE more model and then thrashes.
 * `think: false` stops a thinking-capable model spending a whole budget reasoning about a
 * one-word prompt. Probes run in sequence and stop at the first failure, so a box that
 * cannot serve pays one budget, not three.
 *
 * A passing probe also leaves the models warm, which is a real side-benefit: the cold load
 * is paid here, inside a hook sized for it, instead of inside the first test that happens
 * to need it and is timed as though the model were already resident.
 */
export async function ollamaAvailable(): Promise<boolean> {
  if (_ollamaUp === null) {
    const s = await status();
    const present =
      s.available &&
      hasModel(s.models, s.fastModel) &&
      hasModel(s.models, s.qualityModel) &&
      hasModel(s.models, s.embedModel);
    if (!present) {
      _ollamaUp = false;
    } else {
      const probes: [string, () => Promise<boolean>][] = [
        ['fast generation', async () =>
          (await generate('Reply with the single word: ok', {
            tier: 'fast', timeoutMs: OLLAMA_PROBE_TIMEOUT_MS, think: false,
          })).trim().length > 0],
        ['quality generation', async () =>
          (await generate('Reply with the single word: ok', {
            tier: 'quality', timeoutMs: OLLAMA_PROBE_TIMEOUT_MS, think: false,
          })).trim().length > 0],
        ['embedding', async () => (await embed('ok', OLLAMA_PROBE_TIMEOUT_MS)).length > 0],
      ];
      _ollamaUp = true;
      for (const [what, run] of probes) {
        try {
          if (await run()) continue;
          // Reachable, in budget, and still useless — an empty answer would surface
          // downstream as a baffling assertion rather than an outage.
          throw new Error('returned an empty result');
        } catch (err) {
          // Names the capability that failed, so a developer whose LLM suites all skipped
          // can tell it was the machine and not their change — the one condition the old
          // gate could not distinguish from a healthy run.
          //
          // Worth knowing where this actually shows up: the gated suites use
          // `if (!up) return;`, so a skipped test PASSES, and vitest's default reporter
          // hides console output for a file that passed. It surfaces under
          // `--reporter=verbose` and in a CI log, but NOT in a plain local run — where the
          // symptom is instead an LLM suite that finishes suspiciously fast. Making those
          // skips render as skips means moving five suites off that idiom onto
          // `ctx.skip()`, which is a separate change from fixing the gate.
          console.warn(
            `[test] Ollama is reachable and the models are installed, but a ${what} probe ` +
              `did not succeed within ${OLLAMA_PROBE_TIMEOUT_MS}ms — skipping LLM-dependent ` +
              `suites. Usually another process is holding the GPU. (${(err as Error).message})`,
          );
          _ollamaUp = false;
          break;
        }
      }
    }
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
  // 0151: the owner's own `people` row, mirroring provisionOwner. Without it
  // selfPersonId() is undefined for this tenant and the motivation projection can't
  // tell "me" from "them".
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO people (id, owner_id, account_id, display_name, confirmed, source)
       VALUES (uuid7(), ?, ?, ?, 1, 'account')`,
    )
    .run(id, id, name);
  return id;
}

/** Create a 2nd owner (thin alias; T1/T2 extend with owned domain rows). */
export function seedSecondOwnerData(id: string = SECOND_OWNER_ID): string {
  return createOwner(id);
}

