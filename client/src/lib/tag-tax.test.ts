import { describe, it, expect } from 'vitest';
import { groupByDirection, directionsFirst, sortDirections, displayTag } from './tag-tax.js';
import type { Tag } from './api.js';

const dir = (name: string, is_base = true): Tag => ({ id: name, name, count: 0, kind: 'direction', muted: false, is_base, used: false, directions: [] });
const tag = (name: string, directions: string[], muted = false): Tag => ({ id: name, name, count: 0, kind: 'intention', muted, is_base: false, used: false, directions });

describe('sortDirections', () => {
  it('orders home·work·community first, then others alphabetically', () => {
    const out = sortDirections([dir('garden', false), dir('community'), dir('work'), dir('home'), dir('art', false)]);
    expect(out.map((d) => d.name)).toEqual(['home', 'work', 'community', 'art', 'garden']);
  });
});

describe('groupByDirection', () => {
  const tags = [
    dir('home'), dir('work'), dir('community'),
    tag('yard-work', ['home']),
    tag('make-dinner', ['home', 'work', 'community']), // multi-direction → appears in all three
    tag('product', ['work']),
    tag('noisy', ['work'], true),                       // muted
    tag('orphan', []),                                  // Unsorted
    tag('quiet-orphan', [], true),                      // Unsorted + muted
  ];
  const g = groupByDirection(tags);

  it('places a multi-direction tag in every card', () => {
    const home = g.groups.find((x) => x.direction.name === 'home')!;
    const work = g.groups.find((x) => x.direction.name === 'work')!;
    expect(home.active.map((t) => t.name).sort()).toEqual(['make-dinner', 'yard-work']);
    expect(work.active.map((t) => t.name).sort()).toEqual(['make-dinner', 'product']);
  });
  it('separates muted into its own list', () => {
    const work = g.groups.find((x) => x.direction.name === 'work')!;
    expect(work.muted.map((t) => t.name)).toEqual(['noisy']);
    expect(work.active.map((t) => t.name)).not.toContain('noisy');
  });
  it('collects direction-less intentions as Unsorted (active + muted split)', () => {
    expect(g.unsortedActive.map((t) => t.name)).toEqual(['orphan']);
    expect(g.unsortedMuted.map((t) => t.name)).toEqual(['quiet-orphan']);
  });
});

describe('directionsFirst', () => {
  it('puts directions (brand order) ahead of intentions', () => {
    const out = directionsFirst([tag('product', ['work']), dir('work'), dir('home'), tag('errands', [])]);
    expect(out.map((t) => t.name)).toEqual(['home', 'work', 'product', 'errands']);
  });
});

describe('displayTag', () => {
  it('capitalizes for display', () => {
    expect(displayTag('home')).toBe('Home');
    expect(displayTag('yard-work')).toBe('Yard-work');
  });
});
