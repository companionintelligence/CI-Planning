import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

/**
 * Wave-3 item 5 — every date is selectable to set its day type.
 *
 * These DOM tests prove the two new selection affordances at the exact seam the
 * feature lives on: the week day-column HEADER button and the month cell DATE
 * NUMBER button both fire `onSelectDate`, and crucially the month date number
 * does NOT also fire the cell's `onCreateAt` (add-task) handler — the
 * stopPropagation guard is the whole point of item 5's "don't collide" clause.
 *
 * CalendarGrid pulls `setElementModal` from the app store at import time (used only
 * inside a block-chip handler we never exercise here), so we stub the store to keep
 * the render network-free and store-free.
 */
vi.mock('../stores/index.js', () => ({
  setElementModal: vi.fn(),
}));

const { CalendarGrid } = await import('./CalendarGrid.js');

const noBlocks = () => ({});

beforeEach(() => vi.clearAllMocks());

describe('CalendarGrid — date selection (week header)', () => {
  it('clicking a week day header fires onSelectDate with that date', () => {
    const onSelectDate = vi.fn();
    const onCreateAt = vi.fn();
    const { getByText } = render(() => (
      <CalendarGrid
        view="week"
        days={['2026-07-01', '2026-07-02']}
        blocksByDay={noBlocks}
        onSelectDate={onSelectDate}
        onCreateAt={onCreateAt}
        selectedDate={() => null}
      />
    ));
    // The "2" belongs to 2026-07-02's header button.
    fireEvent.click(getByText('2'));
    expect(onSelectDate).toHaveBeenCalledWith('2026-07-02');
    // Header selection lives outside the time grid → never arms add-task.
    expect(onCreateAt).not.toHaveBeenCalled();
  });

  it('marks the selected header with aria-pressed', () => {
    const { getByText } = render(() => (
      <CalendarGrid
        view="week"
        days={['2026-07-01', '2026-07-02']}
        blocksByDay={noBlocks}
        onSelectDate={vi.fn()}
        selectedDate={() => '2026-07-02'}
      />
    ));
    const btn = getByText('2').closest('button')!;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    const other = getByText('1').closest('button')!;
    expect(other.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('CalendarGrid — date selection (month cell number)', () => {
  it('clicking a month date number selects it WITHOUT triggering add-task', () => {
    const onSelectDate = vi.fn();
    const onCreateAt = vi.fn();
    const { getByText } = render(() => (
      <CalendarGrid
        view="month"
        days={['2026-07-01', '2026-07-02', '2026-07-03']}
        blocksByDay={noBlocks}
        onSelectDate={onSelectDate}
        onCreateAt={onCreateAt}
        selectedDate={() => null}
      />
    ));
    fireEvent.click(getByText('2'));
    expect(onSelectDate).toHaveBeenCalledWith('2026-07-02');
    // stopPropagation on the date-number button keeps the cell's add-task from firing.
    expect(onCreateAt).not.toHaveBeenCalled();
  });

  it('clicking empty cell space still fires add-task (selection did not steal it)', () => {
    const onSelectDate = vi.fn();
    const onCreateAt = vi.fn();
    const { container } = render(() => (
      <CalendarGrid
        view="month"
        days={['2026-07-01']}
        blocksByDay={noBlocks}
        onSelectDate={onSelectDate}
        onCreateAt={onCreateAt}
        selectedDate={() => null}
      />
    ));
    // The cell is the element carrying the onCreateAt onClick (title "Click to add").
    const cell = container.querySelector('[title="Click to add"]') as HTMLElement;
    expect(cell).toBeTruthy();
    fireEvent.click(cell);
    expect(onCreateAt).toHaveBeenCalledWith('2026-07-01', '09:00');
    expect(onSelectDate).not.toHaveBeenCalled();
  });
});
