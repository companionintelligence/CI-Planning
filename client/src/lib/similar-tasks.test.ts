import { describe, it, expect } from 'vitest';
import { findSimilarTasks, titleScore, normalizeTitle } from './similar-tasks.js';
import type { Task } from './api.js';

function task(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    priority: 3, status: 'open', owner_id: 'o1', source_kind: 'manual',
    created_at: '2026-07-01T00:00:00Z', tags: [], ...over,
  } as Task;
}

describe('normalizeTitle / titleScore', () => {
  it('normalizes case + punctuation + whitespace', () => {
    expect(normalizeTitle('  Pay the INVOICE!! ')).toBe('pay the invoice');
  });
  it('exact normalized = 1, containment = 0.85, Jaccard otherwise', () => {
    expect(titleScore('Call Mom', 'call mom')).toBe(1);
    expect(titleScore('call mom', 'call mom about dinner')).toBe(0.85); // containment
    expect(titleScore('pay invoice', 'pay the invoice')).toBeCloseTo(2 / 3, 5); // Jaccard
  });
  it('unrelated one-word overlap stays low', () => {
    expect(titleScore('call mom', 'call dad')).toBeCloseTo(1 / 3, 5); // below threshold
  });
});

describe('findSimilarTasks', () => {
  const tasks = [
    task({ id: 'a', title: 'Call mom' }),
    task({ id: 'b', title: 'Call mom about dinner' }),
    task({ id: 'c', title: 'Call dad' }),
    task({ id: 'd', title: 'Pay the invoice', status: 'scheduled' }),
    task({ id: 'done', title: 'Call mom', status: 'done' }),         // terminal → excluded
    task({ id: 'sub', title: 'Call mom', parent_id: 'a' }),           // subtask → excluded
  ];

  it('finds exact + containment matches, ranked, excluding terminal + subtasks', () => {
    const r = findSimilarTasks('call mom', tasks);
    expect(r.map((s) => s.id)).toEqual(['a', 'b']); // c (call dad) below threshold; done/sub excluded
    expect(r[0].score).toBe(1);
  });

  it('excludes the currently-edited task', () => {
    const r = findSimilarTasks('call mom', tasks, { excludeId: 'a' });
    expect(r.map((s) => s.id)).toEqual(['b']);
  });

  it('returns [] for a too-short title (avoids noise while typing)', () => {
    expect(findSimilarTasks('ca', tasks)).toEqual([]);
  });

  it('returns [] when nothing is close', () => {
    expect(findSimilarTasks('water the plants', tasks)).toEqual([]);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, title: `standup ${i}` }));
    // all share 'standup' → Jaccard 1/2 = 0.5 (meets threshold)
    expect(findSimilarTasks('standup', many, { limit: 3 })).toHaveLength(3);
  });
});
