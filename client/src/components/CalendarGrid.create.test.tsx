import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import { yOf } from '../lib/day-axis.js';
import { PX_PER_MIN } from '../lib/grid.js';

/**
 * Phase AB · AB3 — the open-window rule at the CalendarGrid seam: a click whose
 * snapped time falls inside an ACTIVE block's span must NOT fire onCreateAt,
 * while free slots (including a done block's now-open span) still do. The pure
 * snap/occupancy math is covered in lib/create-click.test.ts — this file checks
 * only the SolidJS integration. Mock setup mirrors CalendarGrid.collapse.test.tsx.
 */
vi.mock('../stores/index.js', async () => {
  const { createSignal } = await import('solid-js');
  const DEFAULT = { topExpanded: false, bottomExpanded: false };
  const [state, setState] = createSignal({ ...DEFAULT });
  return {
    setElementModal: vi.fn(),
    // Chips colour via blockColorVar(block, categoryPrefs) — same source as the Planner.
    categoryPrefs: () => ({ prefs: {} }),
    // Phase 7 — the component reads this for the stranded-block treatment.
    conflictedBlockIds: () => new Set<string>(),
    calendarAxisState: state,
    __resetCalendarAxisState: () => setState({ ...DEFAULT }),
    toggleCalendarTop: () => setState((s: typeof DEFAULT) => ({ ...s, topExpanded: !s.topExpanded })),
    toggleCalendarBottom: () => setState((s: typeof DEFAULT) => ({ ...s, bottomExpanded: !s.bottomExpanded })),
  };
});

const stores = await import('../stores/index.js');
const { CalendarGrid } = await import('./CalendarGrid.js');

beforeEach(() => {
  (stores as unknown as { __resetCalendarAxisState: () => void }).__resetCalendarAxisState();
  vi.clearAllMocks();
});

const DAY = '2026-07-01';

// A timed block helper (local wall-clock → ISO; TZ pinned to LA in vitest config).
function timedBlock(id: string, startHHMM: string, endHHMM: string, status = 'planned'): any {
  const iso = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const [y, mo, d] = DAY.split('-').map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0).toISOString();
  };
  return {
    id,
    title: `Block ${id}`,
    block_kind: 'task',
    task_id: `t-${id}`,
    status,
    start_at: iso(startHHMM),
    end_at: iso(endHHMM),
    is_locked: false,
    all_day: false,
  };
}

// Default axis state (both night regions collapsed) — the grid Y for a minute.
const AXIS = { topExpanded: false, bottomExpanded: false };
const yAt = (minute: number) => yOf(minute, AXIS, PX_PER_MIN) + 1; // +1px: inside the slot

function renderGrid(blocks: any[]) {
  const onCreateAt = vi.fn();
  const { container } = render(() => (
    <CalendarGrid view="day" days={[DAY]} blocksByDay={() => ({ [DAY]: blocks })} onCreateAt={onCreateAt} />
  ));
  const col = container.querySelector('[title="Click an empty slot to add"]') as HTMLElement;
  expect(col).toBeTruthy();
  col.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { col, onCreateAt };
}

// A near-zero pointer move = a click on the empty grid space at Y.
function clickAt(col: HTMLElement, y: number) {
  fireEvent.pointerDown(col, { clientX: 20, clientY: y });
  fireEvent(window, new PointerEvent('pointerup', { clientX: 20, clientY: y }));
}

describe('CalendarGrid — AB3 open-window enforcement (click-to-create)', () => {
  it('a click over an active block\'s span is a no-op', () => {
    const { col, onCreateAt } = renderGrid([timedBlock('a', '10:00', '11:00')]);
    clickAt(col, yAt(10 * 60 + 30)); // 10:30 — inside the span
    expect(onCreateAt).not.toHaveBeenCalled();
  });

  it('a click just above a block that SNAPS into its span is also a no-op', () => {
    const { col, onCreateAt } = renderGrid([timedBlock('a', '10:45', '11:30')]);
    clickAt(col, yAt(10 * 60 + 50)); // 10:50 → snaps to 10:45 = the block's start
    expect(onCreateAt).not.toHaveBeenCalled();
  });

  it('a click on a free slot still fires with the snapped time', () => {
    const { col, onCreateAt } = renderGrid([timedBlock('a', '10:00', '11:00')]);
    clickAt(col, yAt(12 * 60)); // 12:00 — a free hour
    expect(onCreateAt).toHaveBeenCalledTimes(1);
    expect(onCreateAt).toHaveBeenCalledWith(DAY, '12:00');
  });

  it('a completed block\'s span is an open window again', () => {
    const { col, onCreateAt } = renderGrid([timedBlock('a', '10:00', '11:00', 'completed')]);
    clickAt(col, yAt(10 * 60 + 30));
    expect(onCreateAt).toHaveBeenCalledWith(DAY, '10:30');
  });

  it('tapping the block chip itself never reaches the create handler (edit stays edit)', () => {
    const { onCreateAt } = renderGrid([timedBlock('a', '10:00', '11:00')]);
    const chip = Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el.getAttribute('title') || '').startsWith('Block a ·'),
    ) as HTMLElement;
    expect(chip).toBeTruthy();
    fireEvent.pointerDown(chip, { clientX: 20, clientY: yAt(10 * 60 + 30) });
    fireEvent(window, new PointerEvent('pointerup', { clientX: 20, clientY: yAt(10 * 60 + 30) }));
    expect(onCreateAt).not.toHaveBeenCalled();
  });
});
