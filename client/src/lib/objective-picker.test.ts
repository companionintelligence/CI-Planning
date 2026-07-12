import { describe, it, expect } from 'vitest';
import { leafObjectives, buildPickerRows, PICKER_SEARCH_THRESHOLD } from './objective-picker.js';
import type { Objective } from './api.js';

// A minimal Objective factory — only the fields the picker reads matter.
function obj(id: string, title: string, level: Objective['level'], children: Objective[] = []): Objective {
  return {
    id, title, level, children,
    owner_id: 'o', parent_id: null, horizon: 'none', description: null, target_date: null,
    status: 'active', category_id: null, progress_cache: null, cadence: 'none',
    last_advanced_at: null, priority: 3, created_at: '', updated_at: '', completed_at: null,
    next_action: null, effective_target: null, pace_expected: null, has_tasks: false,
  };
}

const tree = [
  obj('g1', 'Health', 'goal', [
    obj('p1', 'Run a 10k', 'project', [
      obj('o1', 'Weekly long run', 'objective'),
      obj('o2', 'Strength twice a week', 'objective'),
    ]),
    obj('o3', 'Sleep by 11', 'objective'),
  ]),
  obj('g2', 'Career', 'goal', [
    obj('p2', 'Ship Phase AF', 'project'),
  ]),
  obj('o4', 'Root-level errand', 'objective'),
];

describe('leafObjectives', () => {
  it('keeps only level=objective nodes — goals and projects never appear', () => {
    const leaves = leafObjectives(tree);
    expect(leaves.map((l) => l.id)).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(leaves.every((l) => l.level === 'objective')).toBe(true);
  });

  it('handles an empty tree', () => {
    expect(leafObjectives([])).toEqual([]);
  });

  it('excludes a childless non-leaf (level, not children, decides linkability)', () => {
    // p2 has no children but is a project — the server would 422 it; it must not show.
    expect(leafObjectives(tree).find((l) => l.id === 'p2')).toBeUndefined();
  });
});

describe('buildPickerRows', () => {
  it('preserves hierarchy as depth from the ancestor path', () => {
    const rows = buildPickerRows(tree, '', null);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['o1'].depth).toBe(2); // Health › Run a 10k
    expect(byId['o3'].depth).toBe(1); // Health
    expect(byId['o4'].depth).toBe(0); // root
    expect(byId['o1'].path).toBe('Health › Run a 10k');
  });

  it('filters by typeahead query over title + path, case-insensitive', () => {
    expect(buildPickerRows(tree, 'long RUN', null).map((r) => r.id)).toEqual(['o1']);
    // Path match: "10k" appears only in ancestors of o1/o2.
    expect(buildPickerRows(tree, '10k', null).map((r) => r.id)).toEqual(['o1', 'o2']);
    // A query matching only a non-leaf yields nothing (leaves filtered first).
    expect(buildPickerRows(tree, 'Career', null)).toEqual([]);
  });

  it('empty query returns all leaves in tree order', () => {
    expect(buildPickerRows(tree, '', null).map((r) => r.id)).toEqual(['o1', 'o2', 'o3', 'o4']);
  });

  it('derives checked state from the linked objective id', () => {
    const rows = buildPickerRows(tree, '', 'o2');
    expect(rows.find((r) => r.id === 'o2')!.checked).toBe(true);
    expect(rows.filter((r) => r.checked).map((r) => r.id)).toEqual(['o2']);
    // No link → nothing checked (null and undefined both mean "no objective").
    expect(buildPickerRows(tree, '', null).some((r) => r.checked)).toBe(false);
    expect(buildPickerRows(tree, '', undefined).some((r) => r.checked)).toBe(false);
  });

  it('search threshold is a sane positive bound', () => {
    expect(PICKER_SEARCH_THRESHOLD).toBeGreaterThan(0);
  });
});
