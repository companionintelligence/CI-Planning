import { describe, it, expect } from 'vitest';
import { snapToSlot, minuteToHHMM, isSlotOccupied } from './create-click.js';
import type { Block } from './api.js';

/**
 * Phase AB · AB3 — the click-to-create slot math shared by CalendarGrid and the
 * Planner: the 15-min snap and the open-window rule (a snapped click inside an
 * ACTIVE block's span is a no-op for create).
 */

const DAY = '2026-07-01';

// Local wall-clock → ISO for DAY (host TZ pinned to America/Los_Angeles in
// vitest config), matching how the components' blocks are stored (UTC instants).
function iso(hhmm: string, day = DAY): string {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).toISOString();
}

// A minimal Block fixture — only the fields the occupancy check reads matter.
function block(over: Partial<Block> & { id: string }): Block {
  return {
    title: over.id,
    block_kind: 'task',
    status: 'planned',
    start_at: iso('10:00'),
    end_at: iso('11:00'),
    is_locked: false,
    is_auto: false,
    source_kind: 'manual',
    created_at: iso('00:00'),
    ...over,
  } as Block;
}

describe('snapToSlot', () => {
  it('floors onto the 15-min grid', () => {
    expect(snapToSlot(600)).toBe(600);   // 10:00 exactly
    expect(snapToSlot(614)).toBe(600);   // 10:14 → 10:00
    expect(snapToSlot(615)).toBe(615);   // 10:15 exactly
  });

  it('rounds a fractional minute BEFORE flooring (no earlier bias at slot edges)', () => {
    // 599.6 min ≈ a click a hair above 10:00 — round first (600) then floor → 600,
    // where a raw floor would have yielded 585 (9:45), a slot the user never aimed at.
    expect(snapToSlot(599.6)).toBe(600);
    expect(snapToSlot(599.4)).toBe(585); // genuinely before 10:00 → previous slot
  });

  it('caps at the last valid slot (23:45) — the axis inverse can return 1440', () => {
    expect(snapToSlot(1440)).toBe(1425);
    expect(snapToSlot(1439)).toBe(1425);
  });

  it('clamps negatives to 00:00', () => {
    expect(snapToSlot(-5)).toBe(0);
  });

  it('honours a custom snap granularity', () => {
    expect(snapToSlot(605, 30)).toBe(600);
    expect(snapToSlot(631, 30)).toBe(630);
  });
});

describe('minuteToHHMM', () => {
  it('formats minute-of-day as zero-padded HH:MM', () => {
    expect(minuteToHHMM(0)).toBe('00:00');
    expect(minuteToHHMM(65)).toBe('01:05');
    expect(minuteToHHMM(600)).toBe('10:00');
    expect(minuteToHHMM(1425)).toBe('23:45');
  });
});

describe('isSlotOccupied', () => {
  const active = [block({ id: 'a' })]; // planned, 10:00–11:00

  it('true inside an active block span, half-open [start, end)', () => {
    expect(isSlotOccupied(active, DAY, 600)).toBe(true);  // at start
    expect(isSlotOccupied(active, DAY, 630)).toBe(true);  // inside
    expect(isSlotOccupied(active, DAY, 660)).toBe(false); // at end → free
    expect(isSlotOccupied(active, DAY, 585)).toBe(false); // before → free
  });

  it('completed / cancelled / skipped blocks free their slot again', () => {
    for (const status of ['completed', 'cancelled', 'skipped']) {
      expect(isSlotOccupied([block({ id: 'x', status })], DAY, 630)).toBe(false);
    }
    // …but planned and in_progress-style statuses occupy.
    expect(isSlotOccupied([block({ id: 'y', status: 'in_progress' })], DAY, 630)).toBe(true);
  });

  it('all-day blocks (header lane) never occupy a minute-axis slot', () => {
    expect(isSlotOccupied([block({ id: 'x', all_day: true })], DAY, 630)).toBe(false);
  });

  it('someday concepts (no span semantics) never occupy', () => {
    expect(isSlotOccupied([block({ id: 'x', block_type: 'someday' })], DAY, 630)).toBe(false);
  });

  it('a block on an adjacent day is not a phantom wall on this day', () => {
    // 23:00–23:59 the PREVIOUS local day → negative minutes for DAY → free.
    const prev = block({ id: 'p', start_at: iso('23:00', '2026-06-30'), end_at: iso('23:59', '2026-06-30') });
    expect(isSlotOccupied([prev], DAY, 0)).toBe(false);
  });

  it('tolerates a block with no start/end (defensive)', () => {
    const bare = block({ id: 'b', start_at: undefined as unknown as string, end_at: undefined as unknown as string });
    expect(isSlotOccupied([bare], DAY, 630)).toBe(false);
  });
});
