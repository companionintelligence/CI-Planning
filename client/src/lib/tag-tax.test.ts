import { describe, it, expect } from 'vitest';
import { groupByDirection, groupByCategory, directionsFirst, sortDirections, sortCategories, displayTag } from './tag-tax.js';
import type { Tag } from './api.js';

const dir = (name: string, is_base = true): Tag => ({ id: name, name, count: 0, kind: 'direction', muted: false, is_base, used: false, directions: [] });
const tag = (name: string, directions: string[], muted = false): Tag => ({ id: name, name, count: 0, kind: 'intention', muted, is_base: false, used: false, directions });
const cat = (name: string, is_base = true, direction_optouts: string[] = []): Tag =>
  ({ id: name, name, count: 0, kind: 'category', muted: false, is_base, used: false, directions: [], direction_optouts });
const intCat = (name: string, categories: string[], muted = false): Tag =>
  ({ id: name, name, count: 0, kind: 'intention', muted, is_base: false, used: false, directions: [], categories });

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

describe('category axis (0069)', () => {
  it('sortCategories orders family·social·me first, then others alphabetically', () => {
    const out = sortCategories([cat('errands', false), cat('me'), cat('social'), cat('family'), cat('admin', false)]);
    expect(out.map((c) => c.name)).toEqual(['family', 'social', 'me', 'admin', 'errands']);
  });

  it('groupByCategory groups intentions by category membership, splits muted, collects Unsorted', () => {
    const tags = [
      cat('family'), cat('social'), cat('me'),
      intCat('kids', ['family']),
      intCat('relax', ['family', 'me']),  // multi-category → both cards
      intCat('party', ['social'], true),  // muted
      intCat('loose', []),                // Unsorted
    ];
    const g = groupByCategory(tags);
    expect(g.groups.find((x) => x.category.name === 'family')!.active.map((t) => t.name).sort()).toEqual(['kids', 'relax']);
    expect(g.groups.find((x) => x.category.name === 'me')!.active.map((t) => t.name)).toEqual(['relax']);
    expect(g.groups.find((x) => x.category.name === 'social')!.muted.map((t) => t.name)).toEqual(['party']);
    expect(g.unsortedActive.map((t) => t.name)).toEqual(['loose']);
  });

  it('NEVER leaks a category tag into directionsFirst or groupByDirection intention buckets', () => {
    const mixed = [dir('work'), tag('product', ['work']), cat('family'), intCat('kids', ['family'])];
    // The task/intention cloud excludes categories entirely.
    expect(directionsFirst(mixed).map((t) => t.name)).toEqual(['work', 'product', 'kids']);
    // The direction grouping never surfaces a category in any bucket.
    const gd = groupByDirection(mixed);
    const all = [...gd.groups.flatMap((x) => [...x.active, ...x.muted]), ...gd.unsortedActive, ...gd.unsortedMuted];
    expect(all.some((t) => t.kind === 'category')).toBe(false);
    // …but the category IS visible on its own axis.
    expect(groupByCategory(mixed).groups.map((x) => x.category.name)).toContain('family');
  });
});
