import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';

/**
 * L02-first placement ordering (Focus × Time Blocks).
 *
 * The plan's order is "matching Time Block with room first, then L01 windows, then
 * unplaced", where a match is BOTH coordinates — direction and life-balance category
 * (decision 4). Phase 5 shipped that rule for CREATE time; the autoscheduler kept
 * placing into bare windows, because its Plan passes ask narrower questions and both
 * require `block_type = 'scheduled'`.
 *
 * Every fixture here therefore uses a container with **block_type NULL** — the shape
 * the Element wizard does not produce but every other creation path does, and the one
 * the existing Plan passes cannot see. The last describe covers the wizard's shape too,
 * so a change that fixed one and broke the other cannot pass.
 *
 * `auto_fill_workday` is OFF throughout: a generic workday fill would place these tasks
 * anyway and make a broken container pass look like a working one.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22'; // a Monday → day type 'workday'
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16);

function tagIdOf(name: string, kind: 'direction' | 'category'): string {
  const found = sqlite
    .prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = ?`)
    .get(OWNER, name, kind) as { id: string } | undefined;
  if (found) return found.id;
  return (sqlite
    .prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(name, OWNER, kind) as { id: string }).id;
}

/** An L01 direction window for the workday day type. */
function seedWindow(direction: string, start: string, end: string): void {
  sqlite
    .prepare(
      `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
       VALUES (uuid7(), ?, ?, 'workday', ?, ?)`,
    )
    .run(OWNER, tagIdOf(direction, 'direction'), start, end);
}

/**
 * A Time Block container. `blockType` defaults to NULL — the shape created outside the
 * Element wizard, which is precisely what the Plan passes filter out.
 */
function container(opts: {
  tag?: string | null;
  categories?: string[];
  start: string;
  end: string;
  blockType?: string | null;
  title?: string;
}): string {
  const id = (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, block_type, tag, start_at, end_at,
                                is_auto, is_locked, source_kind, status)
       VALUES (uuid7(), ?, ?, 'timeblock', ?, ?, ?, ?, 0, 0, 'manual', 'planned')
       RETURNING id`,
    )
    .get(
      OWNER,
      opts.title ?? 'Deep work',
      opts.blockType ?? null,
      opts.tag === undefined ? 'work' : opts.tag,
      at(opts.start),
      at(opts.end),
    ) as { id: string }).id;
  (opts.categories ?? []).forEach((name, position) => {
    sqlite
      .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('time_block', ?, ?, ?)`)
      .run(id, tagIdOf(name, 'category'), position);
  });
  return id;
}

/** A staged, open task with a direction and (optionally) life-balance categories. */
function stageTask(
  title: string,
  opts: { direction?: string | null; categories?: string[]; est?: number } = {},
): string {
  const id = (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority)
       VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`,
    )
    .get(title, OWNER, opts.est ?? 60) as { id: string }).id;
  const direction = opts.direction === undefined ? 'work' : opts.direction;
  if (direction) {
    sqlite
      .prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
      .run(id, tagIdOf(direction, 'direction'));
  }
  (opts.categories ?? []).forEach((name, position) => {
    sqlite
      .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, ?)`)
      .run(id, tagIdOf(name, 'category'), position);
  });
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`)
    .run(OWNER, id);
  return id;
}

/** Where a task's auto-placed block landed, and what it nested into. */
function placement(title: string): { parent: string | null; start: string; end: string } | undefined {
  const row = sqlite
    .prepare(
      `SELECT b.parent_block_id, b.start_at, b.end_at FROM time_blocks b
         JOIN tasks t ON t.id = b.task_id
        WHERE t.title = ? AND b.block_kind = 'task'
        ORDER BY b.start_at LIMIT 1`,
    )
    .get(title) as { parent_block_id: string | null; start_at: string; end_at: string } | undefined;
  return row && { parent: row.parent_block_id, start: hhmm(row.start_at), end: hhmm(row.end_at) };
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM flight_plan; DELETE FROM pattern_blocks; DELETE FROM entity_categories;');
  sqlite
    .prepare(
      `UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00',
              auto_fill_workday = 0 WHERE owner_id = ?`,
    )
    .run(OWNER);
  // Work hours span the whole day, so a task landing inside the container is a real
  // preference and not the only slot available.
  seedWindow('work', '09:00', '18:00');
});

describe('a matching Time Block takes the task before the bare L01 window does', () => {
  it('nests the task into a container the Plan passes cannot see', async () => {
    const tb = container({ tag: 'work', categories: ['career'], start: '13:00', end: '15:00' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placement('write the RFC');
    expect(p, 'the task was not placed at all').toBeDefined();
    expect(p!.parent, 'placed in the bare window instead of the matching Time Block').toBe(tb);
    expect(p!.start >= '13:00' && p!.end <= '15:00').toBe(true);
  });

  it('leaves the task in the window when the CATEGORY does not match', async () => {
    // Same container, same direction — only the life-balance coordinate differs. If
    // this nested, "both coordinates" would be a lie and the test above would prove
    // nothing about the rule.
    container({ tag: 'work', categories: ['career'], start: '13:00', end: '15:00' });
    stageTask('book the dentist', { direction: 'work', categories: ['health'] });

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placement('book the dentist');
    expect(p, 'the task was not placed at all').toBeDefined();
    expect(p!.parent).toBeNull();
  });

  it('leaves the task in the window when the DIRECTION does not match', async () => {
    seedWindow('home', '18:00', '23:00');
    container({ tag: 'home', categories: ['career'], start: '13:00', end: '15:00' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    expect(placement('write the RFC')!.parent).toBeNull();
  });

  it('never claims a task for a container carrying no direction', async () => {
    container({ tag: null, categories: ['career'], start: '13:00', end: '15:00' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    expect(placement('write the RFC')!.parent).toBeNull();
  });

  it('matches on direction alone when the container states no category', async () => {
    // The owner's rule: a container with no categories carries only one coordinate.
    const tb = container({ tag: 'work', start: '13:00', end: '15:00' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    expect(placement('write the RFC')!.parent).toBe(tb);
  });
});

describe('the fallbacks the plan spells out', () => {
  it('falls back to the L01 window when the Time Block is FULL — never extends it', async () => {
    // Decision 7: the block's span is the owner's stated budget. A locked block fills
    // the container completely, so the 60-minute task cannot fit inside it.
    const tb = container({ tag: 'work', categories: ['career'], start: '13:00', end: '15:00' });
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_auto, is_locked, source_kind, status, parent_block_id)
         VALUES (uuid7(), ?, 'already booked', 'task', ?, ?, 0, 1, 'manual', 'planned', ?)`,
      )
      .run(OWNER, at('13:00'), at('15:00'), tb);
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placement('write the RFC');
    expect(p, 'a full container should hand the task to L01, not swallow it').toBeDefined();
    expect(p!.parent).toBeNull();
    // …and the container was not stretched to make room.
    const span = sqlite.prepare(`SELECT start_at, end_at FROM time_blocks WHERE id = ?`).get(tb) as { start_at: string; end_at: string };
    expect([hhmm(span.start_at), hhmm(span.end_at)]).toEqual(['13:00', '15:00']);
  });

  it('tries the next matching container when the tightest one is full', async () => {
    const full = container({ tag: 'work', categories: ['career'], start: '13:00', end: '14:00', title: 'tight' });
    const roomy = container({ tag: 'work', categories: ['career'], start: '15:00', end: '17:30', title: 'roomy' });
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_auto, is_locked, source_kind, status, parent_block_id)
         VALUES (uuid7(), ?, 'already booked', 'task', ?, ?, 0, 1, 'manual', 'planned', ?)`,
      )
      .run(OWNER, at('13:00'), at('14:00'), full);
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    expect(placement('write the RFC')!.parent).toBe(roomy);
  });

  it('refuses to guess between two equally tight containers', async () => {
    // The create-time rule leaves an ambiguous block loose rather than picking one; the
    // engine says the same thing by handing the task to L01.
    container({ tag: 'work', categories: ['career'], start: '10:00', end: '12:00', title: 'a' });
    container({ tag: 'work', categories: ['career'], start: '14:00', end: '16:00', title: 'b' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    expect(placement('write the RFC')!.parent).toBeNull();
  });

  it('prefers the tightest container when they differ', async () => {
    container({ tag: 'work', categories: ['career'], start: '09:00', end: '17:00', title: 'wide' });
    const tight = container({ tag: 'work', categories: ['career'], start: '13:00', end: '15:00', title: 'tight' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    expect(placement('write the RFC')!.parent).toBe(tight);
  });

  it('keeps a midnight-spanning container’s member inside the day being planned', async () => {
    // Candidates are selected by OVERLAP, so a container that started last night is a
    // real candidate for today. Placing into its full span would put a session on a day
    // this run does not own — outside the window `clearPriorAuto` sweeps, so a reflow
    // would add a second block beside it instead of moving the first.
    const overnight = (sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, block_kind, block_type, tag, start_at, end_at,
                                  is_auto, is_locked, source_kind, status)
         VALUES (uuid7(), ?, 'night shift', 'timeblock', NULL, 'work', ?, ?, 0, 0, 'manual', 'planned')
         RETURNING id`,
      )
      .get(OWNER, '2026-06-21T22:00:00.000Z', at('02:00')) as { id: string }).id;
    const taskId = stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    const first = sqlite
      .prepare(`SELECT start_at, parent_block_id FROM time_blocks WHERE task_id = ? AND block_kind = 'task'`)
      .all(taskId) as { start_at: string; parent_block_id: string | null }[];
    expect(first).toHaveLength(1);
    expect(first[0].parent_block_id).toBe(overnight);
    expect(first[0].start_at.slice(0, 10), 'placed on a day this run does not own').toBe(DAY);

    // …and re-placing it (the reflow path, which bypasses flight_plan) moves that block
    // rather than leaving a second one behind.
    await placeFlightPlan(OWNER, { date: DAY, replaceTaskIds: [taskId] });
    const after = sqlite
      .prepare(`SELECT id FROM time_blocks WHERE task_id = ? AND block_kind = 'task'`)
      .all(taskId) as { id: string }[];
    expect(after, 'a second block was left on the untouched day').toHaveLength(1);
  });

  it('leaves a direction-less task to the fallback', async () => {
    container({ tag: 'work', categories: ['career'], start: '13:00', end: '15:00' });
    stageTask('untagged thing', { direction: null, categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placement('untagged thing');
    // auto_fill_workday is off and it has no direction, so it should not be placed at
    // all — and certainly not nested on a category match alone.
    expect(p?.parent ?? null).toBeNull();
  });
});

describe('the existing Plan passes still own their shapes', () => {
  it('a wizard-shaped (block_type = scheduled) container still claims its task', async () => {
    const tb = container({ tag: 'work', start: '13:00', end: '15:00', blockType: 'scheduled' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    expect(placement('write the RFC')!.parent).toBe(tb);
  });

  it('places each task once — a task claimed by a container is not also placed in the window', async () => {
    const tb = container({ tag: 'work', categories: ['career'], start: '13:00', end: '15:00' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    await placeFlightPlan(OWNER, { date: DAY });

    const blocks = sqlite
      .prepare(
        `SELECT b.parent_block_id FROM time_blocks b JOIN tasks t ON t.id = b.task_id
          WHERE t.title = 'write the RFC' AND b.block_kind = 'task'`,
      )
      .all() as { parent_block_id: string | null }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parent_block_id).toBe(tb);
  });

  it('reports a container placement as placed-in-plans', async () => {
    container({ tag: 'work', categories: ['career'], start: '13:00', end: '15:00' });
    stageTask('write the RFC', { direction: 'work', categories: ['career'] });

    const r = await placeFlightPlan(OWNER, { date: DAY });

    expect(r.placed).toBe(1);
    expect(r.placedInPlans).toBe(1);
    expect(r.placedInWorkday).toBe(0);
  });
});
