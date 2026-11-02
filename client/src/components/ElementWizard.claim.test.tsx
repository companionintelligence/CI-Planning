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
 *   5. closing and reopening the modal forgets it.
 *
 * The REAL lib/element.ts runs (claimIfFaithful, saveElement), so `api.tasks.create` is
 * the wire seam. Mocked: `../lib/api.js` and `../stores/index.js` (plus three leaf
 * widgets that need browser APIs and say nothing about the claim).
 */

const quickParseMock = vi.fn();
const tasksCreateMock = vi.fn(async (_b: unknown) => ({ task: { id: 'task-new' } }));
const blocksCreateMock = vi.fn(async (_b: unknown) => ({ block: { id: 'blk-new' } }));
const showToastMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    people: { list: async () => ({ people: [] }), accounts: async () => ({ accounts: [] }) },
    calibration: { suggest: async () => ({ suggestion: null }) },
    tags: { create: vi.fn(async () => ({})) },
    tasks: {
      quickParse: (...a: unknown[]) => quickParseMock(...a),
      create: (b: unknown) => tasksCreateMock(b),
      update: vi.fn(async () => ({})),
      suggestTags: async () => ({ tags: [] }),
      suggestSubtasks: async () => ({ subtasks: [] }),
    },
    blocks: { create: (b: unknown) => blocksCreateMock(b), update: vi.fn(async () => ({})), addTasks: vi.fn(async () => ({})) },
    patterns: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), placeToday: vi.fn(async () => ({})) },
  },
}));

// The picker offers health / leisure / career. 'finance' is deliberately NOT here: a
// parse naming it stands in for a category created in another tab and not yet refetched.
const TAGS = [
  { id: 'd1', name: 'work', kind: 'direction', directions: [] },
  { id: 'd2', name: 'home', kind: 'direction', directions: [] },
  { id: 'c1', name: 'health', kind: 'category', directions: [] },
  { id: 'c2', name: 'leisure', kind: 'category', directions: [] },
  { id: 'c3', name: 'career', kind: 'category', directions: [] },
];

type ModalState = { open: boolean; mode: 'add' | 'edit'; kind: 'task' | 'timeblock' | null };
const CLOSED: ModalState = { open: false, mode: 'add', kind: null };
const [modal, setModal] = createSignal<ModalState>(CLOSED);

vi.mock('../stores/index.js', () => ({
  elementModal: () => modal(),
  setElementModal: (v: ModalState) => setModal(v),
  tags: () => TAGS,
  blocks: () => [], concepts: () => [], tasks: () => [], patterns: () => [], patternTypes: () => [],
  patternPrefs: () => ({ prefs: {} }), categoryPrefs: () => ({ prefs: {} }), prefs: () => ({}),
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

beforeEach(() => {
  vi.clearAllMocks();
  quickParseMock.mockReset();
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
