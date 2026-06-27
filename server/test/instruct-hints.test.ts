import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { placeFlightPlan, fillByPriority } from '../src/engine/autoplan.js';
import { genPrompt, constraintLine, type PlanHint } from '../src/agents/plan.js';

/**
 * Phase M A4 — enforcement of natural-language tag-window hints (the part the
 * pins-first MVP deferred). `tag_before T` / `tag_after T` become a transient per-tag
 * clock window for the day; a hinted task is placed ONLY within that window and is
 * never dropped outside it by the direction-window or workday-fill passes. `batch`
 * imposes no window (contiguity is the §A2 authored-order concern). The soft prompt
 * side is covered by the constraintLine / genPrompt unit tests at the bottom.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insertTask(title: string, est = 30, tag?: string, priority = 3): string {
  const id = (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, ?) RETURNING id`)
    .get(title, OWNER, est, priority) as { id: string }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id`).get(tag) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}
function stage(taskId: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
function addHint(kind: PlanHint['kind'], tag: string, time?: string) {
  sqlite.prepare(`INSERT INTO plan_hints (id, owner_id, date, kind, tag, time) VALUES (uuid7(), ?, ?, ?, ?, ?)`)
    .run(OWNER, DAY, kind, tag, time ?? null);
}
const agentBlocks = () =>
  sqlite.prepare(`SELECT title, start_at, end_at FROM time_blocks WHERE source_kind = 'agent' ORDER BY start_at`).all() as
    { title: string; start_at: string; end_at: string }[];
const block = (title: string) => agentBlocks().find((b) => b.title === title);

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 1 WHERE owner_id = ?`).run(OWNER);
});

describe('A4 tag-window enforcement in placement', () => {
  it('tag_after holds a tagged task out of the morning (placed only after the cutoff)', () => {
    const errand = insertTask('Post office', 60, 'errands');
    stage(errand);
    addHint('tag_after', 'errands', '12:00'); // "no errands before noon"

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placed).toBe(1);
    const blk = block('Post office')!;
    expect(blk).toBeTruthy();
    expect(blk.start_at >= at('12:00')).toBe(true); // never before noon
  });

  it('tag_before keeps a tagged task in the morning (placed only before the cutoff)', () => {
    const deep = insertTask('Deep work', 60, 'deep-work');
    stage(deep);
    addHint('tag_before', 'deep-work', '12:00'); // "deep work before noon"

    placeFlightPlan(OWNER, { date: DAY });
    const blk = block('Deep work')!;
    expect(blk).toBeTruthy();
    expect(blk.end_at <= at('12:00')).toBe(true);
  });

  it('intersects multiple hints on the same tag into one window', () => {
    const t = insertTask('Calls', 60, 'calls');
    stage(t);
    addHint('tag_after', 'calls', '10:00');
    addHint('tag_before', 'calls', '16:00'); // window = [10:00, 16:00]

    placeFlightPlan(OWNER, { date: DAY });
    const blk = block('Calls')!;
    expect(blk.start_at >= at('10:00')).toBe(true);
    expect(blk.end_at <= at('16:00')).toBe(true);
  });

  it('HARD: a contradictory/empty window leaves the task unplaced — never dropped into the fill', () => {
    const errand = insertTask('Post office', 60, 'errands');
    stage(errand);
    addHint('tag_after', 'errands', '18:00'); // window [18:00, 18:00] (= workday end) → empty

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(block('Post office')).toBeUndefined(); // NOT force-placed in the morning fill
    expect(r.placed).toBe(0);
  });

  it('only constrains the hinted tag — other tasks fill normally', () => {
    const errand = insertTask('Post office', 60, 'errands');
    const free = insertTask('Anything', 60); // untagged → unconstrained workday fill
    stage(errand); stage(free);
    addHint('tag_after', 'errands', '12:00');

    placeFlightPlan(OWNER, { date: DAY });
    expect(block('Post office')!.start_at >= at('12:00')).toBe(true);
    const freeBlk = block('Anything')!;
    expect(freeBlk).toBeTruthy();
    expect(freeBlk.start_at >= at('09:00') && freeBlk.start_at < at('12:00')).toBe(true); // free to take the morning
  });

  it('batch imposes no window — the task still places normally', () => {
    const a = insertTask('Email A', 30, 'email');
    const b = insertTask('Email B', 30, 'email');
    stage(a); stage(b);
    addHint('batch', 'email');

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placed).toBe(2); // batch is an ordering concern (§A2), not a placement gate
  });

  it('the explicit priority top-up (fillByPriority) also honours the window — no leak', () => {
    const errand = insertTask('Post office', 60, 'errands');
    stage(errand);
    addHint('tag_after', 'errands', '12:00');

    const r = fillByPriority(OWNER, { date: DAY });
    expect(r.placed).toBe(1);
    expect(block('Post office')!.start_at >= at('12:00')).toBe(true); // not force-filled into the morning
  });

  it('fillByPriority leaves a contradictory-window task unplaced (hard, like tap 2)', () => {
    const errand = insertTask('Post office', 60, 'errands');
    stage(errand);
    addHint('tag_after', 'errands', '18:00'); // empty window

    const r = fillByPriority(OWNER, { date: DAY });
    expect(block('Post office')).toBeUndefined();
    expect(r.placed).toBe(0);
  });
});

describe('A4 soft constraint line (authoring prompt)', () => {
  it('renders each hint kind into a strict-constraint line', () => {
    const hints: PlanHint[] = [
      { kind: 'tag_after', tag: 'errands', time: '12:00' },
      { kind: 'tag_before', tag: 'deep-work', time: '15:00' },
      { kind: 'batch', tag: 'email' },
    ];
    const line = constraintLine(hints);
    expect(line).toContain('schedule #errands tasks after 12:00');
    expect(line).toContain('schedule #deep-work tasks before 15:00');
    expect(line).toContain('keep #email tasks batched together');
  });

  it('is empty with no hints, and genPrompt embeds it only when present', () => {
    expect(constraintLine([])).toBe('');
    const lines = ['0: [P1] A ~30m'];
    expect(genPrompt(lines, 480, null, '')).not.toContain('Constraints');
    const withHint = genPrompt(lines, 480, null, constraintLine([{ kind: 'tag_after', tag: 'errands', time: '12:00' }]));
    expect(withHint).toContain('Constraints (honor strictly): schedule #errands tasks after 12:00.');
  });
});
