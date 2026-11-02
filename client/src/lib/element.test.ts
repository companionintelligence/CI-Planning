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
// One routine, for the routine-chip step that runs AFTER a task create.
const PATTERNS = [{ id: 'pat-r1', name: 'Morning', type_id: 'pt1', task_ids: [] as string[] }];

vi.mock('../stores/index.js', () => ({
  tags: () => TAGS,
  patterns: () => PATTERNS,
  patternTypes: () => [],
  patternPrefs: () => ({ prefs: {} }),
  refetchTasks: vi.fn(), refetchBlocks: vi.fn(), refetchConcepts: vi.fn(),
  refetchPatterns: vi.fn(), refetchTags: vi.fn(),
}));

const { saveElement, splitBlockTag, mergeTagNames, timeblockTagPayload, taskTagPayload, claimIfFaithful } = await import('./element.js');

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
  it('sends primary as the single tag + secondary_tags + categories together', async () => {
    await saveElement('timeblock', 'add', { ...baseForm, primary: 'work', intentions: ['deep', 'errand'], categories: ['health'] });
    const body = lastCreateBody();
    expect(body.tag).toBe('work');                          // NOT 'work,deep,errand'
    expect(body.secondary_tags).toEqual(['deep', 'errand']);
    expect(body.categories).toEqual(['health']);            // Phase B: names, not category_id
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

describe('saveElement(timeblock) — categories clear-on-edit (AF-CU2 → Phase B)', () => {
  it('edit with the categories CLEARED sends categories: [] on the wire (omitted would be JSON-dropped and server-preserved)', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work', categories: [] }, 'blk-5');
    const wire = JSON.parse(JSON.stringify(lastUpdateBody()));
    expect(wire.categories).toEqual([]);           // survives serialization → server clears the set + color_token
  });

  it('someday edit with the categories cleared also sends categories: []', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work', someday: true, goalDay: '2026-08-01', categories: [] }, 'blk-6');
    const wire = JSON.parse(JSON.stringify(lastUpdateBody()));
    expect(wire.categories).toEqual([]);
  });

  it('edit with categories picked sends them in order (position = stripe order)', async () => {
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work', categories: ['finance', 'health'] }, 'blk-7');
    const wire = JSON.parse(JSON.stringify(lastUpdateBody()));
    expect(wire.categories).toEqual(['finance', 'health']);
  });

  it('create without categories OMITS the field from the wire body (nothing to clear)', async () => {
    await saveElement('timeblock', 'add', { ...baseForm, primary: 'work' });
    const wire = JSON.parse(JSON.stringify(lastCreateBody()));
    expect('categories' in wire).toBe(false);
    expect('category_id' in wire).toBe(false); // the legacy field is never sent anymore
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

// ── Motivation (0141, §3b) — the testimony gate in the save shape ─────────────
// The wizard sends `motivation` ONLY when the user touched the control (form field
// present). An untouched save must omit it entirely: sending the seeded value would
// re-stamp a machine ('llm') label as user testimony on every unrelated edit.
describe('motivation save shape (0141)', () => {
  const taskForm = { title: 'Ship it', primary: '', intentions: [] as string[], scheduledFor: '', taskTime: '', priority: 3 };

  it('untouched → the field is absent from the wire body', async () => {
    await saveElement('task', 'add', { ...taskForm });
    const wire = JSON.parse(JSON.stringify(lastTaskCreateBody()));
    expect('motivation' in wire).toBe(false);
  });

  it('touched with a value → sent verbatim (user testimony)', async () => {
    await saveElement('task', 'add', { ...taskForm, motivation: 'them' });
    expect(lastTaskCreateBody().motivation).toBe('them');
  });

  it('touched to clear → explicit null un-labels on edit', async () => {
    await saveElement('task', 'edit', { ...taskForm, motivation: null }, 'task-9');
    const wire = JSON.parse(JSON.stringify(lastTaskUpdateBody()));
    expect('motivation' in wire).toBe(true);
    expect(wire.motivation).toBeNull();
  });

  it("'us' is a sendable positive claim, distinct from omitting the field", async () => {
    await saveElement('task', 'add', { ...taskForm, motivation: 'us' });
    expect(lastTaskCreateBody().motivation).toBe('us');
  });
});

// ── Classification claim — the Describe-it preview's category pick ─────────────
// The wizard holds the server's `classification_claim` and echoes it VERBATIM on the
// add-mode task/habit create, so the owner's answer to the model's pick is recorded
// (server: settlePreviewClaim). It must reach nothing else: an update, a subtask, a
// block or a routine has no preview pick to answer, and a claim on a PATCH would be
// evidence about a row the model never classified.
describe('classification claim — only the add-mode task/habit create carries it', () => {
  const taskForm = { title: 'Gym session before work', primary: '', intentions: [] as string[], scheduledFor: '', taskTime: '', priority: 3 };
  const claim = { text: 'Gym session before work', categories: ['leisure'] };
  const formWithClaim = { ...taskForm, categories: ['health'], classificationClaim: claim };

  it('task add: the create body carries the claim verbatim, next to the categories the owner ended on', async () => {
    await saveElement('task', 'add', formWithClaim);
    const wire = JSON.parse(JSON.stringify(lastTaskCreateBody()));
    expect(wire.classification_claim).toEqual(claim);
    expect(wire.categories).toEqual(['health']);   // the answer: what the picker shows, not the claim
  });

  it('habit add (recurring template): carried too', async () => {
    await saveElement('habit', 'add', { ...formWithClaim, recurrenceRule: 'FREQ=DAILY' });
    const wire = JSON.parse(JSON.stringify(lastTaskCreateBody()));
    expect(wire.is_habit).toBe(true);
    expect(wire.recurrence_rule).toBe('FREQ=DAILY');
    expect(wire.classification_claim).toEqual(claim);
  });

  it('task add without a claim: the key is absent on the wire', async () => {
    await saveElement('task', 'add', { ...taskForm, categories: ['health'] });
    const wire = JSON.parse(JSON.stringify(lastTaskCreateBody()));
    expect('classification_claim' in wire).toBe(false);
  });

  it('task edit (instance and series): no update body carries it', async () => {
    await saveElement('task', 'edit', formWithClaim, 'task-1');
    expect('classification_claim' in JSON.parse(JSON.stringify(lastTaskUpdateBody()))).toBe(false);
    await saveElement('habit', 'edit', { ...formWithClaim, editScope: 'series', recurrenceRule: 'FREQ=DAILY' }, 'task-2');
    expect(tasksUpdate.mock.calls.at(-1)![2]).toBe('series');
    expect('classification_claim' in JSON.parse(JSON.stringify(lastTaskUpdateBody()))).toBe(false);
    expect(tasksCreate).not.toHaveBeenCalled();
  });

  it('D5 subtask creates never carry it (only the parent create does)', async () => {
    await saveElement('task', 'add', { ...formWithClaim, subtaskTitles: ['Pack bag', 'Book class'] });
    expect(tasksCreate).toHaveBeenCalledTimes(3);
    const bodies = tasksCreate.mock.calls.map((c) => JSON.parse(JSON.stringify(c[0])));
    expect(bodies[0].classification_claim).toEqual(claim);
    expect(bodies.slice(1).map((b) => 'classification_claim' in b)).toEqual([false, false]);
    expect(bodies.slice(1).map((b) => b.parent_id)).toEqual(['task-new', 'task-new']);
  });

  it('time-block and routine adds with a claim in the form: neither body carries it', async () => {
    await saveElement('timeblock', 'add', { ...baseForm, primary: 'work', categories: ['health'], classificationClaim: claim });
    expect('classification_claim' in JSON.parse(JSON.stringify(lastCreateBody()))).toBe(false);
    await saveElement('routine', 'add', { ...baseForm, title: 'Morning', primary: '', classificationClaim: claim });
    expect('classification_claim' in JSON.parse(JSON.stringify(patternsCreate.mock.calls.at(-1)![0]))).toBe(false);
    expect(tasksCreate).not.toHaveBeenCalled();
  });
});

// onCreated — "the task exists" signal. The wizard spends its stored claim on it: a retry
// after a LATER step failed (routine chip) creates a second task, and must not echo the same
// claim and record one decision twice. A create that threw never fires it, so that retry keeps
// the claim and still records.
describe('onCreated — fires once, right after the add-mode task/habit create lands', () => {
  const taskForm = { title: 'Gym session before work', primary: '', intentions: [] as string[], scheduledFor: '', taskTime: '', priority: 3 };

  it('task add: called once, after the create resolved and before the routine chip runs', async () => {
    const order: string[] = [];
    tasksCreate.mockImplementationOnce(async () => { order.push('create'); return { task: { id: 'task-new' } }; });
    patternsUpdate.mockImplementationOnce(async () => { order.push('routine'); return {}; });
    const onCreated = vi.fn(() => { order.push('created'); });

    await saveElement('task', 'add', { ...taskForm, routineAddId: 'pat-r1', onCreated });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['create', 'created', 'routine']);
  });

  it('habit add: called once', async () => {
    const onCreated = vi.fn();
    await saveElement('habit', 'add', { ...taskForm, recurrenceRule: 'FREQ=DAILY', onCreated });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('a create that rejects: never called, and the error still reaches the wizard', async () => {
    tasksCreate.mockRejectedValueOnce(new Error('offline'));
    const onCreated = vi.fn();
    await expect(saveElement('task', 'add', { ...taskForm, onCreated })).rejects.toThrow('offline');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('a step after the create rejects: it had already been called once by then', async () => {
    patternsUpdate.mockRejectedValueOnce(new Error('routine gone'));
    const onCreated = vi.fn();
    await expect(saveElement('task', 'add', { ...taskForm, routineAddId: 'pat-r1', onCreated })).rejects.toThrow('routine gone');
    expect(tasksCreate).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('a subtask create that rejects (swallowed per child) does not call it again', async () => {
    tasksCreate
      .mockResolvedValueOnce({ task: { id: 'task-new' } })
      .mockRejectedValueOnce(new Error('flaky'));
    const onCreated = vi.fn();
    await saveElement('task', 'add', { ...taskForm, subtaskTitles: ['Pack bag'], onCreated });
    expect(tasksCreate).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('task edit (instance and series), time block add/edit and routine add: never called', async () => {
    const onCreated = vi.fn();
    await saveElement('task', 'edit', { ...taskForm, onCreated }, 'task-1');
    await saveElement('habit', 'edit', { ...taskForm, editScope: 'series', recurrenceRule: 'FREQ=DAILY', onCreated }, 'task-2');
    await saveElement('timeblock', 'add', { ...baseForm, primary: 'work', onCreated });
    await saveElement('timeblock', 'edit', { ...baseForm, primary: 'work', onCreated }, 'blk-1');
    await saveElement('routine', 'add', { ...baseForm, title: 'Morning', primary: '', onCreated });
    expect(onCreated).not.toHaveBeenCalled();
  });
});

// claimIfFaithful — the wizard keeps the claim only while the picker shows the model's pick.
// seedCategories drops a name missing from a stale tags() store; without this check the
// owner would "correct" a pick they were never shown.
describe('claimIfFaithful', () => {
  const claim = { text: 'Gym session before work', categories: ['health', 'leisure'] };

  it('equal lists keep the claim (the same object, not a copy)', () => {
    expect(claimIfFaithful(claim, ['health', 'leisure'])).toBe(claim);
  });
  it('case-insensitive equal keeps it', () => {
    expect(claimIfFaithful(claim, ['Health', 'LEISURE'])).toBe(claim);
  });
  it('a dropped name (picker shows fewer) is null', () => {
    expect(claimIfFaithful(claim, ['health'])).toBeNull();
  });
  it('reordered is null (order is the stripe order, so it is a different pick)', () => {
    expect(claimIfFaithful(claim, ['leisure', 'health'])).toBeNull();
  });
  it('an extra chip is null', () => {
    expect(claimIfFaithful(claim, ['health', 'leisure', 'career'])).toBeNull();
  });
  it('a different name is null', () => {
    expect(claimIfFaithful(claim, ['health', 'career'])).toBeNull();
  });
  it('an undefined claim is null (the model abstained or Ollama was down)', () => {
    expect(claimIfFaithful(undefined, ['health'])).toBeNull();
    expect(claimIfFaithful(undefined, [])).toBeNull();
  });
  it('an empty picker is null', () => {
    expect(claimIfFaithful(claim, [])).toBeNull();
  });
  it('a claim with no categories is null, even against an empty picker', () => {
    expect(claimIfFaithful({ text: 'x', categories: [] }, [])).toBeNull();
  });
});
