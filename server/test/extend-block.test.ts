/**
 * Phase Z · Z3 (Time-Sense) — "Keep working" block extension (§1.1a).
 *
 * The engine is pure deterministic scheduler logic: silent fit when a gap
 * absorbs the overflow, a minimal forward cascade when it collides (pushing the
 * residual and stopping at the first absorbing gap), and escalation to blockedBy
 * when a fixed entity can't be displaced. The route adds the flag gate + the
 * confirm-before-moving contract. Pinned times, TZ=UTC.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { extendBlock } from '../src/engine/extend-block.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const D = '2026-06-15';
const at = (hhmm: string) => `${D}T${hhmm}:00.000Z`;

/** Hand-seed an open placement_log row for a block, mirroring placement-capture.test.ts's
 *  helper — extendBlock never places anything itself, so its tests seed the row directly. */
function openPlacementLog(blockId: string, startAt: string, endAt: string): void {
  sqlite
    .prepare(
      `INSERT INTO placement_log
         (id, owner_id, block_id, task_id, slot_key, auto_run_id,
          chosen_start_at, chosen_end_at, chosen_hour, fit, candidates, placed_at, local_date)
       VALUES (uuid7(), ?, ?, NULL, 'work', NULL, ?, ?, ?, 1, '[]', ?, ?)`,
    )
    .run(SYSTEM_OWNER, blockId, startAt, endAt, Number(startAt.slice(11, 13)), startAt, D);
}
function openPlacementRow(blockId: string): { moved_at: string | null; moved_start_at: string | null; moved_end_at: string | null; moved_hour: number | null } | undefined {
  return sqlite
    .prepare(`SELECT moved_at, moved_start_at, moved_end_at, moved_hour FROM placement_log WHERE block_id = ?`)
    .get(blockId) as { moved_at: string | null; moved_start_at: string | null; moved_end_at: string | null; moved_hour: number | null } | undefined;
}

function makeBlock(opts: {
  start: string; end: string; kind?: string; type?: string | null; parent?: string | null;
  locked?: boolean; status?: string; task?: string | null; title?: string;
}): string {
  return (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, block_type, parent_block_id, start_at, end_at, is_locked, status, task_id, owner_id)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      opts.title ?? 'B', opts.kind ?? 'task', opts.type ?? null, opts.parent ?? null,
      at(opts.start), at(opts.end),
      opts.locked ? 1 : 0, opts.status ?? 'planned', opts.task ?? null, SYSTEM_OWNER,
    ) as { id: string }).id;
}
function endOf(id: string): string {
  return (sqlite.prepare(`SELECT end_at FROM time_blocks WHERE id = ?`).get(id) as { end_at: string }).end_at;
}
function startOf(id: string): string {
  return (sqlite.prepare(`SELECT start_at FROM time_blocks WHERE id = ?`).get(id) as { start_at: string }).start_at;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('extendBlock engine (§1.1a)', () => {
  it('silent fit when a gap absorbs the overflow', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    makeBlock({ start: '12:00', end: '12:30' }); // plenty of room
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(true);
    expect(r.movedSet).toHaveLength(0);
    expect(r.committed).toBe(true);
    expect(endOf(b)).toBe(at('11:30'));
  });

  it('pushes only the residual and stops at the first absorbing gap', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const b1 = makeBlock({ start: '11:15', end: '11:45', title: 'B1' }); // 15m gap before it
    const b2 = makeBlock({ start: '12:00', end: '12:30', title: 'B2' });
    // +30 → new end 11:30. B1 starts 11:15 (< 11:30) → collides, pushed by the
    // residual 15m to 11:30–12:00. Frontier 12:00; B2 starts 12:00 → absorbed, untouched.
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(true);
    expect(r.movedSet.map((m) => m.block_id)).toEqual([b1]);
    expect(startOf(b1)).toBe(at('11:30'));
    expect(endOf(b1)).toBe(at('12:00'));
    expect(startOf(b2)).toBe(at('12:00')); // untouched — the gap absorbed the shift
  });

  it('chains a multi-block cascade when each collides in turn', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const b1 = makeBlock({ start: '11:00', end: '11:30', title: 'B1' });
    const b2 = makeBlock({ start: '11:30', end: '12:00', title: 'B2' });
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER); // new end 11:30
    expect(r.movedSet.map((m) => m.block_id)).toEqual([b1, b2]);
    expect(startOf(b1)).toBe(at('11:30'));
    expect(startOf(b2)).toBe(at('12:00'));
  });

  it('escalates to blockedBy and writes nothing when a meeting blocks it', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const m = makeBlock({ start: '11:00', end: '11:30', kind: 'meeting', title: 'Lunch with Dana' });
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(false);
    expect(r.committed).toBe(false);
    expect(r.blockedBy?.block_id).toBe(m);
    expect(r.blockedBy?.title).toBe('Lunch with Dana');
    expect(r.movedSet).toHaveLength(0);
    expect(endOf(b)).toBe(at('11:00')); // unchanged
  });

  it('treats locked and in-progress blocks as fixed', async () => {
    const b1 = makeBlock({ start: '10:00', end: '11:00' });
    makeBlock({ start: '11:00', end: '11:30', locked: true });
    expect((await extendBlock(b1, 30, {}, SYSTEM_OWNER)).fits).toBe(false);

    resetDb();
    const b2 = makeBlock({ start: '10:00', end: '11:00' });
    makeBlock({ start: '11:00', end: '11:30', status: 'in_progress' });
    expect((await extendBlock(b2, 30, {}, SYSTEM_OWNER)).fits).toBe(false);
  });

  it('treats a following focus block as fixed (never silently pushed) — #392 edge', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const f = makeBlock({ start: '11:00', end: '11:45', kind: 'focus', title: 'Deep work' });
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(false);
    expect(r.committed).toBe(false);
    expect(r.blockedBy?.block_id).toBe(f);
    expect(r.blockedBy?.title).toBe('Deep work');
    expect(r.movedSet).toHaveLength(0);
    expect(endOf(b)).toBe(at('11:00'));    // unchanged
    expect(startOf(f)).toBe(at('11:00'));  // focus session not moved
  });

  it('treats a following habit block as fixed — #392 edge', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const h = makeBlock({ start: '11:00', end: '11:30', kind: 'habit', title: 'Meditation' });
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(false);
    expect(r.blockedBy?.block_id).toBe(h);
    expect(r.movedSet).toHaveLength(0);
    expect(startOf(h)).toBe(at('11:00'));  // habit not moved
  });

  it('does NOT treat break/buffer padding as an obstacle (stays loose → silent fit)', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    // A break block overlapping the window: it is not in the obstacle query, so it is
    // neither surfaced nor moved — the extension fits silently straight over it.
    makeBlock({ start: '11:00', end: '11:15', kind: 'break', title: 'Break' });
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(true);
    expect(r.movedSet).toHaveLength(0);
    expect(endOf(b)).toBe(at('11:30'));
  });

  it('ignores completed/skipped following blocks (not obstacles)', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    makeBlock({ start: '11:00', end: '11:30', status: 'completed' });
    const r = await extendBlock(b, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(true);
    expect(r.movedSet).toHaveLength(0);
    expect(endOf(b)).toBe(at('11:30'));
  });

  it('commit:false is a pure dry run — no writes', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const b1 = makeBlock({ start: '11:00', end: '11:30' });
    const r = await extendBlock(b, 30, { commit: false }, SYSTEM_OWNER);
    expect(r.fits).toBe(true);
    expect(r.committed).toBe(false);
    expect(r.movedSet).toHaveLength(1);
    expect(endOf(b)).toBe(at('11:00')); // unchanged
    expect(startOf(b1)).toBe(at('11:00')); // unchanged
  });

  it('rejects non-positive minutes and unknown blocks', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    await expect(extendBlock(b, 0, {}, SYSTEM_OWNER)).rejects.toThrow();
    await expect(extendBlock('nope', 10, {}, SYSTEM_OWNER)).rejects.toThrow();
  });
});

describe('POST /api/blocks/:id/extend (flag-gated confirm flow)', () => {
  it('404s when Time-Sense is off', async () => {
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const res = await api(srv.url, `/api/blocks/${b}/extend`, { method: 'POST', json: { minutes: 10 } });
    expect(res.status).toBe(404);
  });

  it('silent fit commits immediately', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const res = await api(srv.url, `/api/blocks/${b}/extend`, { method: 'POST', json: { minutes: 10 } });
    expect(res.status).toBe(200);
    expect(res.body.committed).toBe(true);
    expect(endOf(b)).toBe(at('11:10'));
  });

  it('a move needs confirm: first call previews, second applies', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const b = makeBlock({ start: '10:00', end: '11:00' });
    const b1 = makeBlock({ start: '11:00', end: '11:30' });

    const preview = await api(srv.url, `/api/blocks/${b}/extend`, { method: 'POST', json: { minutes: 30 } });
    expect(preview.body.fits).toBe(true);
    expect(preview.body.committed).toBe(false);
    expect(preview.body.movedSet).toHaveLength(1);
    expect(endOf(b)).toBe(at('11:00')); // preview didn't write

    const applied = await api(srv.url, `/api/blocks/${b}/extend`, { method: 'POST', json: { minutes: 30, confirm: true } });
    expect(applied.body.committed).toBe(true);
    expect(endOf(b)).toBe(at('11:30'));
    expect(startOf(b1)).toBe(at('11:30'));
  });

  it('a blocked extension returns blockedBy and never writes, even with confirm', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const b = makeBlock({ start: '10:00', end: '11:00' });
    makeBlock({ start: '11:00', end: '11:30', kind: 'meeting', title: 'Standup' });
    const res = await api(srv.url, `/api/blocks/${b}/extend`, { method: 'POST', json: { minutes: 30, confirm: true } });
    expect(res.body.fits).toBe(false);
    expect(res.body.blockedBy.title).toBe('Standup');
    expect(endOf(b)).toBe(at('11:00'));
  });
});

describe('POST /api/blocks/:id/reschedule ("Schedule again", §1.1b)', () => {
  function makeScheduledTask(): string {
    return (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'Unfinished', ?, 'scheduled') RETURNING id`)
      .get(SYSTEM_OWNER) as { id: string }).id;
  }
  function flightRow(taskId: string) {
    return sqlite
      .prepare(`SELECT source_kind, selected FROM flight_plan WHERE owner_id = ? AND task_id = ?`)
      .get(SYSTEM_OWNER, taskId) as { source_kind: string; selected: number } | undefined;
  }
  function statusOf(id: string): string {
    return (sqlite.prepare(`SELECT status FROM time_blocks WHERE id = ?`).get(id) as { status: string }).status;
  }
  function taskStatus(id: string): string {
    return (sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string }).status;
  }

  it('404s when Time-Sense is off', async () => {
    const t = makeScheduledTask();
    const b = makeBlock({ start: '10:00', end: '11:00', task: t });
    expect((await api(srv.url, `/api/blocks/${b}/reschedule`, { method: 'POST' })).status).toBe(404);
  });

  it('skips the block, re-stages the same task (source_kind=reschedule), reopens it', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const t = makeScheduledTask();
    const b = makeBlock({ start: '10:00', end: '11:00', task: t });

    const res = await api(srv.url, `/api/blocks/${b}/reschedule`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.staged).toBe(true);
    expect(statusOf(b)).toBe('skipped');       // attempt 1 is history
    expect(taskStatus(t)).toBe('open');         // reopened for Auto to re-place
    const fp = flightRow(t);
    expect(fp?.source_kind).toBe('reschedule'); // the §5 metric key
    expect(fp?.selected).toBe(1);               // staged, not placed
  });

  it('422s a block with no task', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const b = makeBlock({ start: '10:00', end: '11:00', kind: 'timeblock' });
    expect((await api(srv.url, `/api/blocks/${b}/reschedule`, { method: 'POST' })).status).toBe(422);
  });

  it('422s a recurring-instance task (re-lands via its rule, not reschedule)', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const parent = makeScheduledTask();
    const inst = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, recurrence_parent_id) VALUES (uuid7(), 'Daily', ?, 'scheduled', ?) RETURNING id`)
      .get(SYSTEM_OWNER, parent) as { id: string }).id;
    const b = makeBlock({ start: '10:00', end: '11:00', task: inst });
    expect((await api(srv.url, `/api/blocks/${b}/reschedule`, { method: 'POST' })).status).toBe(422);
    expect(statusOf(b)).toBe('planned'); // rejected before any write
  });

  it('422s an already-done task (nothing to reschedule)', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const t = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'Done', ?, 'done') RETURNING id`)
      .get(SYSTEM_OWNER) as { id: string }).id;
    const b = makeBlock({ start: '10:00', end: '11:00', task: t });
    const res = await api(srv.url, `/api/blocks/${b}/reschedule`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(statusOf(b)).toBe('planned'); // not skipped
    expect(flightRow(t)).toBeUndefined(); // not staged
  });
});

// ── Review-fix regressions (adversarial review, 2026-07-03) ──────────────────────

describe('extend — Plan container / child-block correctness', () => {
  it('treats a scheduled Plan container as fixed and never shears its children', async () => {
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' });
    const c = makeBlock({ start: '11:00', end: '12:00', kind: 'timeblock', type: 'scheduled', title: 'Plan' });
    const ch = makeBlock({ start: '11:00', end: '11:30', kind: 'task', parent: c, title: 'child' });
    // +30 → newEnd 11:30. The container is the only top-level obstacle (the child is
    // excluded by parent_block_id IS NULL); a container is fixed → blockedBy, no write.
    const r = await extendBlock(a, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(false);
    expect(r.blockedBy?.block_id).toBe(c);
    expect(r.movedSet).toHaveLength(0);
    expect(endOf(a)).toBe(at('11:00'));   // unchanged
    expect(startOf(c)).toBe(at('11:00'));  // container not moved
    expect(startOf(ch)).toBe(at('11:00')); // child not sheared out
  });

  it('treats an actively-timed following block as fixed (running time_entry, not block status)', async () => {
    const t = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'T', ?, 'scheduled') RETURNING id`)
      .get(SYSTEM_OWNER) as { id: string }).id;
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' });
    const b1 = makeBlock({ start: '11:00', end: '11:30', task: t, title: 'B1' }); // planned status, but…
    // …a running timer on it (ended_at NULL) — the real "in progress" signal.
    sqlite
      .prepare(`INSERT INTO time_entries (id, owner_id, task_id, block_id, started_at, source) VALUES (uuid7(), ?, ?, ?, ?, 'timer')`)
      .run(SYSTEM_OWNER, t, b1, at('11:00'));
    const r = await extendBlock(a, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(false);          // must not silently push a block being timed
    expect(r.blockedBy?.block_id).toBe(b1);
    expect(endOf(a)).toBe(at('11:00'));   // unchanged
    expect(startOf(b1)).toBe(at('11:00')); // unchanged
  });

  it('a someday Plan (block_type=someday) is not a timeline obstacle', async () => {
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' });
    // Someday container overlapping the window but not a scheduled timeline block.
    makeBlock({ start: '11:00', end: '12:00', kind: 'timeblock', type: 'someday', title: 'Someday' });
    const r = await extendBlock(a, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.fits).toBe(true);
    expect(r.movedSet).toHaveLength(0); // someday ignored → silent fit
    expect(endOf(a)).toBe(at('11:30'));
  });
});

describe('extend route — moved blocks re-sync their task scheduling intent', () => {
  it('mirrors the new start onto a cascade-moved task block (task_time follows)', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const t = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, task_time, scheduled_for) VALUES (uuid7(), 'T', ?, 'scheduled', '11:00', ?) RETURNING id`)
      .get(SYSTEM_OWNER, D) as { id: string }).id;
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' });
    const b1 = makeBlock({ start: '11:00', end: '11:30', task: t, title: 'B1' });

    const res = await api(srv.url, `/api/blocks/${a}/extend`, { method: 'POST', json: { minutes: 30, confirm: true } });
    expect(res.body.committed).toBe(true);
    expect(res.body.movedSet.map((m: { block_id: string }) => m.block_id)).toEqual([b1]);
    expect(startOf(b1)).toBe(at('11:30')); // block moved
    const task = sqlite.prepare(`SELECT task_time FROM tasks WHERE id = ?`).get(t) as { task_time: string | null };
    expect(task.task_time).toBe('11:30'); // task intent re-synced to the moved block, not left at 11:00
  });
});

describe('extendBlock closes placement_log rows for the anchor and every cascaded block', () => {
  it('a silent-fit extension (resize only, start unchanged) closes the anchor row', async () => {
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' });
    openPlacementLog(a, at('10:00'), at('11:00'));
    await extendBlock(a, 30, { commit: true }, SYSTEM_OWNER);
    const row = openPlacementRow(a)!;
    expect(row.moved_at).not.toBeNull();
    expect(row.moved_start_at).toBe(at('10:00')); // start never changed
    expect(row.moved_end_at).toBe(at('11:30'));
    expect(row.moved_hour).toBe(10); // same hour — a resize, not a time-of-day correction
  });

  it('a cascaded block closes its row with the pushed start, not just the anchor', async () => {
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' });
    const b1 = makeBlock({ start: '11:00', end: '11:30', title: 'B1' }); // no gap, must push
    openPlacementLog(a, at('10:00'), at('11:00'));
    openPlacementLog(b1, at('11:00'), at('11:30'));
    const r = await extendBlock(a, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.movedSet.map((m) => m.block_id)).toEqual([b1]);
    expect(startOf(b1)).toBe(at('11:30'));

    const anchorRow = openPlacementRow(a)!;
    expect(anchorRow.moved_end_at).toBe(at('11:30'));

    const cascadeRow = openPlacementRow(b1)!;
    expect(cascadeRow.moved_at).not.toBeNull();
    expect(cascadeRow.moved_start_at).toBe(at('11:30')); // pushed 30m later
    expect(cascadeRow.moved_end_at).toBe(at('12:00'));
    expect(cascadeRow.moved_hour).toBe(11); // still 11:xx, just later within the hour
  });

  it('a block with no open placement_log row extends without creating one', async () => {
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' }); // never auto-placed
    const r = await extendBlock(a, 30, { commit: true }, SYSTEM_OWNER);
    expect(r.committed).toBe(true);
    expect(endOf(a)).toBe(at('11:30'));
    expect(openPlacementRow(a)).toBeUndefined();
  });

  it('a plan-only call (commit: false) never touches placement_log', async () => {
    const a = makeBlock({ start: '10:00', end: '11:00', title: 'A' });
    openPlacementLog(a, at('10:00'), at('11:00'));
    await extendBlock(a, 30, {}, SYSTEM_OWNER); // commit defaults to false
    const row = openPlacementRow(a)!;
    expect(row.moved_at).toBeNull(); // still open — nothing was actually applied
    expect(endOf(a)).toBe(at('11:00')); // unchanged
  });
});
