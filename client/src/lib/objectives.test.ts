import { describe, it, expect } from 'vitest';
import { flattenObjectives, matchObjectives } from './objectives.js';
import type { Objective } from './api.js';

// A minimal Objective factory — only the fields flattenObjectives reads matter.
function obj(id: string, title: string, level: Objective['level'], children: Objective[] = []): Objective {
  return {
    id, title, level, children,
    owner_id: 'o', parent_id: null, horizon: 'none', description: null, target_date: null,
    status: 'active', category_id: null, progress_cache: null, cadence: 'none',
    last_advanced_at: null, priority: 3, created_at: '', updated_at: '', completed_at: null,
    next_action: null, effective_target: null, pace_expected: null,
  };
}

describe('flattenObjectives', () => {
  it('flattens depth-first, parents before children, with every node linkable', () => {
    const tree = [
      obj('g1', 'Health', 'goal', [
        obj('p1', 'Run a 10k', 'project', [
          obj('o1', 'Weekly long run', 'objective'),
        ]),
      ]),
      obj('g2', 'Career', 'goal'),
    ];
    const flat = flattenObjectives(tree);
    expect(flat.map((f) => f.id)).toEqual(['g1', 'p1', 'o1', 'g2']);
    // A focus link may point at ANY level — goal/project/objective all present.
    expect(flat.map((f) => f.level)).toEqual(['goal', 'project', 'objective', 'goal']);
  });

  it('builds a › path from ancestor titles', () => {
    const tree = [obj('g1', 'Health', 'goal', [obj('p1', 'Run a 10k', 'project', [obj('o1', 'Long run', 'objective')])])];
    const flat = flattenObjectives(tree);
    expect(flat.find((f) => f.id === 'g1')!.path).toBe('');
    expect(flat.find((f) => f.id === 'p1')!.path).toBe('Health');
    expect(flat.find((f) => f.id === 'o1')!.path).toBe('Health › Run a 10k');
  });
});

describe('matchObjectives', () => {
  const flat = flattenObjectives([
    obj('g1', 'Health', 'goal', [obj('p1', 'Run a 10k', 'project')]),
    obj('g2', 'Career', 'goal'),
  ]);

  it('returns all rows for an empty query', () => {
    expect(matchObjectives(flat, '  ')).toHaveLength(3);
  });

  it('matches on title (case-insensitive)', () => {
    expect(matchObjectives(flat, 'career').map((f) => f.id)).toEqual(['g2']);
  });

  it('matches on the ancestor path', () => {
    expect(matchObjectives(flat, 'health').map((f) => f.id).sort()).toEqual(['g1', 'p1']);
  });
});
