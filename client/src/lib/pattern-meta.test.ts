import { describe, it, expect } from 'vitest';
import { directionColorForTask } from './pattern-meta.js';

const TAGS = [
  { id: 'h1', name: 'Home', kind: 'pattern' },
  { id: 'w1', name: 'Work', kind: 'pattern' },
  { id: 'c1', name: 'Community', kind: 'pattern' },
  { id: 'i1', name: 'errands', kind: 'intention' },
];

describe('directionColorForTask', () => {
  it('uses the saved pattern_prefs color_token when present', () => {
    const out = directionColorForTask({ tags: ['Work', 'errands'] }, TAGS, {
      w1: { color_token: 'tag-5' },
    });
    expect(out).toBe('var(--tag-5)');
  });

  it('falls back to the brand default by lowercased name', () => {
    // Home default = chart-1, Work = chart-4, Community = primary (BASE_TAG_DEFAULTS)
    expect(directionColorForTask({ tags: ['Home'] }, TAGS, {})).toBe('var(--chart-1)');
    expect(directionColorForTask({ tags: ['Work'] }, TAGS, {})).toBe('var(--chart-4)');
    expect(directionColorForTask({ tags: ['Community'] }, TAGS, {})).toBe('var(--primary)');
  });

  it('returns var(--primary) when the task has no direction (only intention tags)', () => {
    expect(directionColorForTask({ tags: ['errands'] }, TAGS, {})).toBe('var(--primary)');
    expect(directionColorForTask({ tags: [] }, TAGS, {})).toBe('var(--primary)');
    expect(directionColorForTask({ tags: null }, TAGS, {})).toBe('var(--primary)');
  });

  it('ignores an intention tag that shares a direction name slot', () => {
    // a pattern-tag wins even if listed after an intention tag
    expect(directionColorForTask({ tags: ['errands', 'Home'] }, TAGS, {})).toBe('var(--chart-1)');
  });
});
