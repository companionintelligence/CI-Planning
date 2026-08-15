import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  mobility, isAutoPlaced, isReflowCandidate, MOBILITY_RANK,
  AUTO_PLACED_SQL, REFLOW_CANDIDATE_SQL,
} from '../src/engine/mobility.js';
import { clearDayAutoBlocks, moveBlockGroup } from '../src/services/blocks.js';
import { resetDb } from './helpers.js';

/**
 * Focus × Time Blocks, Phase 6 — the mobility ladder.
 *
 * Owner decisions 2 and 3: tasks move first, Time Blocks hold their slots, and a
 * user's container move carries its members. That was already the engine's shape,
 * spread across five near-identical WHERE clauses; this phase gives it one home.
 *
 * The load-bearing test here is the SQL ≡ function equivalence: a shared constant
 * alone would not catch someone hand-editing a query, but a matrix asserting the
 * embedded SQL and the in-memory twin select the SAME rows will.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

beforeEach(() => { resetDb(); });

/** Every combination the ladder distinguishes, as real rows. */
const MATRIX: { label: string; row: Record<string, unknown> }[] = [
  { label: 'auto agent task', row: { is_auto: 1, block_kind: 'task', source_kind: 'agent', is_locked: 0 } },
  { label: 'auto agent task, locked', row: { is_auto: 1, block_kind: 'task', source_kind: 'agent', is_locked: 1 } },
  { label: 'manual task', row: { is_auto: 0, block_kind: 'task', source_kind: 'manual', is_locked: 0 } },
  { label: 'manual task, locked', row: { is_auto: 0, block_kind: 'task', source_kind: 'manual', is_locked: 1 } },
  { label: 'time block', row: { is_auto: 0, block_kind: 'timeblock', source_kind: 'manual', is_locked: 0 } },
  { label: 'time block, auto', row: { is_auto: 1, block_kind: 'timeblock', source_kind: 'agent', is_locked: 0 } },
  { label: 'synced meeting (locked)', row: { is_auto: 0, block_kind: 'meeting', source_kind: 'gcal', is_locked: 1 } },
  { label: 'meeting, unlocked', row: { is_auto: 0, block_kind: 'meeting', source_kind: 'gcal', is_locked: 0 } },
  { label: 'pattern placement', row: { is_auto: 1, block_kind: 'task', source_kind: 'pattern', is_locked: 0 } },
  { label: 'break', row: { is_auto: 1, block_kind: 'break', source_kind: 'agent', is_locked: 0 } },
];

function insert(over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    owner_id: OWNER, title: 'B', block_kind: 'task',
    start_at: at('10:00'), end_at: at('11:00'),
    is_auto: 0, is_locked: 0, source_kind: 'manual', status: 'planned', ...over,
  };
  const keys = Object.keys(row);
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`)
    .get(...keys.map((k) => row[k])) as { id: string }).id;
}

describe('mobility() — which rung a block sits on', () => {
  it('anything the owner locked is fixed, whatever else it is', () => {
    expect(mobility({ is_locked: 1, block_kind: 'task', is_auto: 1, source_kind: 'agent' })).toBe('fixed');
    expect(mobility({ is_locked: true, block_kind: 'timeblock' })).toBe('fixed');
  });

  it('a synced meeting is fixed even if a mirror somehow landed unlocked', () => {
    // Phase 1 locks every inbound mirror at ingest; the kind guard is defence in depth,
    // mirroring the client's isImmovable.
    expect(mobility({ block_kind: 'meeting', is_locked: 0 })).toBe('fixed');
  });

  it('a Time Block holds its slot', () => {
    expect(mobility({ block_kind: 'timeblock', is_locked: 0 })).toBe('holds');
  });

  it('an agent auto placement is the loosest rung', () => {
    expect(mobility({ is_auto: 1, block_kind: 'task', source_kind: 'agent', is_locked: 0 })).toBe('auto');
  });

  it('a hand-placed task moves last among movable things', () => {
    expect(mobility({ is_auto: 0, block_kind: 'task', source_kind: 'manual', is_locked: 0 })).toBe('manual');
  });

  it('a pattern placement is not the agent’s to reclaim', () => {
    // source_kind distinguishes them; only 'agent' output is reflow's own.
    expect(mobility({ is_auto: 1, block_kind: 'task', source_kind: 'pattern', is_locked: 0 })).toBe('manual');
  });

  it('ranks loosest-first, so a scheduler can sort rather than re-derive', () => {
    expect(MOBILITY_RANK.auto).toBeLessThan(MOBILITY_RANK.manual);
    expect(MOBILITY_RANK.manual).toBeLessThan(MOBILITY_RANK.holds);
    expect(MOBILITY_RANK.holds).toBeLessThan(MOBILITY_RANK.fixed);
  });

  it('reflow candidacy is exactly the loosest rung', () => {
    for (const { row } of MATRIX) {
      expect(isReflowCandidate(row)).toBe(mobility(row) === 'auto');
    }
  });
});

describe('the SQL and its in-memory twin agree', () => {
  // This is what actually stops the five copies drifting: hand-edit either side and
  // the matrix disagrees.
  it('AUTO_PLACED_SQL selects exactly the rows isAutoPlaced() accepts', () => {
    const ids = new Map(MATRIX.map(({ label, row }) => [insert(row), { label, row }]));
    const selected = new Set(
      (sqlite.prepare(`SELECT id FROM time_blocks WHERE owner_id = ? AND ${AUTO_PLACED_SQL}`)
        .all(OWNER) as { id: string }[]).map((r) => r.id),
    );
    for (const [id, { label, row }] of ids) {
      expect(selected.has(id), `${label}: SQL and isAutoPlaced disagree`).toBe(isAutoPlaced(row));
    }
    expect(selected.size).toBeGreaterThan(0); // the matrix must actually exercise it
  });

  it('REFLOW_CANDIDATE_SQL selects exactly the rows isReflowCandidate() accepts', () => {
    const ids = new Map(MATRIX.map(({ label, row }) => [insert(row), { label, row }]));
    const selected = new Set(
      (sqlite.prepare(`SELECT id FROM time_blocks WHERE owner_id = ? AND ${REFLOW_CANDIDATE_SQL}`)
        .all(OWNER) as { id: string }[]).map((r) => r.id),
    );
    for (const [id, { label, row }] of ids) {
      expect(selected.has(id), `${label}: SQL and isReflowCandidate disagree`).toBe(isReflowCandidate(row));
    }
    expect(selected.size).toBeGreaterThan(0);
  });

  it('the candidate predicate is strictly narrower than the identity one', () => {
    const lockedAuto = insert({ is_auto: 1, block_kind: 'task', source_kind: 'agent', is_locked: 1 });
    const auto = sqlite.prepare(`SELECT id FROM time_blocks WHERE ${AUTO_PLACED_SQL}`).all() as { id: string }[];
    const cand = sqlite.prepare(`SELECT id FROM time_blocks WHERE ${REFLOW_CANDIDATE_SQL}`).all() as { id: string }[];
    expect(auto.map((r) => r.id)).toContain(lockedAuto);
    expect(cand.map((r) => r.id)).not.toContain(lockedAuto);
  });
});

describe('the ladder holds when the engine actually sweeps a day', () => {
  it('reflow never moves a Time Block, a locked block, or a synced event — only its own auto placements', async () => {
    // Everything overlaps the same window, so nothing survives by being out of range.
    const timeBlock = insert({ block_kind: 'timeblock', title: 'Deep work' });
    const lockedAuto = insert({ is_auto: 1, source_kind: 'agent', is_locked: 1, title: 'Pinned' });
    const synced = insert({ block_kind: 'meeting', source_kind: 'gcal', is_locked: 1, title: 'Standup' });
    const manual = insert({ title: 'Hand placed' });
    const movable = insert({ is_auto: 1, source_kind: 'agent', title: 'Agent placed' });

    const res = await clearDayAutoBlocks(OWNER, DAY);
    expect(res.removedCount).toBe(1);

    const alive = new Set(
      (sqlite.prepare(`SELECT id FROM time_blocks WHERE owner_id = ?`).all(OWNER) as { id: string }[]).map((r) => r.id),
    );
    expect(alive.has(timeBlock)).toBe(true);
    expect(alive.has(lockedAuto)).toBe(true);
    expect(alive.has(synced)).toBe(true);
    expect(alive.has(manual)).toBe(true);
    expect(alive.has(movable)).toBe(false);
  });
});

describe('decision 3 — a container move carries its members', () => {
  it('members ride along on a group move, keeping the container intact', async () => {
    const container = insert({ block_kind: 'timeblock', start_at: at('12:00'), end_at: at('14:00') });
    const memberA = insert({ parent_block_id: container, start_at: at('12:15'), end_at: at('13:00') });
    const memberB = insert({ parent_block_id: container, start_at: at('13:00'), end_at: at('13:45') });
    const loose = insert({ start_at: at('12:30'), end_at: at('13:30') });

    const res = await moveBlockGroup(OWNER, container, 30);
    expect(res.ok).toBe(true);

    const startOf = (id: string) =>
      (sqlite.prepare(`SELECT start_at FROM time_blocks WHERE id = ?`).get(id) as { start_at: string }).start_at;
    expect(startOf(container)).toBe(at('12:30'));
    expect(startOf(memberA)).toBe(at('12:45'));
    expect(startOf(memberB)).toBe(at('13:30'));
    // A block that merely overlaps is not part of the group.
    expect(startOf(loose)).toBe(at('12:30'));
  });

  it('moving a MEMBER moves the whole group — the container is the unit', async () => {
    const container = insert({ block_kind: 'timeblock', start_at: at('12:00'), end_at: at('14:00') });
    const member = insert({ parent_block_id: container, start_at: at('12:15'), end_at: at('13:00') });

    const res = await moveBlockGroup(OWNER, member, 15);
    expect(res.ok).toBe(true);

    const startOf = (id: string) =>
      (sqlite.prepare(`SELECT start_at FROM time_blocks WHERE id = ?`).get(id) as { start_at: string }).start_at;
    expect(startOf(container)).toBe(at('12:15'));
    expect(startOf(member)).toBe(at('12:30'));
  });
});
