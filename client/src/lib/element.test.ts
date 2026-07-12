import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AF-9 — the time-block save shape in lib/element.ts:
 *
 *   • level-1 `tag` = the SINGLE primary (work/home/community) — intentions are
 *     no longer folded into a comma-joined string;
 *   • `secondary_tags` = authored intention chips ∪ preserved secondaryTags,
 *     deduped case-insensitively, minus the primary + category-name collisions;
 *   • edit always sends `secondary_tags` (so chip removals clear level 2),
 *     create only when non-empty;
 *   • legacy comma-joined `tag` strings split first=primary / rest=secondary
 *     on load and normalize on the next save.
 *
 * SEAMS mocked: `./api.js` (capture the exact bodies sent) and
 * `../stores/index.js` (tags/patternTypes/patternPrefs signals + refetch spies).
 * Pure helpers (splitBlockTag / mergeTagNames / timeblockTagPayload) run as-is.
 */

const blocksCreate = vi.fn(async (_b: unknown) => ({ block: { id: 'blk-new' } }));
const blocksUpdate = vi.fn(async (_id: string, _b: unknown) => ({}));
const tagsCreate = vi.fn(async (_n: string, _o?: unknown) => ({}));

vi.mock('./api.js', () => ({
  api: {
    tags: { create: (n: string, o?: unknown) => tagsCreate(n, o) },
    blocks: {
      create: (b: unknown) => blocksCreate(b),
      update: (id: string, b: unknown) => blocksUpdate(id, b),
      addTasks: vi.fn(async () => ({})),
    },
    patterns: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), placeToday: vi.fn(async () => ({})) },
    tasks: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), suggestTags: vi.fn(async () => ({ tags: [] })) },
  },
}));

// Store fixture: three base directions, two known intentions, one category whose
// name collides with a plausible typed tag ('meetings').
const TAGS = [
  { id: 'd1', name: 'work', kind: 'direction', directions: [] },
  { id: 'd2', name: 'home', kind: 'direction', directions: [] },
  { id: 'd3', name: 'community', kind: 'direction', directions: [] },
  { id: 'i1', name: 'deep', kind: 'intention', directions: ['work'] },
  { id: 'i2', name: 'errand', kind: 'intention', directions: ['home'] },
  { id: 'c1', name: 'meetings', kind: 'category', directions: [] },
];

vi.mock('../stores/index.js', () => ({
  tags: () => TAGS,
  patternTypes: () => [],
  patternPrefs: () => ({ prefs: {} }),
  refetchTasks: vi.fn(), refetchBlocks: vi.fn(), refetchConcepts: vi.fn(),
  refetchPatterns: vi.fn(), refetchTags: vi.fn(),
}));

const { saveElement, splitBlockTag, mergeTagNames, timeblockTagPayload } = await import('./element.js');

const lastCreateBody = () => blocksCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
const lastUpdateBody = () => blocksUpdate.mock.calls.at(-1)![1] as Record<string, unknown>;

const baseForm = { title: 'Focus', intentions: [] as string[], day: '2026-07-10', start: '09:00', durationMin: 60 };

beforeEach(() => {
  blocksCreate.mockClear();
  blocksUpdate.mockClear();
  tagsCreate.mockClear();
});

describe('splitBlockTag — legacy comma-joined level-1 strings', () => {
  it('splits first segment → primary, rest → secondary', () => {
    expect(splitBlockTag('work,deep,errand')).toEqual({ primary: 'work', secondary: ['deep', 'errand'] });
  });
  it('single tag → primary only', () => {
    expect(splitBlockTag('home')).toEqual({ primary: 'home', secondary: [] });
  });
  it('null / empty / whitespace-only → empty shape', () => {
    expect(splitBlockTag(null)).toEqual({ primary: '', secondary: [] });
    expect(splitBlockTag(undefined)).toEqual({ primary: '', secondary: [] });
    expect(splitBlockTag(' , , ')).toEqual({ primary: '', secondary: [] });
  });
  it('trims segments and drops empties', () => {
    expect(splitBlockTag(' work , deep ,, errand ')).toEqual({ primary: 'work', secondary: ['deep', 'errand'] });
  });
});

describe('mergeTagNames — case-insensitive dedupe, first occurrence wins', () => {
  it('merges lists, keeping the first spelling of a duplicate', () => {
    expect(mergeTagNames(['Deep', 'errand'], ['deep', 'ops'])).toEqual(['Deep', 'errand', 'ops']);
  });
  it('tolerates undefined lists and blank names', () => {
    expect(mergeTagNames(undefined, ['a', ' ', 'b'], undefined)).toEqual(['a', 'b']);
  });
});

describe('timeblockTagPayload — the AF-9 split', () => {
  it('tag = single primary; intentions land in secondary_tags (no comma-join)', () => {
    expect(timeblockTagPayload({ primary: 'work', intentions: ['deep', 'errand'] })).toEqual({
      tag: 'work',
      secondary_tags: ['deep', 'errand'],
    });
  });
  it('dedupes intentions against preserved secondaryTags (case-insensitive)', () => {
    expect(
      timeblockTagPayload({ primary: 'work', intentions: ['Deep'], secondaryTags: ['deep', 'ops'] }),
    ).toEqual({ tag: 'work', secondary_tags: ['Deep', 'ops'] });
  });
  it('the primary never re-appears among the secondaries', () => {
    expect(
      timeblockTagPayload({ primary: 'work', intentions: ['work', 'deep'], secondaryTags: ['Work'] }),
    ).toEqual({ tag: 'work', secondary_tags: ['deep'] });
  });
  it('category-name collisions are dropped from both slots', () => {
    const cats = new Set(['meetings']);
    expect(
      timeblockTagPayload({ primary: 'meetings', intentions: ['meetings', 'deep'] }, cats),
    ).toEqual({ tag: undefined, secondary_tags: ['deep'] });
  });
  it('no primary → tag undefined, secondaries still flow', () => {
    expect(timeblockTagPayload({ primary: '', intentions: ['deep'] })).toEqual({
      tag: undefined,
      secondary_tags: ['deep'],
    });
  });
});

describe('saveElement(timeblock) — payload shape on create', () => {
  it('sends primary as the single tag + secondary_tags + category_id together', async () => {
    await saveElement('timeblock', 'add', { ...baseForm, primary: 'work', intentions: ['deep', 'errand'], categoryId: 'c1' });
    const body = lastCreateBody();
    expect(body.tag).toBe('work');                          // NOT 'work,deep,errand'
    expect(body.secondary_tags).toEqual(['deep', 'errand']);
    expect(body.category_id).toBe('c1');
    expect(body.block_kind).toBe('timeblock');
  });

  it('omits secondary_tags entirely when there are none (create)', async () => {
    await saveElement('timeblock', 'add', { ...baseForm, primary: 'home' });
    const body = lastCreateBody();
    expect(body.tag).toBe('home');
    expect('secondary_tags' in body).toBe(false);
  });

  it('someday blocks get the same split', async () => {
    await saveElement('timeblock', 'add', {
      ...baseForm, primary: 'community', intentions: ['errand'], someday: true, goalDay: '2026-08-01',
    });
    const body = lastCreateBody();
    expect(body.block_type).toBe('someday');
    expect(body.tag).toBe('community');
    expect(body.secondary_tags).toEqual(['errand']);
  });
});

describe('saveElement(timeblock) — edit round-trip', () => {
  it('edit sends tag=primary + merged/deduped secondary_tags', async () => {
    // Wizard loads a legacy comma-joined block: splitBlockTag gives first=primary,
    // rest into chips, merged with the block's existing level-2 tags.
    const { primary, secondary } = splitBlockTag('work,deep,errand');
    const chips = mergeTagNames(secondary, ['deep', 'ops']); // existing secondary_tags round-tripped
    await saveElement('timeblock', 'edit', { ...baseForm, primary, intentions: chips }, 'blk-1');
    expect(blocksUpdate.mock.calls.at(-1)![0]).toBe('blk-1');
    const body = lastUpdateBody();
    expect(body.tag).toBe('work');                                 // normalized: single primary
    expect(body.secondary_tags).toEqual(['deep', 'errand', 'ops']); // rest + existing, deduped
  });

  it('edit ALWAYS sends secondary_tags — an emptied chip set clears level 2', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work', intentions: [] }, 'blk-2');
    const body = lastUpdateBody();
    expect(body.secondary_tags).toEqual([]);
  });

  it('edit with the direction CLEARED sends tag: null on the wire (omitted tag would be JSON-dropped and server-preserved)', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: '', intentions: ['deep'] }, 'blk-4');
    const wire = JSON.parse(JSON.stringify(lastUpdateBody()));
    expect(wire.tag).toBeNull();                   // survives serialization → server clears level 1 + nulls the column
    expect(wire.secondary_tags).toEqual(['deep']);
  });

  it('create with no direction still OMITS tag from the wire body (nothing to clear)', async () => {
    await saveElement('timeblock', 'add', { ...baseForm, primary: '' });
    const wire = JSON.parse(JSON.stringify(lastCreateBody()));
    expect('tag' in wire).toBe(false);
  });

  it('preserved-but-not-round-tripped secondaryTags still survive an edit (union path)', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'home', intentions: ['deep'], secondaryTags: ['ops'] }, 'blk-3');
    const body = lastUpdateBody();
    expect(body.tag).toBe('home');
    expect(body.secondary_tags).toEqual(['deep', 'ops']);
  });
});
