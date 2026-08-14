import { describe, it, expect } from 'vitest';
import { constrainToVocabulary, constrainOne } from '../src/agents/constrain.js';

/**
 * The never-invent rule, once. These cases are the UNION of the two hand-rolled copies
 * this module replaced — `constrainCategories` (services/task-enrich.ts) and the inline
 * category/tag blocks in `mergeEnrichment` (agents/quickadd.ts). The copies had already
 * drifted on one point (dedupe key: canonical name vs its lowercase), so the case-dedupe
 * regression below is the case that pins which rule won.
 */

const VOCAB = ['Health', 'Career', 'Relationships', 'Leisure'];

describe('constrainToVocabulary', () => {
  it("keeps known names with the vocabulary's canonical casing", () => {
    expect(constrainToVocabulary(['health', ' CAREER '], VOCAB, 3)).toEqual(['Health', 'Career']);
  });

  it('drops invented names entirely', () => {
    expect(constrainToVocabulary(['health', 'crypto', 'vibes'], VOCAB, 3)).toEqual(['Health']);
    expect(constrainToVocabulary(['crypto'], VOCAB, 3)).toEqual([]);
  });

  it('dedupes and caps at 3 (the entity_categories limit)', () => {
    expect(constrainToVocabulary(['health', 'Health', 'career', 'leisure', 'relationships'], VOCAB, 3))
      .toEqual(['Health', 'Career', 'Leisure']);
  });

  it('tolerates a non-array / junk-element answer', () => {
    expect(constrainToVocabulary('health', VOCAB, 3)).toEqual([]);
    expect(constrainToVocabulary(undefined, VOCAB, 3)).toEqual([]);
    expect(constrainToVocabulary(null, VOCAB, 3)).toEqual([]);
    expect(constrainToVocabulary({ tags: ['health'] }, VOCAB, 3)).toEqual([]);
    expect(constrainToVocabulary([3, null, 'health'], VOCAB, 3)).toEqual(['Health']);
  });

  it('respects an arbitrary max, keeping the model\'s own order', () => {
    expect(constrainToVocabulary(['leisure', 'career', 'health'], VOCAB, 2)).toEqual(['Leisure', 'Career']);
    expect(constrainToVocabulary(['leisure', 'career'], VOCAB, 1)).toEqual(['Leisure']);
    expect(constrainToVocabulary(['leisure'], VOCAB, 0)).toEqual([]);
  });

  it('yields [] against an empty vocabulary — there is nothing legitimate to pick', () => {
    expect(constrainToVocabulary(['health', 'anything'], [], 3)).toEqual([]);
  });

  // The exact difference between the two old copies: task-enrich deduped on the canonical
  // name, quick-add on its lowercase. Equivalent only while canonical names stay unique
  // case-insensitively — this pins the safer rule so a future "Finance"/"finance"
  // vocabulary cannot silently yield two picks for one tag.
  it('collapses a case-varied repeat of ONE vocabulary name to a single pick', () => {
    expect(constrainToVocabulary(['Finance', 'finance', 'FINANCE', 'made-up'], ['Finance'], 3))
      .toEqual(['Finance']);
  });
});

describe('constrainOne', () => {
  it('matches exactly', () => {
    expect(constrainOne('Career', VOCAB)).toBe('Career');
  });

  it('matches case-insensitively and answers with the canonical casing', () => {
    expect(constrainOne('career', VOCAB)).toBe('Career');
    expect(constrainOne(' HEALTH ', VOCAB)).toBe('Health');
  });

  it('answers null for a name the owner does not have', () => {
    expect(constrainOne('crypto', VOCAB)).toBeNull();
    expect(constrainOne('health', [])).toBeNull();
  });

  it('answers null for a non-string answer', () => {
    expect(constrainOne(3, VOCAB)).toBeNull();
    expect(constrainOne(null, VOCAB)).toBeNull();
    expect(constrainOne(undefined, VOCAB)).toBeNull();
    expect(constrainOne(['Health'], VOCAB)).toBeNull();
  });

  it('agrees with the one-slot case of constrainToVocabulary', () => {
    for (const raw of ['career', ' HEALTH ', 'crypto', 3, null]) {
      expect(constrainOne(raw, VOCAB)).toBe(constrainToVocabulary([raw], VOCAB, 1)[0] ?? null);
    }
  });
});
