import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@solidjs/testing-library';

/**
 * People on work (0151) — the shared field behind BOTH Responsible and Beneficiaries.
 *
 * The behaviours worth pinning at the DOM seam are the ones the design argument turns
 * on, not the rendering:
 *  1. the shortcuts are EXPANSION ACTIONS — each fills the set and every chip stays
 *     removable afterwards;
 *  2. `us` = you + others, reaching NAMED people on a single-account install (the
 *     roster being empty must not make it a synonym for `me`);
 *  3. `them` excludes you and fills nothing on its own — only the user names the others;
 *  4. "Create <name>" is always reachable, so the directory is never a prerequisite.
 */

const createPerson = vi.fn();
const fromAccount = vi.fn();
const showToast = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    people: {
      create: (...a: unknown[]) => createPerson(...a),
      fromAccount: (...a: unknown[]) => fromAccount(...a),
    },
  },
}));
vi.mock('../stores/index.js', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

const { PeopleField } = await import('./PeopleField.js');

type Person = Parameters<typeof PeopleField>[0]['value'][number];
type Props = Parameters<typeof PeopleField>[0];

const person = (over: Partial<Person> = {}): Person => ({
  id: 'p-self', display_name: 'Alex', account_id: 'own-1', is_self: true,
  confirmed: true, source: 'account', emails: ['alex@example.com'], ...over,
});

const SELF = person();
const WIFE = person({ id: 'p-wife', display_name: 'Wife', account_id: null, is_self: false });
const COLLEAGUE = person({ id: 'p-col', display_name: 'Chris', account_id: 'own-2', is_self: false });

beforeEach(() => vi.clearAllMocks());

function baseProps(): Props {
  return {
    label: 'Responsible',
    value: [],
    onChange: vi.fn(),
    directory: [SELF, WIFE],
    roster: [],
    onDirectoryChanged: vi.fn(),
  };
}

function setup(over: Partial<Props> = {}) {
  const onChange = vi.fn();
  const props: Props = {
    label: 'Responsible',
    value: [],
    onChange,
    directory: [SELF, WIFE],
    roster: [],
    onDirectoryChanged: vi.fn(),
    ...over,
  };
  render(() => <PeopleField {...props} />);
  return { onChange, props };
}

describe('shortcuts fill the set', () => {
  it('me sets exactly you', async () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByText('me'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toEqual([SELF]);
  });

  it('us reaches NAMED people when the roster is empty (single sign-on account)', async () => {
    // The correction that matters: `us` means you + another PERSON, not you + another
    // ACCOUNT. With no roster it seeds you and opens the picker so a named person can
    // complete the set — it must never quietly resolve to `me`.
    const { onChange } = setup({ roster: [] });
    fireEvent.click(screen.getByText('us'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([SELF]));

    // The picker is open, and the named person with no login is offered.
    await waitFor(() => expect(screen.getByPlaceholderText('Search or type a name…')).toBeTruthy());
    expect(screen.getByText('Wife')).toBeTruthy();
  });

  it('us pre-fills every known account alongside you', async () => {
    fromAccount.mockResolvedValue({ person: COLLEAGUE });
    const { onChange } = setup({
      directory: [SELF, WIFE, COLLEAGUE],
      roster: [{ account_id: 'own-2', name: 'Chris', person_id: 'p-col' }],
    });
    fireEvent.click(screen.getByText('us'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.map((p: { id: string }) => p.id)).toEqual(['p-self', 'p-col']);
  });

  it('us is ADDITIVE — a named person already on the field survives it', async () => {
    // The review fix: `us` used to rebuild the set from empty, so tapping it deleted
    // the wife-with-no-login — exactly the case the two-population design exists for.
    fromAccount.mockResolvedValue({ person: COLLEAGUE });
    const { onChange } = setup({
      value: [WIFE],
      directory: [SELF, WIFE, COLLEAGUE],
      roster: [{ account_id: 'own-2', name: 'Chris', person_id: 'p-col' }],
    });
    fireEvent.click(screen.getByText('us'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.map((p: { id: string }) => p.id)).toEqual(['p-wife', 'p-self', 'p-col']);
  });

  it('them drops you and fills nothing on its own', async () => {
    const { onChange } = setup({ value: [SELF, WIFE] });
    fireEvent.click(screen.getByText('them'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Only you are removed; who the "others" are is the user's to say.
    expect(onChange.mock.calls[0][0]).toEqual([WIFE]);
  });
});

describe('the set stays editable after a shortcut', () => {
  it('removes a single chip without touching the rest', async () => {
    const { onChange } = setup({ value: [SELF, WIFE] });
    fireEvent.click(screen.getByLabelText('Remove Wife'));
    expect(onChange).toHaveBeenCalledWith([SELF]);
  });

  it('adds someone from the directory', async () => {
    const { onChange } = setup({ value: [SELF] });
    fireEvent.click(screen.getByText('Add'));
    fireEvent.click(await screen.findByText('Wife'));
    expect(onChange.mock.calls[0][0].map((p: { id: string }) => p.id)).toEqual(['p-self', 'p-wife']);
  });

  it('never offers somebody already attached', async () => {
    setup({ value: [WIFE] });
    fireEvent.click(screen.getByText('Add'));
    await screen.findByPlaceholderText('Search or type a name…');
    // 'Wife' appears once — as the attached chip, not as a pickable row.
    expect(screen.getAllByText('Wife')).toHaveLength(1);
  });
});

describe('creating a person inline', () => {
  it('offers Create for a new name and attaches the result', async () => {
    createPerson.mockResolvedValue({
      person: { ...WIFE, id: 'p-new', display_name: 'Neighbour' },
    });
    const { onChange, props } = setup();
    fireEvent.click(screen.getByText('Add'));
    const input = await screen.findByPlaceholderText('Search or type a name…');
    fireEvent.input(input, { target: { value: 'Neighbour' } });

    fireEvent.click(await screen.findByText(/Create/));
    await waitFor(() => expect(createPerson).toHaveBeenCalledWith({ display_name: 'Neighbour' }));
    expect(onChange.mock.calls[0][0].map((p: { id: string }) => p.id)).toEqual(['p-new']);
    // The other field shares the directory resource, so it has to be told.
    expect(props.onDirectoryChanged).toHaveBeenCalled();
  });

  it('does not offer Create for a name that already exists', async () => {
    setup();
    fireEvent.click(screen.getByText('Add'));
    const input = await screen.findByPlaceholderText('Search or type a name…');
    fireEvent.input(input, { target: { value: 'wife' } }); // case-insensitive match
    expect(screen.queryByText(/Create/)).toBeNull();
  });
});

describe('provisional people are marked', () => {
  it('flags an unconfirmed person so a detected guess is never mistaken for a choice', () => {
    setup({ value: [person({ id: 'p-x', display_name: 'Dana', is_self: false, confirmed: false })] });
    expect(screen.getByTitle(/Detected automatically/)).toBeTruthy();
  });
});

describe('the suggested hint reflects provenance, not recency', () => {
  it('labels a machine-attached set, and leaves a user-curated one alone', () => {
    const detected = person({ id: 'p-d', display_name: 'Dana', is_self: false, attachment_source: 'calendar' });
    const { unmount } = render(() => (
      <PeopleField {...({ ...baseProps(), value: [detected], suggested: true } as Props)} />
    ));
    expect(screen.getByText(/\(suggested\)/)).toBeTruthy();
    unmount();

    // Same field, same "untouched this session" — but the owner picked these, so
    // calling them a suggestion would be a lie.
    const curated = person({ id: 'p-c', display_name: 'Chris', is_self: false, attachment_source: 'user' });
    render(() => <PeopleField {...({ ...baseProps(), value: [curated], suggested: true } as Props)} />);
    expect(screen.queryByText(/\(suggested\)/)).toBeNull();
  });
});

describe('an inheriting field is distinguishable from an empty one', () => {
  it('says it is following the task and shows those people, rather than looking empty', () => {
    render(() => (
      <PeopleField {...({ ...baseProps(), value: [WIFE], inheriting: true, onOverride: vi.fn() } as Props)} />
    ));
    // Collapsing "inheriting" and "nobody" into the same empty field would undo exactly
    // what the per-role pin exists to separate.
    expect(screen.getByText('Following the linked task')).toBeTruthy();
    expect(screen.getByText('Wife')).toBeTruthy();
    expect(screen.getByText('Override')).toBeTruthy();
  });

  it('offers Override to stop following, which is the inverse of Use task’s', () => {
    const onOverride = vi.fn();
    render(() => (
      <PeopleField {...({ ...baseProps(), value: [WIFE], inheriting: true, onOverride } as Props)} />
    ));
    fireEvent.click(screen.getByText('Override'));
    expect(onOverride).toHaveBeenCalled();
  });
});

describe('the inherit affordance', () => {
  it('offers "Use task’s" only when the field can give up an override', () => {
    const onInherit = vi.fn();
    // Currently overriding → the escape hatch is offered.
    const { unmount } = render(() => (
      <PeopleField {...({ ...baseProps(), value: [WIFE], onInherit, inheriting: false } as Props)} />
    ));
    fireEvent.click(screen.getByText("Use task's"));
    expect(onInherit).toHaveBeenCalled();
    unmount();

    // Already inheriting → nothing to undo, so it is hidden rather than inert.
    render(() => (
      <PeopleField {...({ ...baseProps(), value: [WIFE], onInherit, inheriting: true } as Props)} />
    ));
    expect(screen.queryByText("Use task's")).toBeNull();
  });

  it('is absent entirely when the item has no task to inherit from', () => {
    render(() => <PeopleField {...({ ...baseProps(), value: [WIFE] } as Props)} />);
    expect(screen.queryByText("Use task's")).toBeNull();
  });
});
