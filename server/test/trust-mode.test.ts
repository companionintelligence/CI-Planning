import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resolveTrustPolicy, fillFlightPlanCandidates, autoScheduleOnIngest } from '../src/engine/autoplan.js';
import { promotePossibles } from '../src/agents/groom.js';
import { resetDb } from './helpers.js';

/**
 * Trust dial (TM-2/TM-3/TM-5; FTUE gaps 5 & 6). The dial is a Setting (not a glossary noun)
 * with three states resolved by `resolveTrustPolicy`; it gates auto-promotion and the
 * estimate-bearing-only auto-block at the promotion boundary. TZ=UTC (date-sensitive).
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
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name, kind) VALUES (uuid7(), ?, 'pattern') RETURNING id`).get(opts.tag) as { id: string };
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
         VALUES (uuid7(), ?, 'gmail', ?, ?, 'pending', ?) RETURNING id`,
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

describe('resolveTrustPolicy (TM-2)', () => {
  it('cautious → no auto-promote, no auto-block', () => {
    setTrust('cautious');
    expect(resolveTrustPolicy(OWNER)).toMatchObject({ mode: 'cautious', autoPromote: false, autoBlock: false });
  });
  it('balanced (default) → auto-promote, no auto-block', () => {
    setTrust('balanced');
    expect(resolveTrustPolicy(OWNER)).toMatchObject({ mode: 'balanced', autoPromote: true, autoBlock: false, promoteThreshold: 0.7 });
  });
  it('hands_off → auto-promote and auto-block', () => {
    setTrust('hands_off');
    expect(resolveTrustPolicy(OWNER)).toMatchObject({ mode: 'hands_off', autoPromote: true, autoBlock: true });
  });
  it('missing prefs row → safe balanced default', () => {
    expect(resolveTrustPolicy('00000000-0000-0000-0000-000000000000')).toMatchObject({ mode: 'balanced', autoBlock: false });
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

describe('promotePossibles is dial-aware (TM-5)', () => {
  it('cautious → promotes nothing (all kept pending)', () => {
    setTrust('cautious');
    seedPossible('Send invoice', 0.95);
    const r = promotePossibles();
    expect(r.promoted).toBe(0);
    expect(r.keptPending).toBe(1);
    expect(openTaskCount()).toBe(0);
  });
  it('balanced → auto-promotes a high-confidence item', () => {
    setTrust('balanced');
    seedPossible('Send invoice', 0.95);
    const r = promotePossibles();
    expect(r.promoted).toBe(1);
    expect(openTaskCount()).toBe(1);
  });
  it('an explicit threshold override still promotes even under cautious (test escape hatch)', () => {
    setTrust('cautious');
    seedPossible('Send invoice', 0.95);
    const r = promotePossibles({ threshold: 0.7 });
    expect(r.promoted).toBe(1);
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
