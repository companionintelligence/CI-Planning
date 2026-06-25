/**
 * Phase M C3 — possible-task dedupe: sqlite-vec KNN fast path + cosine fallback.
 *
 * Embeddings are injected via `dedupePossibles({ embedFn })` (no module mock — that
 * would collide cross-file with the other suites that mock mcp/ollama.js in vitest's
 * shared process). The key guarantee: the vec0 path and the cosine fallback mark the
 * SAME duplicates (the keep/drop decision uses the same cosine() in both). On a
 * platform where sqlite-vec can't load, forcing the vec path errors → falls back to
 * cosine → identical result.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb } from './helpers.js';
import { dedupePossibles, _setVecForTest } from '../src/agents/groom.js';

// 'Buy milk' ≈ 'Buy milk please' (cosine ≈ 0.995 ≥ 0.92); 'File taxes' orthogonal.
const embedFn = async (text: string): Promise<number[]> =>
  text.includes('milk') ? (text.includes('please') ? [0.99, 0.1, 0] : [1, 0, 0]) : [0, 1, 0];

function insertPossible(title: string): string {
  return (
    sqlite.prepare(`INSERT INTO possible_tasks (id, raw_title, status) VALUES (uuid7(), ?, 'pending') RETURNING id`).get(title) as { id: string }
  ).id;
}
const statusOf = (id: string): string =>
  (sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(id) as { status: string }).status;

describe('dedupePossibles (C3)', () => {
  beforeEach(() => { resetDb(); _setVecForTest(null); });

  it('marks a near-duplicate pending possible, keeps distinct ones', async () => {
    const a = insertPossible('Buy milk');
    const dup = insertPossible('Buy milk please');
    const t = insertPossible('File taxes');

    const r = await dedupePossibles({ embedFn });
    expect(r.available).toBe(true);
    expect(r.duplicates).toBe(1);
    // Exactly one of the two near-identical 'milk' tasks is the duplicate (whichever sorts
    // later by id); the distinct 'taxes' task is always kept. uuid7 ids minted in the same
    // millisecond aren't strictly ordered, so assert the invariant, not WHICH milk.
    expect([statusOf(a), statusOf(dup)].sort()).toEqual(['duplicate', 'pending']);
    expect(statusOf(t)).toBe('pending');
  });

  it('vec0 KNN path and cosine fallback mark the SAME duplicates', async () => {
    const a = insertPossible('Buy milk');
    const dup = insertPossible('Buy milk please');
    const t = insertPossible('File taxes');

    _setVecForTest(true); // force the vec0 path (errors → cosine fallback on platforms without it)
    const viaVec = await dedupePossibles({ embedFn });
    const vecStatuses = [statusOf(a), statusOf(dup), statusOf(t)];

    sqlite.exec(`UPDATE possible_tasks SET status = 'pending'`); // reset for the second pass
    _setVecForTest(false); // force the deterministic cosine loop
    const viaCosine = await dedupePossibles({ embedFn });
    const cosineStatuses = [statusOf(a), statusOf(dup), statusOf(t)];

    expect(viaVec.duplicates).toBe(1);
    expect(viaCosine.duplicates).toBe(1);
    expect(vecStatuses).toEqual(cosineStatuses); // the two paths made the SAME decision
    expect([vecStatuses[0], vecStatuses[1]].sort()).toEqual(['duplicate', 'pending']); // one milk marked
    expect(vecStatuses[2]).toBe('pending'); // 'taxes' always kept
  });

  it('fewer than 2 pending → available, nothing compared', async () => {
    insertPossible('only one');
    expect(await dedupePossibles({ embedFn })).toEqual({ compared: 0, duplicates: 0, available: true });
  });

  it('leaves no vec0 temp table behind (snapshot-safe)', async () => {
    insertPossible('Buy milk');
    insertPossible('Buy milk please');
    _setVecForTest(true);
    await dedupePossibles({ embedFn });
    const leftover = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'vec_dedupe_tmp%'`)
      .all() as { name: string }[];
    expect(leftover).toHaveLength(0);
  });
});
