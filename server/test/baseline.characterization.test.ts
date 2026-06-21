import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import { makeNormalizer } from './normalize.js';

/**
 * BEHAVIOR BASELINE (consolidation pass — characterization tests).
 *
 * Golden snapshots of the read-API serialization, the Auto placement engine, and
 * the schema shape, captured on `main` (post-#70). The consolidation pass must
 * reproduce these:
 *
 *  - **CON-1 (UUIDv7)** is a pure refactor → these snapshots must stay green
 *    *unchanged* (ids are normalized to positional tokens, so int→uuid is
 *    invisible here; the schema snapshot proves no table/column was lost).
 *  - **CON-2/3/4** are behavior-preserving → green, except where a step
 *    *intentionally* changes output (e.g. CON-2 renames `block_type` values
 *    `plan→scheduled`). Such a change updates the golden in the same PR as a
 *    reviewed diff. An *unexplained* diff is a regression.
 *
 * See docs/consolidation-plan.md and docs/con-1-uuidv7-design.md.
 */

// CON-1: the single owner's id is the fixed UUIDv7 sentinel after migration 0030
// (the legacy integer `1` is remapped to it). API reads are scoped by
// currentOwnerId() === SYSTEM_OWNER, so the fixture must own its rows as SYSTEM_OWNER.
// Snapshots normalize owner ids to referent tokens, so this is invisible to the golden.
const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const MIDNIGHT = `${DAY}T00:00:00.000Z`;

const snap = (b: unknown) => makeNormalizer()(b);
const snapOrdered = (a: unknown) => makeNormalizer({ sortArrays: false })(a);

/** Insert a row into an id-bearing table; returns the new id. */
function insert(table: string, row: Record<string, unknown>): string {
  const keys = Object.keys(row);
  // CON-1: id columns are TEXT NOT NULL — mint a UUIDv7 via the registered uuid7()
  // UDF. Prepended as a SQL literal so the row's own keys still map 1:1 to the `?`
  // placeholders. (Snapshots are id-normalized, so this is invisible to the golden.)
  const stmt = sqlite.prepare(
    `INSERT INTO ${table} (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`,
  );
  return (stmt.get(...keys.map((k) => row[k])) as { id: string }).id;
}
/** Insert a row into a join/composite-key table (no surrogate id). */
function insertNoId(table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  // resetDb keeps owner/prefs/scheduled_jobs/pattern_types. Make the rest hermetic
  // so suite ordering can't perturb the baseline: clear staging/grouping tables,
  // drop any custom pattern types other tests leaked (keep the built-ins), and pin
  // the prefs that influence the read surfaces back to their defaults.
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns; DELETE FROM block_templates;`);
  sqlite.exec(`DELETE FROM pattern_types WHERE is_builtin = 0;`);
  // timezone = 'UTC' (not NULL): summary's day-window + lazy placement resolve the
  // day in this tz; NULL falls back to the *system* tz, which makes the block-count
  // boundary (a concept at midnight-UTC) env-dependent. Pin it so CI == local.
  sqlite.prepare(
    `UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 1, enable_rituals = 0 WHERE owner_id = ?`,
  ).run(OWNER);
});

// A representative dataset touching every FK + serializer CON-1 will migrate.
function seedApiFixture(): void {
  const work = insert('tags', { name: 'work' });
  const errands = insert('tags', { name: 'errands' });

  const spec = insert('tasks', { title: 'Write spec', owner_id: OWNER, status: 'open', priority: 2, estimated_minutes: 45, scheduled_for: DAY });
  const post = insert('tasks', { title: 'Post office', owner_id: OWNER, status: 'open', priority: 3, estimated_minutes: 30, due_at: at('17:00') });
  insert('tasks', { title: 'Spec subtask', owner_id: OWNER, status: 'open', priority: 3, parent_id: spec });
  insert('tasks', { title: 'Daily standup', owner_id: OWNER, status: 'open', priority: 3, recurrence_rule: 'FREQ=DAILY', recurrence_dtstart: at('09:30') });
  const meditate = insert('tasks', { title: 'Meditate', owner_id: OWNER, status: 'open', priority: 3, estimated_minutes: 10, is_habit: 1 });
  insert('tasks', { title: 'Old task', owner_id: OWNER, status: 'done', priority: 4, completed_at: at('08:00') });

  insertNoId('task_tags', { task_id: spec, tag_id: work });
  insertNoId('task_tags', { task_id: post, tag_id: errands });
  insertNoId('task_dependencies', { task_id: post, depends_on_id: spec }); // Post office blocked by Write spec

  const plan = insert('time_blocks', { title: 'Work block', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', start_at: at('09:00'), end_at: at('12:00'), is_auto: 0, source_kind: 'manual', status: 'planned' });
  insert('time_blocks', { task_id: spec, title: 'Write spec', block_kind: 'task', parent_block_id: plan, start_at: at('09:00'), end_at: at('09:45'), is_auto: 0, source_kind: 'manual', status: 'planned' });
  insert('time_blocks', { title: 'Read paper', block_kind: 'timeblock', block_type: 'someday', tag: 'work', goal_start_date: DAY, duration_minutes: 60, all_day: 1, start_at: MIDNIGHT, end_at: at('01:00'), source_kind: 'manual', status: 'planned' });
  insert('time_blocks', { title: 'Standup mtg', block_kind: 'meeting', start_at: at('13:00'), end_at: at('13:30'), is_locked: 1, is_auto: 0, source_kind: 'gcal', source_ref: 'evt-123', status: 'planned' });

  const routineType = (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Routine'`).get() as { id: string }).id;
  const pattern = insert('patterns', { owner_id: OWNER, type_id: routineType, name: 'Morning routine', tag: 'morning' });
  insertNoId('pattern_tasks', { pattern_id: pattern, task_id: meditate, position: 0 });

  insertNoId('flight_plan', { owner_id: OWNER, task_id: post, selected: 1, position: 0 });
  insertNoId('flight_plan', { owner_id: OWNER, task_id: meditate, source_pattern_id: pattern, selected: 0, position: 1 });

  insert('block_templates', { owner_id: OWNER, name: 'Deep work', tag: 'work', default_minutes: 90 });
  insert('possible_tasks', { raw_title: 'Maybe call dentist', source_kind: 'gmail', source_ref: 'msg-1', status: 'pending', proposed_priority: 3 });
}

describe('behavior baseline — read API serialization', () => {
  it('serializes the canonical read surfaces stably (id/ts-normalized)', async () => {
    seedApiFixture();
    const get = async (path: string) => snap((await api(srv.url, path)).body);

    expect(await get('/api/tasks')).toMatchSnapshot('GET /api/tasks');
    expect(await get('/api/tasks?status=done')).toMatchSnapshot('GET /api/tasks?status=done');
    expect(await get(`/api/blocks?from=${MIDNIGHT}&to=${at('23:59')}`)).toMatchSnapshot('GET /api/blocks');
    expect(await get('/api/patterns')).toMatchSnapshot('GET /api/patterns');
    expect(await get('/api/pattern-types')).toMatchSnapshot('GET /api/pattern-types');
    expect(await get('/api/flight-plan')).toMatchSnapshot('GET /api/flight-plan');
    expect(await get('/api/tags')).toMatchSnapshot('GET /api/tags');
    expect(await get('/api/block-templates')).toMatchSnapshot('GET /api/block-templates');
    expect(await get('/api/possible-tasks')).toMatchSnapshot('GET /api/possible-tasks');

    // Summary stats only — the briefing/focus text can be LLM-backed (non-deterministic).
    const summary = (await api(srv.url, `/api/summary?date=${DAY}`)).body as { stats: unknown };
    expect(snap(summary.stats)).toMatchSnapshot('GET /api/summary (stats)');
  });
});

describe('behavior baseline — Auto placement engine', () => {
  it('places Plans-first then the workday fallback, deterministically', () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone='UTC', workday_start='09:00', workday_end='18:00', auto_fill_workday=1 WHERE owner_id=?`).run(OWNER);

    const plan = insert('time_blocks', { title: 'work plan', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', start_at: at('09:00'), end_at: at('12:00'), is_auto: 0, source_kind: 'manual', status: 'planned' });
    const work = insert('tags', { name: 'work' });
    const code = insert('tasks', { title: 'Write code', owner_id: OWNER, status: 'open', estimated_minutes: 60, priority: 2 });
    const milk = insert('tasks', { title: 'Buy milk', owner_id: OWNER, status: 'open', estimated_minutes: 30, priority: 3 });
    const loose = insert('tasks', { title: 'Loose end', owner_id: OWNER, status: 'open', estimated_minutes: 45, priority: 4 });
    insertNoId('task_tags', { task_id: code, tag_id: work }); // 'work' → routed into the Plan
    for (const t of [code, milk, loose]) insertNoId('flight_plan', { owner_id: OWNER, task_id: t, selected: 1, position: 0 });

    const result = placeFlightPlan(OWNER, { date: DAY });
    expect(snap(result)).toMatchSnapshot('placeFlightPlan result');

    const agent = sqlite
      .prepare(`SELECT title, start_at, end_at, block_kind, parent_block_id, is_auto, source_kind, status FROM time_blocks WHERE source_kind='agent' ORDER BY start_at, title`)
      .all();
    expect(snapOrdered(agent)).toMatchSnapshot('agent blocks (placement order)');
    expect(plan).toBeTruthy();
  });
});

describe('behavior baseline — schema shape', () => {
  it('preserves every table and column name (CON-1 changes id TYPE only)', () => {
    const tables = (sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name`)
      .all() as { name: string }[]).map((t) => t.name);
    const shape = tables.map((t) => ({
      table: t,
      columns: (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name),
    }));
    expect(shape).toMatchSnapshot('schema: tables + column names');
  });
});
