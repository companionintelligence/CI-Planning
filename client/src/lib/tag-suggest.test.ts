import { describe, it, expect } from 'vitest';
import { suggestTagsFromTitle, mergeSuggestedTags, localDayPlus } from './tag-suggest.js';

describe('suggestTagsFromTitle', () => {
  const tags = ['email', 'lita', 'finance', 'deep-work', 'errands'];

  it('matches single-word tags on whole words only', () => {
    expect(suggestTagsFromTitle('Email Bluepeak about the Cedar Systems invoice', tags).sort()).toEqual(['email', 'lita']);
    expect(suggestTagsFromTitle('emailing the team', tags)).toEqual([]); // not a whole word
  });

  it('matches multi-word/hyphenated tags as a phrase', () => {
    expect(suggestTagsFromTitle('Deep work session on the engine', tags)).toContain('deep-work');
    expect(suggestTagsFromTitle('deep-work block', tags)).toContain('deep-work');
  });

  it('is case-insensitive and returns the original tag name', () => {
    expect(suggestTagsFromTitle('FINANCE review', tags)).toEqual(['finance']);
  });

  it('returns nothing when no tag appears', () => {
    expect(suggestTagsFromTitle('Walk the dog', tags)).toEqual([]);
    expect(suggestTagsFromTitle('', tags)).toEqual([]);
  });
});

describe('mergeSuggestedTags', () => {
  const vocab = ['email', 'finance', 'deep-work', 'errands'];

  it('unions LLM + heuristic, dedupes, and preserves LLM-first order', () => {
    expect(mergeSuggestedTags(['finance'], ['email', 'finance'], vocab)).toEqual(['finance', 'email']);
  });

  it('never lets a non-vocabulary tag through (no invented tags)', () => {
    expect(mergeSuggestedTags(['made-up'], ['email'], vocab)).toEqual(['email']);
    expect(mergeSuggestedTags(['made-up'], ['also-fake'], vocab)).toEqual([]);
  });

  it('degrades to the heuristic when the LLM list is empty (Ollama down)', () => {
    expect(mergeSuggestedTags([], ['email', 'deep-work'], vocab)).toEqual(['email', 'deep-work']);
  });

  it('returns nothing when both are empty', () => {
    expect(mergeSuggestedTags([], [], vocab)).toEqual([]);
  });
});

describe('localDayPlus', () => {
  const base = new Date('2026-06-22T10:00:00'); // local
  it('returns today / +1 / +7 as YYYY-MM-DD', () => {
    expect(localDayPlus(0, base)).toBe('2026-06-22');
    expect(localDayPlus(1, base)).toBe('2026-06-23');
    expect(localDayPlus(7, base)).toBe('2026-06-29');
  });
  it('rolls over month boundaries', () => {
    expect(localDayPlus(1, new Date('2026-06-30T10:00:00'))).toBe('2026-07-01');
  });
});
