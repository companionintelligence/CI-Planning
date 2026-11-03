import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

/**
 * ElementWizard — the Describe-it preview's classification claim.
 *
 * The server's POST /tasks/quick/parse says when the MODEL picked the categories. The
 * wizard holds that claim while the preview is on screen and `doSave` echoes it, so Add
 * can record the owner's answer to the pick (server: settlePreviewClaim). Contracts:
 *
 *   1. a parse stores the claim; Add sends it unchanged, next to whatever the picker
 *      shows by then (the owner's edit IS the correction, so it is never re-built);
 *   2. every SUCCESSFUL parse replaces the claim: one where the model abstained clears a
 *      stale one, a later claim wins, a failed parse leaves it alone;
 *   3. a Time Block parse is about a block (no task row): no claim;
 *   4. a claim whose names the picker could not show in full (stale tags store) is not
 *      kept: the owner would "correct" a pick they never saw;
 *   5. closing and reopening the modal forgets it;
 *   6. a create that FAILED keeps it (Add again still records), a create that LANDED and
 *      was followed by a failing step spends it (Add again makes a second task and must
 *      not record the same decision twice);
 *   7. a habit Add (Repeat + Track as habit) carries it as well.
 *
 * And the other half of the evidence rule, on EDIT: the picker is seeded from the row, so
 * a task or habit edit sends `categories` only when the owner used the picker; a series
 * save opened from a generated instance (which has no category rows) would otherwise send
 * that empty set and wipe the template's categories. Add always sends it. A Time Block
 * edit is outside the rule (a block has no learning row) and sends the picker as before.
 * A Describe-it answer that lands after the modal was reopened in Edit is dropped, so it
 * cannot seed the picker of a task it was never about.
 *
 * The REAL lib/element.ts runs (claimIfFaithful, saveElement), so `api.tasks.create` is
 * the wire seam. Mocked: `../lib/api.js` and `../stores/index.js` (plus three leaf
 * widgets that need browser APIs and say nothing about the claim).
 */

const quickParseMock = vi.fn();
const tasksCreateMock = vi.fn(async (_b: unknown) => ({ task: { id: 'task-new' } }));
const tasksUpdateMock = vi.fn(async (_id: string, _b: unknown, _scope?: string) => ({}));
const blocksCreateMock = vi.fn(async (_b: unknown) => ({ block: { id: 'blk-new' } }));
const blocksUpdateMock = vi.fn(async (_id: string, _b: unknown) => ({}));
const patternsUpdateMock = vi.fn(async (_id: string, _b: unknown) => ({}));
const showToastMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    people: { list: async () => ({ people: [] }), accounts: async () => ({ accounts: [] }) },
    calibration: { suggest: async () => ({ suggestion: null }) },
    tags: { create: vi.fn(async () => ({})) },
    tasks: {
      quickParse: (...a: unknown[]) => quickParseMock(...a),
      create: (b: unknown) => tasksCreateMock(b),
      update: (id: string, b: unknown, scope?: string) => tasksUpdateMock(id, b, scope),
      suggestTags: async () => ({ tags: [] }),
      suggestSubtasks: async () => ({ subtasks: [] }),
    },
    blocks: { create: (b: unknown) => blocksCreateMock(b), update: (id: string, b: unknown) => blocksUpdateMock(id, b), addTasks: vi.fn(async () => ({})) },
    patterns: { create: vi.fn(async () => ({})), update: (id: string, b: unknown) => patternsUpdateMock(id, b), placeToday: vi.fn(async () => ({})) },
  },
}));

// The picker offers health / leisure / career / travel (four, so a test can sit at the cap
// of three and still have a chip to tap). 'finance' is deliberately NOT here: a parse naming
// it stands in for a category created in another tab and not yet refetched.
const TAGS = [
  { id: 'd1', name: 'work', kind: 'direction', directions: [] },
  { id: 'd2', name: 'home', kind: 'direction', directions: [] },
  { id: 'c1', name: 'health', kind: 'category', directions: [] },
  { id: 'c2', name: 'leisure', kind: 'category', directions: [] },
  { id: 'c3', name: 'career', kind: 'category', directions: [] },
  { id: 'c4', name: 'travel', kind: 'category', directions: [] },
];

type ModalState = {
  open: boolean; mode: 'add' | 'edit'; kind: 'task' | 'habit' | 'timeblock' | null;
  editTarget?: { kind: 'task' | 'habit' | 'timeblock'; id: string };
};
const CLOSED: ModalState = { open: false, mode: 'add', kind: null };
const [modal, setModal] = createSignal<ModalState>(CLOSED);

// Store rows a test sets up (reset in beforeEach): the rows an EDIT loads from, and the
// routines behind the Routine chip (it needs the enable_routines pref and a Routine type).
let TASKS: unknown[] = [];
let BLOCKS: unknown[] = [];
let PATTERNS: unknown[] = [];
let PATTERN_TYPES: unknown[] = [];
let PREFS: Record<string, unknown> = {};

vi.mock('../stores/index.js', () => ({
  elementModal: () => modal(),
  setElementModal: (v: ModalState) => setModal(v),
  tags: () => TAGS,
  blocks: () => BLOCKS, concepts: () => [], tasks: () => TASKS, patterns: () => PATTERNS, patternTypes: () => PATTERN_TYPES,
  patternPrefs: () => ({ prefs: {} }), categoryPrefs: () => ({ prefs: {} }), prefs: () => PREFS,
  patternBlocks: () => undefined,
  showToast: (...a: unknown[]) => showToastMock(...a),
  refetchBlocks: vi.fn(), refetchTasks: vi.fn(), refetchFlightPlan: vi.fn(),
  refetchConcepts: vi.fn(), refetchPatterns: vi.fn(), refetchTags: vi.fn(),
}));
vi.mock('./MicButton.js', () => ({ MicButton: () => null }));
vi.mock('./TextureModal.js', () => ({ TextureTrigger: () => null, TextureModal: () => null }));
vi.mock('./PeopleField.js', () => ({ PeopleField: () => null }));

const { ElementWizard } = await import('./ElementWizard.js');

const LINE = 'gym session before work';
const claimFor = (categories: string[]) => ({ text: LINE, categories });
const parseOk = (categories: string[] | undefined, claim: { text: string; categories: string[] } | undefined) => ({
  parsed: { title: LINE, tags: [], priority: 2, ...(categories ? { categories } : {}) },
  llm: true,
  ...(claim ? { classification_claim: claim } : {}),
});

const open = (kind: 'task' | 'timeblock' = 'task') => setModal({ open: true, mode: 'add', kind });
const openEdit = (kind: 'task' | 'habit' | 'timeblock', id: string) => setModal({ open: true, mode: 'edit', kind, editTarget: { kind, id } });
const nlInput = () => screen.getByPlaceholderText(/^Describe it/) as HTMLInputElement;
const titleInput = () => screen.getByPlaceholderText(/title…$/) as HTMLInputElement;
const chip = (name: string) => screen.getByRole('button', { name });

/** Type into the Describe-it line, press Enter, and wait for that parse to finish. */
async function describeIt(line: string) {
  const calls = quickParseMock.mock.calls.length;
  fireEvent.input(nlInput(), { target: { value: line } });
  fireEvent.keyDown(nlInput(), { key: 'Enter' });
  await waitFor(() => expect(quickParseMock.mock.calls.length).toBe(calls + 1));
  await waitFor(() => expect(nlInput().disabled).toBe(false)); // nlBusy cleared: the response is applied
}

/** Press Add and return the body that reached the wire for the (first) create. */
async function add() {
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(showToastMock).toHaveBeenCalled());
  return JSON.parse(JSON.stringify(tasksCreateMock.mock.calls[0]?.[0] ?? null));
}

/** Press the footer button (Add, or Save in edit mode) and wait for the n-th toast. */
async function press(label: 'Add' | 'Save', toasts = 1) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(showToastMock).toHaveBeenCalledTimes(toasts));
}
/** The n-th create body as it reached the wire (JSON round-trip drops undefined, like fetch). */
const createBody = (n: number) => JSON.parse(JSON.stringify(tasksCreateMock.mock.calls[n]?.[0] ?? null));
/** [id, wire body, scope] of the n-th task update. */
const updateCall = (n: number) => {
  const [id, body, scope] = tasksUpdateMock.mock.calls[n]!;
  return { id, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>, scope };
};

beforeEach(() => {
  vi.clearAllMocks();
  quickParseMock.mockReset();
  TASKS = []; BLOCKS = []; PATTERNS = []; PATTERN_TYPES = []; PREFS = {};
  setModal(CLOSED);
});

describe('ElementWizard — classification claim', () => {
  it('a parse stores the claim and Add echoes it verbatim on the create', async () => {
    quickParseMock.mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);

    const body = await add();
    expect(body.classification_claim).toEqual(claimFor(['leisure']));
    expect(body.categories).toEqual(['leisure']);
  });

  it("the owner's picker edit is the correction: Add sends the SAME claim beside the new categories", async () => {
    quickParseMock.mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    fireEvent.click(chip('Leisure'));   // off
    fireEvent.click(chip('Health'));    // on

    const body = await add();
    expect(body.categories).toEqual(['health']);
    expect(body.classification_claim).toEqual(claimFor(['leisure']));   // not rewritten to match
  });

  it('a clean typed-in add (no parse) sends no claim', async () => {
    render(() => <ElementWizard />);
    open();
    fireEvent.input(titleInput(), { target: { value: 'Pay the invoice' } });

    const body = await add();
    expect(body.title).toBe('Pay the invoice');
    expect('classification_claim' in body).toBe(false);
  });

  it('a parse with no claim (llm off, or the model abstained) sends none', async () => {
    quickParseMock.mockResolvedValueOnce({ parsed: { title: LINE, tags: [], priority: 2 }, llm: false });
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);

    const body = await add();
    expect('classification_claim' in body).toBe(false);
  });

  it('a later successful parse where the model abstained REPLACES (clears) the stale claim', async () => {
    quickParseMock
      .mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])))
      .mockResolvedValueOnce({ parsed: { title: LINE, tags: [], priority: 2 }, llm: true });
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    await describeIt(`${LINE} again`);

    const body = await add();
    expect('classification_claim' in body).toBe(false);
  });

  it('a later claim replaces an earlier one', async () => {
    quickParseMock
      .mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])))
      .mockResolvedValueOnce(parseOk(['career'], claimFor(['career'])));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    await describeIt(`${LINE} again`);

    const body = await add();
    expect(body.classification_claim).toEqual(claimFor(['career']));
  });

  it('a FAILED parse leaves the claim alone (the fields it describes are untouched too)', async () => {
    quickParseMock
      .mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])))
      .mockRejectedValueOnce(new Error('offline'));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    await describeIt(`${LINE} again`);
    expect(screen.getByText('offline')).toBeInTheDocument();

    const body = await add();
    expect(body.classification_claim).toEqual(claimFor(['leisure']));
  });

  it('a Time Block parse yields no claim, and the stale task claim does not survive it', async () => {
    quickParseMock
      .mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])))
      .mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);                                    // task tab: claim held
    fireEvent.click(screen.getByRole('button', { name: 'Time Block' }));
    await describeIt(`${LINE} again`);                         // block tab: replaces it with null
    fireEvent.click(screen.getByRole('button', { name: 'Task' }));

    const body = await add();
    expect(blocksCreateMock).not.toHaveBeenCalled();
    expect(body.title).toBe(LINE);
    expect('classification_claim' in body).toBe(false);
  });

  it('a claim the picker could not show in full is dropped (the model named a category the store lacks)', async () => {
    quickParseMock.mockResolvedValueOnce(parseOk(['leisure', 'finance'], claimFor(['leisure', 'finance'])));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    expect(chip('Leisure').className).toContain('border-primary');   // seeded: the part the picker has

    const body = await add();
    expect(body.categories).toEqual(['leisure']);                     // 'finance' never landed in the picker
    expect('classification_claim' in body).toBe(false);               // so no "correction" to report
  });

  it('closing and reopening the modal forgets the claim', async () => {
    quickParseMock.mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    setModal(CLOSED);
    open();
    fireEvent.input(titleInput(), { target: { value: LINE } });

    const body = await add();
    expect(body.title).toBe(LINE);
    expect('classification_claim' in body).toBe(false);
  });
});

describe('ElementWizard — what happens to the claim around the create', () => {
  it('a create that FAILED keeps the claim: Add again sends the same one', async () => {
    quickParseMock.mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])));
    tasksCreateMock.mockRejectedValueOnce(new Error('offline'));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);

    await press('Add', 1);
    expect(showToastMock).toHaveBeenLastCalledWith('offline', 'error');
    await press('Add', 2);
    expect(showToastMock).toHaveBeenLastCalledWith('Task saved', 'success');

    expect(tasksCreateMock).toHaveBeenCalledTimes(2);
    expect(createBody(0).classification_claim).toEqual(claimFor(['leisure']));
    expect(createBody(1).classification_claim).toEqual(claimFor(['leisure']));   // no task existed, so it still records
  });

  it('a create that LANDED followed by a failing step spends the claim: Add again sends none', async () => {
    PREFS = { enable_routines: true };
    PATTERN_TYPES = [{ id: 'pt-routine', name: 'Routine' }];
    PATTERNS = [{ id: 'pat-1', name: 'Morning', type_id: 'pt-routine', task_ids: [] }];
    quickParseMock.mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])));
    patternsUpdateMock.mockRejectedValueOnce(new Error('routine gone'));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    // The Routine TAB shares the chip's name and comes first in the DOM; the chip is last.
    fireEvent.click(screen.getAllByRole('button', { name: 'Routine' }).at(-1)!);
    fireEvent.click(screen.getByRole('button', { name: 'Morning' }));

    await press('Add', 1);                                   // task 1 exists, the routine attach threw
    expect(showToastMock).toHaveBeenLastCalledWith('routine gone', 'error');
    expect(createBody(0).classification_claim).toEqual(claimFor(['leisure']));
    await press('Add', 2);                                   // the modal stayed open: this makes task 2

    expect(tasksCreateMock).toHaveBeenCalledTimes(2);
    expect(createBody(1).title).toBe(LINE);
    expect(createBody(1).categories).toEqual(['leisure']);
    expect('classification_claim' in createBody(1)).toBe(false);   // one decision, one row
  });

  it('a habit Add (Repeat + Track as habit) sends is_habit, the rule and the claim', async () => {
    quickParseMock.mockResolvedValueOnce(parseOk(['leisure'], claimFor(['leisure'])));
    render(() => <ElementWizard />);
    open();
    await describeIt(LINE);
    fireEvent.click(screen.getByRole('button', { name: /Repeat/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.click(screen.getByRole('button', { name: /Track as habit/ }));

    const body = await add();
    expect(body.is_habit).toBe(true);
    expect(body.recurrence_rule).toBe('FREQ=DAILY');
    expect(body.classification_claim).toEqual(claimFor(['leisure']));
  });
});

describe('ElementWizard — a task or habit edit sends the category picker only if the owner used it', () => {
  const taskRow = (over: Record<string, unknown> = {}) => ({
    id: 'task-9', title: 'Gym session', status: 'open', tags: ['work'], secondary_tags: [],
    categories: ['leisure'], priority: 3, scheduled_for: '2026-11-03', task_time: '09:00',
    estimated_minutes: 30, depends_on: [], ...over,
  });
  const blockRow = () => ({
    id: 'blk-1', title: 'Deep work', tag: 'work', secondary_tags: [], categories: ['health'],
    block_type: 'scheduled', all_day: false, is_locked: false, status: 'scheduled',
    start_at: '2026-11-03T09:00:00', end_at: '2026-11-03T10:00:00',
  });

  it('task edit, picker untouched: the update body has no categories key', async () => {
    TASKS = [taskRow()];
    render(() => <ElementWizard />);
    openEdit('task', 'task-9');
    expect(chip('Leisure').className).toContain('border-primary');   // seeded from the row

    await press('Save');
    const { id, body, scope } = updateCall(0);
    expect(id).toBe('task-9');
    expect(scope).toBeUndefined();
    expect(body.title).toBe('Gym session');       // the save happened, only the picker was left out
    expect('categories' in body).toBe(false);
    expect(tasksCreateMock).not.toHaveBeenCalled();
  });

  it('task edit, picker used: the update body carries what it shows', async () => {
    TASKS = [taskRow()];
    render(() => <ElementWizard />);
    openEdit('task', 'task-9');
    fireEvent.click(chip('Health'));

    await press('Save');
    expect(updateCall(0).body.categories).toEqual(['leisure', 'health']);
  });

  it('task edit, picker emptied by the owner: [] is sent (an explicit clear)', async () => {
    TASKS = [taskRow()];
    render(() => <ElementWizard />);
    openEdit('task', 'task-9');
    fireEvent.click(chip('Leisure'));    // off

    await press('Save');
    expect(updateCall(0).body.categories).toEqual([]);
  });

  it('task edit at the cap of 3: a tap on a fourth chip is refused, and a refused tap is not use', async () => {
    // toggleCategory returns at three without latching the flag. If it did, Save would send
    // the same three names back, which only the server's read-back would then make a no-op.
    TASKS = [taskRow({ categories: ['health', 'leisure', 'career'] })];
    render(() => <ElementWizard />);
    openEdit('task', 'task-9');
    fireEvent.click(chip('Travel'));
    expect(chip('Travel').className).not.toContain('border-primary');   // the cap held

    await press('Save');
    expect('categories' in updateCall(0).body).toBe(false);
  });

  it('series save from a generated instance, picker untouched: no categories (the template keeps its own)', async () => {
    // Instances carry no category rows, so the seeded picker is empty; sending that would
    // wipe the template's categories.
    TASKS = [taskRow({ id: 'inst-1', categories: [], recurrence_parent_id: 'tmpl-1' })];
    render(() => <ElementWizard />);
    openEdit('task', 'inst-1');
    fireEvent.click(screen.getByRole('button', { name: 'This & future' }));

    await press('Save');
    const { id, body, scope } = updateCall(0);
    expect(id).toBe('tmpl-1');          // a series save is addressed to the template
    expect(scope).toBe('series');
    expect('categories' in body).toBe(false);
    expect('tags' in body).toBe(false);  // the direction and intention chips were only seeded
    expect('secondary_tags' in body).toBe(false);
  });

  describe('"This & future" on a generated instance shows the template’s sets', () => {
    const instance = () => taskRow({ id: 'inst-1', tags: [], secondary_tags: [], categories: [], recurrence_parent_id: 'tmpl-1' });
    const template = () => taskRow({ id: 'tmpl-1', status: 'recurring', tags: ['work'], secondary_tags: [], categories: ['leisure'], recurrence_rule: 'FREQ=DAILY' });

    it('seeds the pickers from the template, and back from the instance on "This task"', () => {
      TASKS = [instance(), template()];
      render(() => <ElementWizard />);
      openEdit('task', 'inst-1');
      expect(chip('Leisure').className).not.toContain('border-primary');

      fireEvent.click(screen.getByRole('button', { name: 'This & future' }));
      expect(chip('Leisure').className).toContain('border-primary');

      fireEvent.click(screen.getByRole('button', { name: 'This task' }));
      expect(chip('Leisure').className).not.toContain('border-primary');
    });

    it('saves nothing about tags or categories when the seeded sets were left alone', async () => {
      TASKS = [instance(), template()];
      render(() => <ElementWizard />);
      openEdit('task', 'inst-1');
      fireEvent.click(screen.getByRole('button', { name: 'This & future' }));

      await press('Save');
      const { id, body, scope } = updateCall(0);
      expect([id, scope]).toEqual(['tmpl-1', 'series']);
      expect('categories' in body).toBe(false);
      expect('tags' in body).toBe(false);
    });

    it('sends the whole edited set when the owner changes the template’s categories', async () => {
      TASKS = [instance(), template()];
      render(() => <ElementWizard />);
      openEdit('task', 'inst-1');
      fireEvent.click(screen.getByRole('button', { name: 'This & future' }));
      fireEvent.click(chip('Career'));

      await press('Save');
      expect(updateCall(0).body.categories).toEqual(['leisure', 'career']); // the template's set plus the new one
    });

    it('does not replace a picker the owner already used when the scope is switched', () => {
      TASKS = [instance(), template()];
      render(() => <ElementWizard />);
      openEdit('task', 'inst-1');
      fireEvent.click(chip('Career'));
      fireEvent.click(screen.getByRole('button', { name: 'This & future' }));
      expect(chip('Career').className).toContain('border-primary');
      expect(chip('Leisure').className).not.toContain('border-primary');
    });

    it('an instance-scope save still goes to the instance and leaves tags out', async () => {
      TASKS = [instance(), template()];
      render(() => <ElementWizard />);
      openEdit('task', 'inst-1');
      await press('Save');
      const { id, body, scope } = updateCall(0);
      expect([id, scope]).toEqual(['inst-1', undefined]);
      expect('tags' in body).toBe(false);
    });
  });

  it('series save from an instance where the owner picked a category: it is sent', async () => {
    TASKS = [taskRow({ id: 'inst-1', categories: [], recurrence_parent_id: 'tmpl-1' })];
    render(() => <ElementWizard />);
    openEdit('task', 'inst-1');
    fireEvent.click(screen.getByRole('button', { name: 'This & future' }));
    fireEvent.click(chip('Career'));

    await press('Save');
    const { id, scope, body } = updateCall(0);
    expect([id, scope]).toEqual(['tmpl-1', 'series']);
    expect(body.categories).toEqual(['career']);
  });

  it('a touch from an earlier session does not leak: reopening the same edit sends none again', async () => {
    TASKS = [taskRow()];
    render(() => <ElementWizard />);
    openEdit('task', 'task-9');
    fireEvent.click(chip('Health'));
    setModal(CLOSED);
    openEdit('task', 'task-9');
    expect(chip('Leisure').className).toContain('border-primary');
    expect(chip('Health').className).not.toContain('border-primary');   // reseeded from the row

    await press('Save');
    expect('categories' in updateCall(0).body).toBe(false);
  });

  it('the open reset stands on its own: a touch in an Add session does not reach an edit whose row is not found', async () => {
    // loadForEdit returns before seedCategories when the row is not in the store (not loaded
    // yet, or deleted in another tab), so here only the reset in the open effect clears the
    // flag. The form is blank, so Save needs a title typed first.
    render(() => <ElementWizard />);
    open();
    fireEvent.input(titleInput(), { target: { value: 'Pay the invoice' } });
    fireEvent.click(chip('Career'));
    setModal(CLOSED);
    openEdit('task', 'task-gone');
    fireEvent.input(titleInput(), { target: { value: 'Pay the invoice' } });

    await press('Save');
    const { id, body } = updateCall(0);
    expect(id).toBe('task-gone');
    expect(body.title).toBe('Pay the invoice');
    expect('categories' in body).toBe(false);
  });

  it('a Describe-it answer that lands after the modal was reopened in Edit is dropped', async () => {
    // The parse is in flight when "open instead of adding?" (or closing the modal and
    // opening a task) puts the wizard in Edit. The answer was for the Add form that is gone:
    // it must not retitle the task, show its pick in the picker, or take the picker's place
    // on Save (which sends none when the owner has not used it).
    TASKS = [taskRow()];
    let land!: (v: unknown) => void;
    quickParseMock.mockReturnValueOnce(new Promise((resolve) => { land = resolve; }));
    render(() => <ElementWizard />);
    open();
    fireEvent.input(nlInput(), { target: { value: LINE } });
    fireEvent.keyDown(nlInput(), { key: 'Enter' });
    await waitFor(() => expect(quickParseMock).toHaveBeenCalledTimes(1));
    setModal(CLOSED);
    openEdit('task', 'task-9');
    expect(titleInput().value).toBe('Gym session');
    expect(chip('Leisure').className).toContain('border-primary');

    land(parseOk(['career'], claimFor(['career'])));
    await new Promise((resolve) => setTimeout(resolve, 0));   // let the stale continuation run
    expect(titleInput().value).toBe('Gym session');            // not the parse's title
    expect(chip('Leisure').className).toContain('border-primary');
    expect(chip('Career').className).not.toContain('border-primary');

    await press('Save');
    const { id, body } = updateCall(0);
    expect(id).toBe('task-9');
    expect(body.title).toBe('Gym session');
    expect('categories' in body).toBe(false);
  });

  it('habit edit follows the task rule: untouched sends none, used sends the picker', async () => {
    TASKS = [taskRow({ id: 'habit-1', title: 'Stretch', is_habit: true, recurrence_rule: 'FREQ=DAILY' })];
    render(() => <ElementWizard />);
    openEdit('habit', 'habit-1');
    expect(chip('Leisure').className).toContain('border-primary');

    await press('Save');
    expect(updateCall(0).id).toBe('habit-1');
    expect('categories' in updateCall(0).body).toBe(false);

    setModal(CLOSED);
    openEdit('habit', 'habit-1');
    fireEvent.click(chip('Career'));
    await press('Save', 2);
    expect(updateCall(1).body.categories).toEqual(['leisure', 'career']);
  });

  it('time block edit is outside the rule: the picker is sent whether or not it was touched', async () => {
    // A block has no learning row, and the server re-stamps its colour from the first
    // category on any category-bearing save, so an untouched edit keeps sending what it shows.
    BLOCKS = [blockRow()];
    render(() => <ElementWizard />);
    openEdit('timeblock', 'blk-1');
    expect(chip('Health').className).toContain('border-primary');

    await press('Save');
    const untouched = blocksUpdateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(untouched.title).toBe('Deep work');
    expect(untouched.categories).toEqual(['health']);
    expect(tasksUpdateMock).not.toHaveBeenCalled();

    setModal(CLOSED);
    openEdit('timeblock', 'blk-1');
    fireEvent.click(chip('Career'));
    await press('Save', 2);
    expect((blocksUpdateMock.mock.calls[1]![1] as Record<string, unknown>).categories).toEqual(['health', 'career']);
  });

  it('time block edit, untouched with no categories: [] still goes out (the explicit clear it always sent)', async () => {
    BLOCKS = [{ ...blockRow(), categories: [] }];
    render(() => <ElementWizard />);
    openEdit('timeblock', 'blk-1');

    await press('Save');
    const wire = JSON.parse(JSON.stringify(blocksUpdateMock.mock.calls[0]![1]));
    expect(wire.categories).toEqual([]);
  });

  it('ADD always sends the picker, used or not (a new row has nothing to leave alone)', async () => {
    render(() => <ElementWizard />);
    open();
    fireEvent.input(titleInput(), { target: { value: 'Pay the invoice' } });
    expect((await add()).categories).toEqual([]);

    vi.clearAllMocks();
    setModal(CLOSED);
    open();
    fireEvent.input(titleInput(), { target: { value: 'Pay the invoice' } });
    fireEvent.click(chip('Career'));
    expect((await add()).categories).toEqual(['career']);
  });
});
