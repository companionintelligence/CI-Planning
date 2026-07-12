import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AF-9 — the time-block save shape in lib/element.ts:
 *
 *   • level-1 `tag` = the SINGLE primary (work/home/community) — intentions are
 *     no longer folded into a comma-joined string;
 *   • `secondary_tags` = authored intention chips, deduped case-insensitively,
 *     minus the primary + category-name collisions (the wizard round-trips a
 *     block's existing secondary_tags into the chips on load);
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
const patternsCreate = vi.fn(async (_b: unknown) => ({ pattern: { id: 'pat-new' } }));
const patternsUpdate = vi.fn(async (_id: string, _b: unknown) => ({}));
const tasksCreate = vi.fn(async (_b: unknown) => ({ task: { id: 'task-new' } }));
const tasksUpdate = vi.fn(async (_id: string, _b: unknown, _scope?: string) => ({}));

vi.mock('./api.js', () => ({
  api: {
    tags: { create: (n: string, o?: unknown) => tagsCreate(n, o) },
    blocks: {
      create: (b: unknown) => blocksCreate(b),
      update: (id: string, b: unknown) => blocksUpdate(id, b),
      addTasks: vi.fn(async () => ({})),
    },
    patterns: {
      create: (b: unknown) => patternsCreate(b),
      update: (id: string, b: unknown) => patternsUpdate(id, b),
      placeToday: vi.fn(async () => ({})),
    },
    tasks: {
      create: (b: unknown) => tasksCreate(b),
      update: (id: string, b: unknown, scope?: string) => tasksUpdate(id, b, scope),
      suggestTags: vi.fn(async () => ({ tags: [] })),
    },
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

const { saveElement, splitBlockTag, mergeTagNames, timeblockTagPayload, taskTagPayload } = await import('./element.js');

const lastCreateBody = () => blocksCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
const lastUpdateBody = () => blocksUpdate.mock.calls.at(-1)![1] as Record<string, unknown>;
const lastTaskCreateBody = () => tasksCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
const lastTaskUpdateBody = () => tasksUpdate.mock.calls.at(-1)![1] as Record<string, unknown>;

const baseForm = { title: 'Focus', intentions: [] as string[], day: '2026-07-10', start: '09:00', durationMin: 60 };

beforeEach(() => {
  blocksCreate.mockClear();
  blocksUpdate.mockClear();
  tagsCreate.mockClear();
  patternsCreate.mockClear();
  patternsUpdate.mockClear();
  tasksCreate.mockClear();
  tasksUpdate.mockClear();
});

// AF-11 Slices 4-6: routines author NO tags — the wizard's routine branch stops
// sending the comma-joined `tag`; directions/intentions derive server-side.
describe('AF-11 — routine saves send no tag', () => {
  it('create: no tag key in the patterns.create body (even with primary + intentions set)', async () => {
    await saveElement('routine', 'add', { ...baseForm, title: 'Morning', primary: 'work', intentions: ['deep'] });
    const body = patternsCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect('tag' in body).toBe(false);
    expect(body.name).toBe('Morning');
    expect(body.task_ids).toEqual([]);
  });

  it('edit: no tag key in the patterns.update body', async () => {
    await saveElement('routine', 'edit', { ...baseForm, title: 'Morning 2', primary: 'home', intentions: [] }, 'pat-1');
    const [id, body] = patternsUpdate.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect(id).toBe('pat-1');
    expect('tag' in body).toBe(false);
    expect(body).toEqual({ name: 'Morning 2' });
  });
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
  it('dedupes the chip list itself (case-insensitive, first spelling wins)', () => {
    expect(
      timeblockTagPayload({ primary: 'work', intentions: ['Deep', 'deep', 'ops'] }),
    ).toEqual({ tag: 'work', secondary_tags: ['Deep', 'ops'] });
  });
  it('the primary never re-appears among the secondaries', () => {
    expect(
      timeblockTagPayload({ primary: 'work', intentions: ['work', 'deep', 'Work'] }),
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

  it('chips loaded from a block\'s existing secondary_tags round-trip through an edit', async () => {
    // The wizard folds existing level-2 tags into `intentions` on load (AF-CU2
    // removed the separate blind-preserve set) — an untouched edit re-sends them.
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'home', intentions: ['deep', 'ops'] }, 'blk-3');
    const body = lastUpdateBody();
    expect(body.tag).toBe('home');
    expect(body.secondary_tags).toEqual(['deep', 'ops']);
  });
});

describe('saveElement(timeblock) — category clear-on-edit (AF-CU2)', () => {
  it('edit with the category CLEARED sends category_id: null on the wire (omitted would be JSON-dropped and server-preserved)', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work' }, 'blk-5');
    const wire = JSON.parse(JSON.stringify(lastUpdateBody()));
    expect(wire.category_id).toBeNull();           // survives serialization → server clears category_id + color_token
  });

  it('someday edit with the category cleared also sends category_id: null', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work', someday: true, goalDay: '2026-08-01' }, 'blk-6');
    const wire = JSON.parse(JSON.stringify(lastUpdateBody()));
    expect(wire.category_id).toBeNull();
  });

  it('edit with a category picked still sends it', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work', categoryId: 'c1' }, 'blk-7');
    const wire = JSON.parse(JSON.stringify(lastUpdateBody()));
    expect(wire.category_id).toBe('c1');
  });

  it('create without a category OMITS category_id from the wire body (nothing to clear)', async () => {
    await saveElement('timeblock', 'add', { ...baseForm, primary: 'work' });
    const wire = JSON.parse(JSON.stringify(lastCreateBody()));
    expect('category_id' in wire).toBe(false);
  });
});

// ── AF-11 — the task/habit split shape (direction L1 + intentions L2) ──────────

describe('taskTagPayload — the AF-11 split (array semantics)', () => {
  it('tags = [primary]; intentions land in secondary_tags', () => {
    expect(taskTagPayload({ primary: 'work', intentions: ['deep', 'errand'] })).toEqual({
      tags: ['work'],
      secondary_tags: ['deep', 'errand'],
    });
  });
  it('no primary → tags: [] (the array IS the clearing value)', () => {
    expect(taskTagPayload({ primary: '', intentions: ['deep'] })).toEqual({ tags: [], secondary_tags: ['deep'] });
  });
  it('dedupes chips and never repeats the primary among the secondaries', () => {
    expect(taskTagPayload({ primary: 'work', intentions: ['Deep', 'deep', 'work', 'ops'] })).toEqual({
      tags: ['work'],
      secondary_tags: ['Deep', 'ops'],
    });
  });
  it('category-name collisions are dropped from both slots', () => {
    const cats = new Set(['meetings']);
    expect(taskTagPayload({ primary: 'meetings', intentions: ['meetings', 'deep'] }, cats)).toEqual({
      tags: [],
      secondary_tags: ['deep'],
    });
  });
});

describe('saveElement(task/habit) — split POST body shape', () => {
  const taskForm = { title: 'Ship it', intentions: [] as string[], scheduledFor: '', taskTime: '', priority: 3 };

  it('create sends tags: [primary] + secondary_tags: [...intentions] — no flat folding', async () => {
    await saveElement('task', 'add', { ...taskForm, primary: 'work', intentions: ['deep', 'errand'] });
    const body = lastTaskCreateBody();
    expect(body.tags).toEqual(['work']);                    // NOT ['work','deep','errand']
    expect(body.secondary_tags).toEqual(['deep', 'errand']);
  });

  it('create with no direction sends tags: [] on the wire (arrays survive serialization)', async () => {
    await saveElement('task', 'add', { ...taskForm, primary: '', intentions: ['deep'] });
    const wire = JSON.parse(JSON.stringify(lastTaskCreateBody()));
    expect(wire.tags).toEqual([]);
    expect(wire.secondary_tags).toEqual(['deep']);
  });

  it('edit with the direction CLEARED sends tags: [] — the server empties level 1 (parity with block tag: null)', async () => {
    await saveElement('task', 'edit', { ...taskForm, primary: '', intentions: ['deep'] }, 'task-1');
    expect(tasksUpdate.mock.calls.at(-1)![0]).toBe('task-1');
    const wire = JSON.parse(JSON.stringify(lastTaskUpdateBody()));
    expect(wire.tags).toEqual([]);                          // present + empty → clears L1
    expect(wire.secondary_tags).toEqual(['deep']);          // chips preserved at L2
  });

  it('edit ALWAYS sends secondary_tags — an emptied chip set clears level 2', async () => {
    await saveElement('task', 'edit', { ...taskForm, primary: 'work', intentions: [] }, 'task-2');
    const wire = JSON.parse(JSON.stringify(lastTaskUpdateBody()));
    expect(wire.tags).toEqual(['work']);
    expect(wire.secondary_tags).toEqual([]);
  });

  it('habit saves use the same split shape', async () => {
    await saveElement('habit', 'add', { ...taskForm, primary: 'home', intentions: ['errand'] });
    const body = lastTaskCreateBody();
    expect(body.tags).toEqual(['home']);
    expect(body.secondary_tags).toEqual(['errand']);
    expect(body.is_habit).toBe(true);
  });

  it('a category-name primary never lands in tags (same guard as blocks)', async () => {
    await saveElement('task', 'add', { ...taskForm, primary: 'meetings', intentions: ['deep'] });
    const body = lastTaskCreateBody();
    expect(body.tags).toEqual([]);
    expect(body.secondary_tags).toEqual(['deep']);
  });
});
