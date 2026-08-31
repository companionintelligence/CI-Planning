import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import { activeBlock, setActiveBlock } from '../stores/selection.js';

/**
 * Phase 4 — the Calendar draws containment the way the Planner does.
 *
 * Before this split, `layoutBlocks` treated every timed block as a flat sibling: a
 * task nested in a Time Block was swept into the same overlap cluster as its own
 * container, tiled BESIDE it, and — because `cols > 1` is the conflict signal —
 * ringed amber, so the app reported a scheduling collision between a container and
 * the thing it contains. These tests pin the corrected model:
 *
 *   • members leave the top-level pass and lay out inside their container;
 *   • a member never conflicts with its container;
 *   • real conflicts — container vs container, sibling vs sibling, foreign vs
 *     container — still ring.
 *
 * Mock setup mirrors CalendarGrid.create.test.tsx. Blocks carry no
 * source_provider/source_account, so `connectionPrefs` is never read (it is not in
 * the store mock, matching the other CalendarGrid suites).
 */
vi.mock('../stores/index.js', async () => {
  const { createSignal } = await import('solid-js');
  const [state] = createSignal({ topExpanded: false, bottomExpanded: false });
  return {
    setElementModal: vi.fn(),
    categoryPrefs: () => ({ prefs: {} }),
    // Phase 7 — the component reads this for the stranded-block treatment.
    conflictedBlockIds: () => new Set<string>(),
    calendarAxisState: state,
    toggleCalendarTop: vi.fn(),
    toggleCalendarBottom: vi.fn(),
  };
});

const { CalendarGrid, splitContainment, layoutBlocks } = await import('./CalendarGrid.js');

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBlock(null);
});

const DAY = '2026-07-01';
const CONFLICT_RING = 'ring-amber-400/70';

const iso = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = DAY.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).toISOString();
};

/** A timed block. `opts` carries the containment fields under test. */
function blk(
  id: string,
  title: string,
  startHHMM: string,
  endHHMM: string,
  opts: { kind?: string; parent?: string | null; allDay?: boolean } = {},
): any {
  const kind = opts.kind ?? 'task';
  return {
    id,
    title,
    block_kind: kind,
    task_id: kind === 'task' ? `t-${id}` : undefined,
    parent_block_id: opts.parent ?? null,
    status: 'planned',
    start_at: iso(startHHMM),
    end_at: iso(endHHMM),
    is_locked: false,
    all_day: opts.allDay ?? false,
  };
}

const container = (id: string, title: string, s: string, e: string) =>
  blk(id, title, s, e, { kind: 'timeblock' });
const member = (id: string, title: string, s: string, e: string, parent: string) =>
  blk(id, title, s, e, { parent });

/** The scenario from the defect screenshot: one task nested in one Time Block. */
const DEEP_WORK = container('tb1', 'Deep work', '12:00', '14:00');
const WRITE_SPEC = member('m1', 'Write spec', '12:30', '13:30', 'tb1');

function renderGrid(blocks: any[], view: 'day' | 'week' = 'day') {
  const days = view === 'week'
    ? ['2026-06-29', '2026-06-30', DAY, '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']
    : [DAY];
  const { container: root } = render(() => (
    <CalendarGrid view={view} days={days} blocksByDay={() => ({ [DAY]: blocks })} />
  ));
  return root;
}

/** The rendered chip whose tooltip starts with this title. */
function chip(root: HTMLElement, title: string): HTMLElement {
  const el = root.querySelector(`[title^="${title} ·"]`) as HTMLElement;
  expect(el, `no chip rendered for "${title}"`).toBeTruthy();
  return el;
}

describe('splitContainment — which blocks leave the top-level pass', () => {
  it('a member whose container is on this day nests under it', () => {
    const { top, membersOf } = splitContainment([DEEP_WORK, WRITE_SPEC]);
    expect(top.map((b) => b.id)).toEqual(['tb1']);
    expect(membersOf.get('tb1')?.map((b) => b.id)).toEqual(['m1']);
  });

  it('an orphan member — container not on this day — stays top-level so it still renders', () => {
    // The container is absent from the day's blocks (a range fetch boundary, a
    // cross-day parent). Dropping the member would make it vanish from the grid.
    const { top, membersOf } = splitContainment([WRITE_SPEC]);
    expect(top.map((b) => b.id)).toEqual(['m1']);
    expect(membersOf.size).toBe(0);
  });

  it('a parent that is not a timeblock does not make a container', () => {
    // Matches the server: isValidParent only accepts block_kind = 'timeblock'.
    const meeting = blk('mtg', 'Standup', '12:00', '14:00', { kind: 'meeting' });
    const child = member('m2', 'Child', '12:30', '13:00', 'mtg');
    const { top, membersOf } = splitContainment([meeting, child]);
    expect(top.map((b) => b.id).sort()).toEqual(['m2', 'mtg']);
    expect(membersOf.size).toBe(0);
  });

  it('an all-day member stays top-level — it never reaches the minute axis', () => {
    const allDayChild = blk('ad', 'All day', '00:00', '23:59', { parent: 'tb1', allDay: true });
    const { top, membersOf } = splitContainment([DEEP_WORK, allDayChild]);
    expect(top.map((b) => b.id).sort()).toEqual(['ad', 'tb1']);
    expect(membersOf.size).toBe(0);
  });

  it('several members of one container collect together', () => {
    const second = member('m2', 'Review', '13:30', '14:00', 'tb1');
    const { top, membersOf } = splitContainment([DEEP_WORK, WRITE_SPEC, second]);
    expect(top.map((b) => b.id)).toEqual(['tb1']);
    expect(membersOf.get('tb1')?.map((b) => b.id)).toEqual(['m1', 'm2']);
  });
});

describe('layout passes — conflict is cluster width within a pass', () => {
  it('a container with one member is alone in the top pass (no conflict)', () => {
    const { top, membersOf } = splitContainment([DEEP_WORK, WRITE_SPEC]);
    expect(layoutBlocks(top, DAY).every((p) => p.cols === 1)).toBe(true);
    // ...and the member is alone in its own pass, so it does not ring either.
    expect(layoutBlocks(membersOf.get('tb1')!, DAY).every((p) => p.cols === 1)).toBe(true);
  });

  it('two overlapping containers still conflict', () => {
    const other = container('tb2', 'Errands', '13:00', '15:00');
    const { top } = splitContainment([DEEP_WORK, other]);
    expect(layoutBlocks(top, DAY).every((p) => p.cols === 2)).toBe(true);
  });

  it('two members double-booked inside one container conflict with each other', () => {
    const clash = member('m2', 'Also spec', '12:45', '13:45', 'tb1');
    const { membersOf } = splitContainment([DEEP_WORK, WRITE_SPEC, clash]);
    expect(layoutBlocks(membersOf.get('tb1')!, DAY).every((p) => p.cols === 2)).toBe(true);
  });

  it('a foreign block overlapping a container conflicts with the container', () => {
    // The collision surfaces on the container — the member is inside it, so the
    // container's span is what the foreign block actually competes with.
    const foreign = blk('f1', 'Dentist', '13:00', '15:00');
    const { top } = splitContainment([DEEP_WORK, WRITE_SPEC, foreign]);
    const placed = layoutBlocks(top, DAY);
    expect(placed.map((p) => p.block.id).sort()).toEqual(['f1', 'tb1']);
    expect(placed.every((p) => p.cols === 2)).toBe(true);
  });
});

describe('CalendarGrid — containment rendering (day view)', () => {
  it('a nested task renders with no conflict ring on either chip', () => {
    const root = renderGrid([DEEP_WORK, WRITE_SPEC]);
    expect(chip(root, 'Write spec').classList.contains(CONFLICT_RING)).toBe(false);
    expect(chip(root, 'Deep work').classList.contains(CONFLICT_RING)).toBe(false);
  });

  it('the container is an outline box — no card fill to paint over its members', () => {
    const root = renderGrid([DEEP_WORK, WRITE_SPEC]);
    const box = chip(root, 'Deep work');
    expect(box.classList.contains('border-2')).toBe(true);
    expect(box.classList.contains('bg-card')).toBe(false);
    // The member keeps the ordinary card treatment.
    expect(chip(root, 'Write spec').classList.contains('bg-card')).toBe(true);
  });

  it('the member is framed inside the container, not tiled beside it', () => {
    const root = renderGrid([DEEP_WORK, WRITE_SPEC]);
    const m = chip(root, 'Write spec');
    // Inset past the container's 15px label edge — the nested frame. The old flat
    // layout put a second cluster column at left: 50%.
    expect(m.style.left).toContain('15px');
    expect(m.style.left).not.toBe('50%');
  });

  it('two overlapping containers both ring', () => {
    const root = renderGrid([DEEP_WORK, container('tb2', 'Errands', '13:00', '15:00')]);
    expect(chip(root, 'Deep work').classList.contains(CONFLICT_RING)).toBe(true);
    expect(chip(root, 'Errands').classList.contains(CONFLICT_RING)).toBe(true);
  });

  it('a foreign block overlapping the container rings the container, not the member', () => {
    const root = renderGrid([DEEP_WORK, WRITE_SPEC, blk('f1', 'Dentist', '13:00', '15:00')]);
    expect(chip(root, 'Deep work').classList.contains(CONFLICT_RING)).toBe(true);
    expect(chip(root, 'Dentist').classList.contains(CONFLICT_RING)).toBe(true);
    expect(chip(root, 'Write spec').classList.contains(CONFLICT_RING)).toBe(false);
  });

  it('two members double-booked inside one container both ring', () => {
    const root = renderGrid([DEEP_WORK, WRITE_SPEC, member('m2', 'Also spec', '12:45', '13:45', 'tb1')]);
    expect(chip(root, 'Write spec').classList.contains(CONFLICT_RING)).toBe(true);
    expect(chip(root, 'Also spec').classList.contains(CONFLICT_RING)).toBe(true);
    expect(chip(root, 'Deep work').classList.contains(CONFLICT_RING)).toBe(false);
  });

  it('an orphan member still renders (its container is not on this day)', () => {
    const root = renderGrid([WRITE_SPEC]);
    expect(chip(root, 'Write spec').classList.contains(CONFLICT_RING)).toBe(false);
  });
});

describe('CalendarGrid — a standalone container with no members', () => {
  // Regression: a bare `block_kind: 'timeblock'` row on an otherwise-empty day (the
  // shape `POST /api/blocks`/instantiate produces before any task is nested under
  // it) was suspected of never reaching the DOM. It does reach the DOM — it renders
  // unlabeled by design (overlay.ts's showsBlockLabel, the thick-left-edge
  // affordance) — but the chip element itself must exist and stay clickable, or the
  // container really would be an invisible, unreachable dead zone on the grid.
  const LONE = container('tb-lone', 'Test Container', '10:00', '11:00');

  it('renders a chip element for the container even though it shows no title text', () => {
    const root = renderGrid([LONE]);
    const box = chip(root, 'Test Container');
    // No visible label body — `showsBlockLabel` deliberately excludes bare
    // containers — but the outline box and its tooltip must still be there.
    expect(box.textContent).toBe('');
    expect(box.getAttribute('title')).toContain('Test Container');
    expect(box.classList.contains('border-2')).toBe(true);
  });

  it('is clickable — selecting it sets the active block like any other chip', () => {
    const root = renderGrid([LONE]);
    const box = chip(root, 'Test Container');
    expect(activeBlock()).toBe(null);
    fireEvent.click(box);
    expect(activeBlock()).toBe('tb-lone');
  });
});

describe('CalendarGrid — containment rendering (week view)', () => {
  it('the nested scenario renders unringed in a week column too', () => {
    const root = renderGrid([DEEP_WORK, WRITE_SPEC], 'week');
    expect(chip(root, 'Write spec').classList.contains(CONFLICT_RING)).toBe(false);
    expect(chip(root, 'Deep work').classList.contains(CONFLICT_RING)).toBe(false);
    expect(chip(root, 'Write spec').style.left).toContain('15px');
  });
});
