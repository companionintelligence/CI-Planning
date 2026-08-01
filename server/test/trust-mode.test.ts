import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resolveTrustPolicy, fillFlightPlanCandidates, autoScheduleOnIngest } from '../src/engine/autoplan.js';
import { promotePossibles } from '../src/agents/groom.js';
import { resetDb } from './helpers.js';

/**
 * Trust dial (TM-2/TM-3/TM-5; FTUE gaps 5 & 6). The dial is a Setting (not a glossary noun)
 * with three states resolved by `resolveTrustPolicy`; since AF-3 it gates ONLY the
 * estimate-bearing auto-block at the promotion boundary — the auto-PROMOTE facet was
 * retired (promotion is unconditional at ingestion + nightly sweep). TZ=UTC (date-sensitive).
 */
const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-22';

function setTrust(mode: 'cautious' | 'balanced' | 'hands_off'): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET trust_mode = ? WHERE owner_id = ?`).run(mode, OWNER);
}

function makeTask(title: string, opts: { est?: number | null; tag?: string } = {}): string {
  const id = (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
      .get(title, OWNER, opts.est === undefined ? 30 : opts.est) as { id: string }
  ).id;
  if (opts.tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(opts.tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, 'pattern', ?) RETURNING id`).get(opts.tag, OWNER) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}

function makePlan(tag: string, start: string, end: string): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status, owner_id)
         VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', ?, ?, ?, 0, 'manual', 'planned', ?) RETURNING id`,
      )
      .get(tag, start, end, OWNER) as { id: string }
  ).id;
}

function seedPossible(title: string, confidence: number): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status, proposed_owner_id)
         VALUES (uuid7(), ?, 'gcal', ?, ?, 'pending', ?) RETURNING id`,
      )
      .get(title, title, confidence, OWNER) as { id: string }
  ).id;
}

const stagedCount = (): number => (sqlite.prepare(`SELECT COUNT(*) c FROM flight_plan WHERE owner_id = ?`).get(OWNER) as { c: number }).c;
const stagedTitles = (): string[] =>
  (sqlite
    .prepare(`SELECT t.title FROM flight_plan f JOIN tasks t ON t.id = f.task_id WHERE f.owner_id = ? ORDER BY t.title`)
    .all(OWNER) as { title: string }[]).map((r) => r.title);
const openTaskCount = (): number => (sqlite.prepare(`SELECT COUNT(*) c FROM tasks WHERE status = 'open'`).get() as { c: number }).c;

beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
});

describe('resolveTrustPolicy (TM-2; AF-3 = auto-block only)', () => {
  it('cautious → no auto-block', () => {
    setTrust('cautious');
    expect(resolveTrustPolicy(OWNER)).toEqual({ mode: 'cautious', autoBlock: false });
  });
  it('balanced (default) → no auto-block', () => {
    setTrust('balanced');
    expect(resolveTrustPolicy(OWNER)).toEqual({ mode: 'balanced', autoBlock: false });
  });
  it('hands_off → auto-block', () => {
    setTrust('hands_off');
    expect(resolveTrustPolicy(OWNER)).toEqual({ mode: 'hands_off', autoBlock: true });
  });
  it('missing prefs row → safe balanced default', () => {
    expect(resolveTrustPolicy('00000000-0000-0000-0000-000000000000')).toEqual({ mode: 'balanced', autoBlock: false });
  });
});

describe('fillFlightPlanCandidates requireEstimate (TM-3)', () => {
  it('stages only estimate-bearing tasks when requireEstimate is set', () => {
    makeTask('Has estimate', { est: 45 });
    makeTask('No estimate', { est: null });

    const added = fillFlightPlanCandidates(OWNER, { requireEstimate: true });
    expect(added).toBe(1);
    expect(stagedTitles()).toEqual(['Has estimate']);
  });
  it('stages all candidates without the flag (byte-compatible default)', () => {
    makeTask('Has estimate', { est: 45 });
    makeTask('No estimate', { est: null });

    const added = fillFlightPlanCandidates(OWNER);
    expect(added).toBe(2);
    expect(stagedCount()).toBe(2);
  });
});

describe('promotePossibles is unconditional (AF-3 — promotion facet deliberately changed)', () => {
  it('cautious no longer withholds promotion', async () => {
    setTrust('cautious');
    seedPossible('Send invoice', 0.95);
    const r = await promotePossibles();
    expect(r.promoted).toBe(1);
    expect(openTaskCount()).toBe(1);
  });
  it('low-confidence items promote too — no threshold gate', async () => {
    setTrust('balanced');
    seedPossible('Send invoice', 0.95);
    seedPossible('Maybe look into X', 0.2);
    const r = await promotePossibles();
    expect(r.promoted).toBe(2);
    expect(openTaskCount()).toBe(2);
    const pendingLeft = (sqlite.prepare(`SELECT COUNT(*) c FROM possible_tasks WHERE status = 'pending'`).get() as { c: number }).c;
    expect(pendingLeft).toBe(0);
  });
  it('carries the proposed start/estimate columns onto the swept task (shared promotePossible core)', async () => {
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status, proposed_owner_id,
                                     proposed_estimated_minutes, proposed_scheduled_for, proposed_task_time)
         VALUES (uuid7(), 'Straggler', 'text', 's1#0', 0.4, 'pending', ?, 45, '2026-06-23', '14:30')`,
      )
      .run(OWNER);
    await promotePossibles();
    const t = sqlite
      .prepare(`SELECT estimated_minutes, scheduled_for, task_time FROM tasks WHERE title = 'Straggler'`)
      .get() as { estimated_minutes: number; scheduled_for: string; task_time: string };
    expect(t).toEqual({ estimated_minutes: 45, scheduled_for: '2026-06-23', task_time: '14:30' });
  });
  it('poison isolation: one failing row is left pending, the rest sweep (no wrapping transaction)', async () => {
    // An existing task already claims (gcal, poison#0) — the 0027 partial UNIQUE on
    // tasks(source_kind, source_ref) makes the swept INSERT throw for that row only.
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, source_kind, source_ref) VALUES (uuid7(), 'Claimed', ?, 'open', 'gcal', 'poison#0')`)
      .run(OWNER);
    seedPossible('Healthy item', 0.9); // helper: kind gcal, ref = title — no collision
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status, proposed_owner_id)
         VALUES (uuid7(), 'Poison item', 'gcal', 'poison#0', 0.9, 'pending', ?)`,
      )
      .run(OWNER);

    const r = await promotePossibles();
    expect(r.promoted).toBe(1);
    expect(r.failed).toBe(1);
    expect(sqlite.prepare(`SELECT id FROM tasks WHERE title = 'Healthy item'`).get()).toBeDefined();
    const poison = sqlite
      .prepare(`SELECT status FROM possible_tasks WHERE raw_title = 'Poison item'`)
      .get() as { status: string };
    expect(poison.status).toBe('pending'); // left for triage, sweep not wedged
  });
});

describe('hands-off auto-block places estimate-bearing work only (TM-5)', () => {
  it('places a tag-matched estimate-bearing task, leaves an estimate-less one unplaced', () => {
    setTrust('hands_off');
    const plan = makePlan('errands', `${DATE}T16:00:00.000Z`, `${DATE}T18:00:00.000Z`);
    makeTask('Buy stamps', { est: 30, tag: 'errands' });
    makeTask('Vague errand', { est: null, tag: 'errands' });

    autoScheduleOnIngest(OWNER, { date: DATE, requireEstimate: true });

    const blocks = sqlite
      .prepare(`SELECT title, parent_block_id FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1`)
      .all() as { title: string; parent_block_id: string | null }[];
    expect(blocks.map((b) => b.title)).toEqual(['Buy stamps']);
    expect(blocks[0].parent_block_id).toBe(plan);
    // The estimate-less task was never staged, so it stays in the backlog.
    expect((sqlite.prepare(`SELECT status FROM tasks WHERE title = 'Vague errand'`).get() as { status: string }).status).toBe('open');
  });
});
