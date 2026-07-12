import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { placeFlightPlan, placeStartAnchoredTask } from '../src/engine/autoplan.js';
import { authorPlanOrder, tagGroupPostPass, type PlanTask } from '../src/agents/plan.js';
import { taskTagNames } from '../src/services/tags.js';
import { up as migrate0121 } from '../src/db/migrations/0121_task_intentions_level2.js';

/**
 * AF-11 Slices 1–3 (docs/AF11-tag-unification.md) — tasks adopt the split tag shape:
 * one primary DIRECTION at entity_tags level 1 + N INTENTION tags at level 2.
 *
 *  - Slice 1 (D1: preserve): the task-side MATCH set is L1 ∪ L2 — ?tag= filtering,
 *    autoplan Pass 1 Plan matching, NL hint windows, and day-authoring keep seeing
 *    intention tags after they move to level 2. Direction-only passes (Pass 2a
 *    windows, placeStartAnchoredTask) stay L1/kind='direction' only.
 *  - Slice 2 server half: quick-add levels its flat name list BY KIND.
 *  - Slice 2b: block/task parity — identical authored tags produce identical
 *    entity_tags rows; direction edit-clear parity (block tag:null ≡ task tags:[]).
 *  - Slice 3 (0121): task intentions L1→L2; idempotent; directions untouched.
 *    Latent-bug fix (R4): category Plans start matching tasks post-migration.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22'; // a Monday → default day-type heuristic says 'workday'
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function tagId(name: string, kind: 'intention' | 'direction'): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ?`).get(OWNER, name) as { id: string } | undefined;
  return found
    ? found.id
    : (sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(name, kind, OWNER) as { id: string }).id;
}

/** A task with explicit leveled tags (the post-split shape unless levels say otherwise). */
function insertTask(
  title: string,
  opts: { direction?: string; intentionsL2?: string[]; intentionsL1?: string[]; est?: number; priority?: number } = {},
): string {
  const id = (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, ?) RETURNING id`)
    .get(title, OWNER, opts.est ?? 30, opts.priority ?? 3) as { id: string }).id;
  const link = sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`);
  if (opts.direction) link.run(id, tagId(opts.direction, 'direction'), 1);
  for (const s of opts.intentionsL2 ?? []) link.run(id, tagId(s, 'intention'), 2);
  for (const s of opts.intentionsL1 ?? []) link.run(id, tagId(s, 'intention'), 1); // pre-migration legacy shape
  return id;
}

const stage = (taskId: string, pos = 0) =>
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`).run(OWNER, taskId, pos);

const levelRows = (kind: string, id: string) =>
  sqlite
    .prepare(
      `SELECT t.name AS name, et.level AS level FROM entity_tags et JOIN tags t ON t.id = et.tag_id
        WHERE et.entity_kind = ? AND et.entity_id = ? ORDER BY et.level, t.name`,
    )
    .all(kind, id) as { name: string; level: number }[];

async function makePlan(srv: TestServer, tag: string, start: string, end: string) {
  return (await api(srv.url, '/api/blocks', {
    method: 'POST',
    json: { title: `${tag} plan`, block_kind: 'timeblock', block_type: 'scheduled', tag, start_at: start, end_at: end },
  })).body.block;
}

const childOf = (planId: string) =>
  sqlite
    .prepare(`SELECT title, start_at FROM time_blocks WHERE parent_block_id = ? AND source_kind = 'agent' ORDER BY start_at`)
    .all(planId) as { title: string; start_at: string }[];

const taskBlocks = (taskId: string) =>
  sqlite
    .prepare(`SELECT start_at, end_at, parent_block_id FROM time_blocks WHERE task_id = ? AND block_kind = 'task' ORDER BY start_at`)
    .all(taskId) as { start_at: string; end_at: string; parent_block_id: string | null }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM tag_categories; DELETE FROM category_direction_optouts; DELETE FROM pattern_blocks;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 0 WHERE owner_id = ?`).run(OWNER);
});

// ── Slice 1 — reader compensation (D1: L1 ∪ L2) ──────────────────────────────

describe('GET /api/tasks?tag= — matches level 1 ∪ level 2', () => {
  it('finds a task by its level-2 intention AND by its level-1 direction', async () => {
    tagId('work', 'direction');
    tagId('email', 'intention');
    const created = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Send report', tags: ['work'], secondary_tags: ['email'] },
    });
    expect(created.status).toBe(201);
    const id = created.body.task.id;
    expect(levelRows('task', id)).toEqual([{ name: 'work', level: 1 }, { name: 'email', level: 2 }]);

    const byIntention = await api(srv.url, '/api/tasks?tag=email');
    expect(byIntention.body.tasks.map((t: any) => t.id)).toEqual([id]);
    const byDirection = await api(srv.url, '/api/tasks?tag=work');
    expect(byDirection.body.tasks.map((t: any) => t.id)).toEqual([id]);
    const miss = await api(srv.url, '/api/tasks?tag=nothing');
    expect(miss.body.tasks).toEqual([]);
  });
});

describe('autoplan Pass 1 — a tagged Plan still receives its intention-matched task (D1)', () => {
  it('places a task into a same-named Plan via its LEVEL-2 intention (post-migration shape)', async () => {
    const t = insertTask('Inbox zero', { direction: 'home', intentionsL2: ['email'] });
    stage(t);
    const plan = await makePlan(srv, 'email', at('09:00'), at('11:00'));
    placeFlightPlan(OWNER, { date: DAY, silent: true });
    expect(childOf(plan.id).map((b) => b.title)).toEqual(['Inbox zero']);
  });

  it('a direction-only task does NOT match an unrelated intention Plan', async () => {
    const t = insertTask('Deep work', { direction: 'work' });
    stage(t);
    const plan = await makePlan(srv, 'email', at('09:00'), at('11:00'));
    placeFlightPlan(OWNER, { date: DAY, silent: true });
    expect(childOf(plan.id)).toEqual([]);
    expect(taskBlocks(t)).toEqual([]); // auto_fill_workday=0 → nowhere else to land
  });
});

describe('NL hint windows — placeHintWindows sees level-2 intentions (D1)', () => {
  it('constrains a task via a tag_after hint on its L2 intention', async () => {
    const t = insertTask('Answer mail', { direction: 'home', intentionsL2: ['email'] });
    stage(t);
    sqlite
      .prepare(`INSERT INTO plan_hints (id, owner_id, date, kind, tag, time) VALUES (uuid7(), ?, ?, 'tag_after', 'email', '14:00')`)
      .run(OWNER, DAY);
    placeFlightPlan(OWNER, { date: DAY, silent: true });
    const blocks = taskBlocks(t);
    expect(blocks.length).toBe(1);
    expect(Date.parse(blocks[0].start_at)).toBeGreaterThanOrEqual(Date.parse(at('14:00')));
  });
});

describe('direction-only passes stay level-1 / kind=direction', () => {
  it('Pass 2a places via the DIRECTION window; an intention-only task is untouched by windows', async () => {
    const dirId = tagId('work', 'direction');
    sqlite
      .prepare(`INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time) VALUES (uuid7(), ?, ?, 'workday', '10:00', '12:00')`)
      .run(OWNER, dirId);

    const directed = insertTask('Directed', { direction: 'work', intentionsL2: ['deep'] });
    const intentionOnly = insertTask('Intention only', { intentionsL2: ['deep'] });
    stage(directed, 0);
    stage(intentionOnly, 1);
    placeFlightPlan(OWNER, { date: DAY, silent: true });

    const dBlocks = taskBlocks(directed);
    expect(dBlocks.length).toBe(1);
    expect(dBlocks[0].start_at).toBe(at('10:00')); // inside the work window
    // No direction → no window placement; workday fill is off → unplaced.
    expect(taskBlocks(intentionOnly)).toEqual([]);
  });

  it('placeStartAnchoredTask reads only the level-1 direction (L2 intentions add no windows)', () => {
    const dirId = tagId('work', 'direction');
    sqlite
      .prepare(`INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time) VALUES (uuid7(), ?, ?, 'workday', '10:00', '12:00')`)
      .run(OWNER, dirId);

    const anchored = insertTask('Anchored', { direction: 'work', intentionsL2: ['email'], est: 60 });
    sqlite.prepare(`UPDATE tasks SET scheduled_for = ? WHERE id = ?`).run(DAY, anchored);
    const placed = placeStartAnchoredTask(OWNER, anchored, { silent: true });
    expect(placed.placed).toBe(true);
    expect((placed as { startAt?: string }).startAt).toBe(at('10:00')); // the direction window

    // Same setup but only an L2 intention → falls through to the workday gap, not a window.
    const loose = insertTask('Loose', { intentionsL2: ['email'], est: 60 });
    sqlite.prepare(`UPDATE tasks SET scheduled_for = ? WHERE id = ?`).run(DAY, loose);
    const placed2 = placeStartAnchoredTask(OWNER, loose, { silent: true });
    expect(placed2.placed).toBe(true);
    expect((placed2 as { startAt?: string }).startAt).toBe(at('09:00')); // workday start fallback
  });
});

describe('day-authoring — theme matches L1 ∪ L2; clustering groups by the L1 primary', () => {
  it('a theme naming an L2 intention still leads the deterministic order', async () => {
    // DAY is a Monday; theme 'deep' applies. B carries 'deep' ONLY at level 2.
    sqlite.prepare(`UPDATE scheduling_prefs SET day_theme = ? WHERE owner_id = ?`).run(JSON.stringify({ mon: 'deep' }), OWNER);
    const a = insertTask('Alpha', { direction: 'home', priority: 1 });
    const b = insertTask('Bravo', { direction: 'work', intentionsL2: ['deep'], priority: 3 });
    stage(a, 0);
    stage(b, 1);
    await authorPlanOrder(OWNER, DAY);
    const order = sqlite
      .prepare(`SELECT task_id FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`)
      .all(OWNER, DAY) as { task_id: string }[];
    expect(order.map((r) => r.task_id)).toEqual([b, a]); // theme (via L2) outranks priority
  });

  it('tagGroupPostPass clusters by primary_tags (direction), not the widened match set', () => {
    const mk = (id: string, tags: string[], primary?: string[]): PlanTask =>
      ({ task_id: id, title: id, priority: 3, due_at: null, estimated_minutes: 30, tags, ...(primary ? { primary_tags: primary } : {}) });
    const tasks = [
      mk('A', ['work', 'email'], ['work']),
      mk('B', ['home', 'email'], ['home']),
      mk('C', ['work', 'zebra'], ['work']),
    ];
    // Grouped by direction: A and C (work) cluster; 'email' shared by A/B must not group A with B.
    expect(tagGroupPostPass([0, 1, 2], tasks)).toEqual([0, 2, 1]);
    // Fallback for pre-split literals (no primary_tags): groups by tags[0] as before.
    const legacy = [mk('X', ['email']), mk('Y', ['work']), mk('Z', ['email'])];
    expect(tagGroupPostPass([0, 1, 2], legacy)).toEqual([0, 2, 1]);
    // Direction-less tasks (primary_tags ABSENT, per getStagedTasks — never []) fall
    // back to their first intention: they must not all collapse into one '' group.
    const mixed = [
      mk('D', ['work', 'email'], ['work']), // directed
      mk('E', ['errand']),                  // direction-less: intention only
      mk('F', ['work'], ['work']),          // directed, same direction as D
      mk('G', ['errand']),                  // direction-less, same intention as E
    ];
    // 'work' group first-seen@0 → D,F cluster; 'errand' group @1 → E,G cluster.
    expect(tagGroupPostPass([0, 1, 2, 3], mixed)).toEqual([0, 2, 1, 3]);
  });

  it('authoring end-to-end: a direction-less task clusters by its L2 intention (fallback fires)', async () => {
    // Equal priorities (no rubric defects); fill_order=priority (resetDb) makes the
    // deterministic order due-date driven: A, B, C. The post-pass then pulls C (shares
    // intention 'email' with A) ahead of B. Pre-fix, every direction-less task carried
    // primary_tags: [] → groupKey '' for all three → order stayed A, B, C.
    const a = insertTask('A-mail', { intentionsL2: ['email'] });
    const b = insertTask('B-zebra', { intentionsL2: ['zebra'] });
    const c = insertTask('C-mail', { intentionsL2: ['email'] });
    const due = sqlite.prepare(`UPDATE tasks SET due_at = ? WHERE id = ?`);
    due.run(`${DAY}T10:00:00.000Z`, a);
    due.run(`${DAY}T11:00:00.000Z`, b);
    due.run(`${DAY}T12:00:00.000Z`, c);
    stage(a, 0);
    stage(b, 1);
    stage(c, 2);
    await authorPlanOrder(OWNER, DAY);
    const order = sqlite
      .prepare(`SELECT task_id FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`)
      .all(OWNER, DAY) as { task_id: string }[];
    expect(order.map((r) => r.task_id)).toEqual([a, c, b]); // email-tagged tasks contiguous
  });
});

// ── Slice 2 (server half) — quick-add levels by kind ─────────────────────────

describe('POST /api/tasks/quick — flat #tags are leveled by kind', () => {
  it('direction → L1, known intention → L2, brand-new name → L2 (created kind=intention)', async () => {
    tagId('work', 'direction');
    tagId('email', 'intention');
    const r = await api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text: 'Email Steve #work #email #newtag' } });
    expect(r.status).toBe(201);
    const id = r.body.task.id;
    expect(levelRows('task', id)).toEqual([
      { name: 'work', level: 1 },
      { name: 'email', level: 2 },
      { name: 'newtag', level: 2 },
    ]);
    // The response mirrors the leveled result, not the flat parse.
    expect(r.body.task.tags).toEqual(['work']);
    expect(r.body.task.secondary_tags.sort()).toEqual(['email', 'newtag']);
    // The new name was created as an intention (the column default).
    const kind = (sqlite.prepare(`SELECT kind FROM tags WHERE owner_id = ? AND name = 'newtag'`).get(OWNER) as { kind: string }).kind;
    expect(kind).toBe('intention');
  });
});

// ── Slice 2b — timeblock parity ───────────────────────────────────────────────

describe('block ⇄ task parity — identical authored tags, identical level rows', () => {
  it('a block (tag+secondary_tags) and a task (tags+secondary_tags) level identically', async () => {
    tagId('work', 'direction');
    tagId('email', 'intention');
    tagId('review', 'intention');
    const block = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'B', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', secondary_tags: ['email', 'review'], start_at: at('09:00'), end_at: at('10:00') },
    })).body.block;
    const task = (await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'T', tags: ['work'], secondary_tags: ['email', 'review'] },
    })).body.task;

    const strip = (rows: { name: string; level: number }[]) => rows.map((r) => `${r.level}:${r.name}`);
    expect(strip(levelRows('time_block', block.id))).toEqual(strip(levelRows('task', task.id)));
    expect(strip(levelRows('task', task.id))).toEqual(['1:work', '2:email', '2:review']);
  });

  it('direction edit-clear parity: block PATCH tag:null ≡ task PATCH tags:[] (both empty L1, keep L2)', async () => {
    tagId('work', 'direction');
    tagId('email', 'intention');
    const block = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'B', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', secondary_tags: ['email'], start_at: at('09:00'), end_at: at('10:00') },
    })).body.block;
    const task = (await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'T', tags: ['work'], secondary_tags: ['email'] },
    })).body.task;

    await api(srv.url, `/api/blocks/${block.id}`, { method: 'PATCH', json: { tag: null } });
    await api(srv.url, `/api/tasks/${task.id}`, { method: 'PATCH', json: { tags: [] } });

    expect(levelRows('time_block', block.id)).toEqual([{ name: 'email', level: 2 }]);
    expect(levelRows('task', task.id)).toEqual([{ name: 'email', level: 2 }]);
    // Partial-PATCH still preserves: an omitted `tags` keeps level 1 untouched.
    await api(srv.url, `/api/tasks/${task.id}`, { method: 'PATCH', json: { secondary_tags: ['email'] } });
    expect(levelRows('task', task.id)).toEqual([{ name: 'email', level: 2 }]);
  });
});

// ── Slice 3 — migration 0121 ──────────────────────────────────────────────────

describe('migration 0121 — task intentions move L1→L2', () => {
  it('moves ONLY task-level-1 intentions; directions stay L1; block rows untouched; idempotent', async () => {
    // Legacy pre-split task shape: direction AND intention both at level 1.
    const legacy = insertTask('Legacy', { direction: 'work', intentionsL1: ['email'] });
    // A block's L1 intention-tag row must NOT move (entity_kind filter).
    const block = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'B', block_kind: 'timeblock', block_type: 'scheduled', tag: 'email', start_at: at('09:00'), end_at: at('10:00') },
    })).body.block;

    migrate0121(sqlite);
    expect(levelRows('task', legacy)).toEqual([{ name: 'work', level: 1 }, { name: 'email', level: 2 }]);
    expect(levelRows('time_block', block.id)).toEqual([{ name: 'email', level: 1 }]);
    // The L1 read (taskTagNames) now returns exactly the direction.
    expect(taskTagNames(legacy)).toEqual(['work']);

    // Idempotent: a second run changes nothing.
    const before = levelRows('task', legacy);
    migrate0121(sqlite);
    expect(levelRows('task', legacy)).toEqual(before);
  });

  it('R4 latent-bug fix: a category Plan matches a task via its migrated L2 intention', async () => {
    const catId = (sqlite
      .prepare(`INSERT INTO tags (id, name, kind, is_base, owner_id) VALUES (uuid7(), 'family', 'category', 0, ?) RETURNING id`)
      .get(OWNER) as { id: string }).id;
    sqlite.prepare(`INSERT OR IGNORE INTO tag_categories (intention_tag_id, category_tag_id) VALUES (?, ?)`).run(tagId('kids', 'intention'), catId);

    // OLD shape: the intention sits at L1 → pre-migration, categoryCandidates (L>1) never matched.
    const t = insertTask('Plan birthday', { intentionsL1: ['kids'] });
    stage(t);
    const plan = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Category plan', block_kind: 'timeblock', block_type: 'scheduled', category_id: catId, start_at: at('14:00'), end_at: at('16:00') },
    })).body.block;

    placeFlightPlan(OWNER, { date: DAY, silent: true });
    expect(childOf(plan.id)).toEqual([]); // the latent bug: L1 intention never matched

    sqlite.prepare(`DELETE FROM time_blocks WHERE parent_block_id = ?`).run(plan.id);
    migrate0121(sqlite);
    stage(t); // placement above may have consumed the staging row
    placeFlightPlan(OWNER, { date: DAY, silent: true });
    expect(childOf(plan.id).map((b) => b.title)).toEqual(['Plan birthday']); // now it matches
  });
});
