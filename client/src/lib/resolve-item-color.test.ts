import { describe, it, expect } from 'vitest';
import { resolveItemColor } from './pattern-meta.js';

/** #391 — the one resolution rule every tint point routes through:
 *  item token beats type token beats primary. */
describe('resolveItemColor', () => {
  it('item token wins over the type token', () => {
    expect(resolveItemColor('tag-3', 'chart-1')).toBe('var(--tag-3)');
  });
  it('falls back to the type token when the item has none', () => {
    expect(resolveItemColor(null, 'chart-1')).toBe('var(--chart-1)');
    expect(resolveItemColor(undefined, 'chart-1')).toBe('var(--chart-1)');
  });
  it('falls back to primary when neither is set', () => {
    expect(resolveItemColor(null, null)).toBe('var(--primary)');
    expect(resolveItemColor(undefined, undefined)).toBe('var(--primary)');
  });
});
