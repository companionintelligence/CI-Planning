import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

/**
 * Wave-3 item 6 — collapse 12am–7am and 9pm–midnight in the CALENDAR view.
 *
 * These DOM tests prove the expander wiring at the component seam: both night
 * regions default to collapsed, each expander toggles its region, blocks living
 * inside a collapsed region are hidden until expanded, and month view (no time
 * axis) grows no expanders. The pure minute↔pixel math is exhaustively covered in
 * lib/day-axis.test.ts — this file only checks the SolidJS integration.
 */
vi.mock('../stores/index.js', () => ({
  setElementModal: vi.fn(),
}));

const { CalendarGrid } = await import('./CalendarGrid.js');

const noBlocks = () => ({});

// A timed block helper. Times are LOCAL (TZ pinned to LA in vitest config); we
// build the ISO from local wall-clock so minutesIntoDay lands where we expect.
function timedBlock(id: string, day: string, startHHMM: string, endHHMM: string, kind = 'task'): any {
  const iso = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const [y, mo, d] = day.split('-').map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0).toISOString();
  };
  return {
    id,
    title: `Block ${id}`,
    block_kind: kind,
    task_id: kind === 'task' ? `t-${id}` : null,
    status: 'planned',
    start_at: iso(startHHMM),
    end_at: iso(endHHMM),
    is_locked: false,
    all_day: false,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('CalendarGrid — night-hour collapse (day view)', () => {
  it('renders both expander bars, both collapsed by default', () => {
    const { getByTitle } = render(() => (
      <CalendarGrid view="day" days={['2026-07-01']} blocksByDay={noBlocks} />
    ));
    // Collapsed → the title invites "Expand …".
    const top = getByTitle('Expand 12am – 7am');
    const bottom = getByTitle('Expand 9pm – 12am');
    expect(top.getAttribute('aria-expanded')).toBe('false');
    expect(bottom.getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking the top expander expands 12am–7am', () => {
    const { getByTitle } = render(() => (
      <CalendarGrid view="day" days={['2026-07-01']} blocksByDay={noBlocks} />
    ));
    fireEvent.click(getByTitle('Expand 12am – 7am'));
    // Now the bar offers to collapse it again, and aria flips.
    const collapse = getByTitle('Collapse 12am – 7am');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    // The bottom region is untouched.
    expect(getByTitle('Expand 9pm – 12am').getAttribute('aria-expanded')).toBe('false');
  });

  it('a block inside the collapsed top region is hidden, and appears once expanded', () => {
    const day = '2026-07-01';
    // 02:00–03:00 lives entirely inside the collapsed top region.
    const blocks = () => ({ [day]: [timedBlock('a', day, '02:00', '03:00')] });
    const { queryByTitle, getByTitle } = render(() => (
      <CalendarGrid view="day" days={[day]} blocksByDay={blocks} />
    ));
    // Chip carries a title with an en-dash range; it should be absent while collapsed.
    const chipTitle = (t: string) => t.startsWith('Block a ·');
    const findChip = () => Array.from(document.querySelectorAll('[title]')).find(
      (el) => chipTitle(el.getAttribute('title') || ''),
    );
    expect(findChip()).toBeUndefined();
    // Expand the top region → the chip appears.
    fireEvent.click(getByTitle('Expand 12am – 7am'));
    expect(findChip()).toBeTruthy();
  });

  it('a middle-of-day block is always visible regardless of collapse state', () => {
    const day = '2026-07-01';
    const blocks = () => ({ [day]: [timedBlock('m', day, '10:00', '11:00')] });
    render(() => <CalendarGrid view="day" days={[day]} blocksByDay={blocks} />);
    const findChip = () => Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el.getAttribute('title') || '').startsWith('Block m ·'),
    );
    expect(findChip()).toBeTruthy();
  });

  it('click-to-create on the visible middle grid still fires onCreateAt', () => {
    const day = '2026-07-01';
    const onCreateAt = vi.fn();
    const { container } = render(() => (
      <CalendarGrid view="day" days={[day]} blocksByDay={noBlocks} onCreateAt={onCreateAt} />
    ));
    const col = container.querySelector('[title="Click an empty slot to add"]') as HTMLElement;
    expect(col).toBeTruthy();
    // A near-zero pointer move = a click. Y is arbitrary here; the exact time is
    // covered by day-axis unit tests. We only assert the handler still fires.
    col.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.pointerDown(col, { clientX: 20, clientY: 300 });
    fireEvent(window, new PointerEvent('pointerup', { clientX: 20, clientY: 300 }));
    expect(onCreateAt).toHaveBeenCalledTimes(1);
    expect(onCreateAt.mock.calls[0][0]).toBe(day);
  });
});

describe('CalendarGrid — collapse is calendar-time-axis only', () => {
  it('month view renders no expander bars', () => {
    const { queryByTitle } = render(() => (
      <CalendarGrid view="month" days={['2026-07-01', '2026-07-02']} blocksByDay={noBlocks} />
    ));
    expect(queryByTitle('Expand 12am – 7am')).toBeNull();
    expect(queryByTitle('Expand 9pm – 12am')).toBeNull();
  });

  it('week view shares one expander pair across all day columns', () => {
    const { getAllByTitle } = render(() => (
      <CalendarGrid view="week" days={['2026-07-01', '2026-07-02']} blocksByDay={noBlocks} />
    ));
    // One bar per region for the whole grid — not one per column.
    expect(getAllByTitle('Expand 12am – 7am')).toHaveLength(1);
    expect(getAllByTitle('Expand 9pm – 12am')).toHaveLength(1);
  });
});
