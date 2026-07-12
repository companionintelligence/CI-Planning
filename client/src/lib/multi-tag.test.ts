import { describe, it, expect } from 'vitest';
import { splitTagNames, classifyTagNames, routineChips, type KindedTag } from './multi-tag.js';

/**
 * AF-11 Slices 4+5 — pure multi-value tag helpers (no jsdom):
 *  • splitTagNames — comma-joined legacy tag strings → one chip per name;
 *  • classifyTagNames — direction (solid) vs other (ghost) chip buckets;
 *  • routineChips — the RoutinesPanel chip lists from the server's DERIVED
 *    directions/intentions (legacy `tag` fallback for stale payloads).
 */

const TAGS: KindedTag[] = [
  { name: 'work', kind: 'direction' },
  { name: 'home', kind: 'direction' },
  { name: 'deep', kind: 'intention' },
  { name: 'meetings', kind: 'category' },
];

describe('splitTagNames', () => {
  it('single name → one entry; null/empty → []', () => {
    expect(splitTagNames('work')).toEqual(['work']);
    expect(splitTagNames(null)).toEqual([]);
    expect(splitTagNames(undefined)).toEqual([]);
    expect(splitTagNames('')).toEqual([]);
  });
  it('splits a comma-joined union, trims, drops empties, dedupes case-insensitively (first wins)', () => {
    expect(splitTagNames('work, home,,deep')).toEqual(['work', 'home', 'deep']);
    expect(splitTagNames('Work,work,HOME')).toEqual(['Work', 'HOME']);
  });
});

describe('classifyTagNames', () => {
  it('directions vs others (unknown names are ghosts), order preserved per bucket', () => {
    expect(classifyTagNames(['deep', 'work', 'mystery', 'home'], TAGS)).toEqual({
      directions: ['work', 'home'],
      others: ['deep', 'mystery'],
    });
  });
  it('matches case-insensitively; category kinds never classify as directions', () => {
    expect(classifyTagNames(['WORK', 'meetings'], TAGS)).toEqual({
      directions: ['WORK'],
      others: ['meetings'],
    });
  });
});

describe('routineChips', () => {
  it('multi-direction routine → every derived direction is a solid chip, intentions are ghosts', () => {
    expect(routineChips({ tag: null, directions: ['home', 'work'], intentions: ['deep'] })).toEqual({
      directions: ['home', 'work'],
      ghosts: ['deep'],
    });
  });
  it('derived-empty routine renders nothing (post-AF-11 tag is null)', () => {
    expect(routineChips({ tag: null, directions: [], intentions: [] })).toEqual({ directions: [], ghosts: [] });
  });
  it('stale payload without derived fields falls back to splitting the legacy tag as ghosts', () => {
    expect(routineChips({ tag: 'work,home' })).toEqual({ directions: [], ghosts: ['work', 'home'] });
  });
});
