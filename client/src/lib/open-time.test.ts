import { describe, expect, it } from 'vitest';
import {
  busyFromBlocks, formatClock, formatDuration, mergeRanges, openTime,
  parseHHMM, subtractBusy, totalOpen, MIN_OPEN_MINUTES,
} from './open-time.js';
import type { Block } from './api.js';

const at = (h: number, m = 0) => h * 60 + m;
/** Just the shape assertions care about, so failures read as times not objects. */
const shape = (segs: ReturnType<typeof openTime>) =>
  segs.map((s) => `${s.directions.join('+')} ${formatClock(s.start)}-${formatClock(s.end)}`);

describe('parseHHMM', () => {
  it('parses a window bound', () => {
    expect(parseHHMM('09:00')).toBe(540);
    expect(parseHHMM('9:05')).toBe(545);
    expect(parseHHMM('23:59')).toBe(1439);
  });

  it('returns null rather than NaN for junk', () => {
    // A malformed window must not silently become minute NaN and poison the maths.
    for (const bad of ['', 'noon', '25:00', '09:60', '0900', '09:0']) {
      expect(parseHHMM(bad)).toBeNull();
    }
  });
});

describe('mergeRanges', () => {
  it('merges overlapping and touching ranges', () => {
    expect(mergeRanges([{ start: 60, end: 120 }, { start: 90, end: 180 }]))
      .toEqual([{ start: 60, end: 180 }]);
    expect(mergeRanges([{ start: 60, end: 120 }, { start: 120, end: 180 }]))
      .toEqual([{ start: 60, end: 180 }]);
  });

  it('drops zero and negative-length ranges', () => {
    expect(mergeRanges([{ start: 60, end: 60 }, { start: 120, end: 90 }])).toEqual([]);
  });

  it('sorts before merging, so input order does not matter', () => {
    expect(mergeRanges([{ start: 300, end: 360 }, { start: 60, end: 120 }]))
      .toEqual([{ start: 60, end: 120 }, { start: 300, end: 360 }]);
  });
});

describe('subtractBusy', () => {
  const window = { start: at(9), end: at(17) };

  it('returns the whole window when nothing is busy', () => {
    expect(subtractBusy(window, [])).toEqual([window]);
  });

  it('splits the window around a meeting in the middle', () => {
    expect(subtractBusy(window, [{ start: at(12), end: at(13) }]))
      .toEqual([{ start: at(9), end: at(12) }, { start: at(13), end: at(17) }]);
  });

  it('removes the window when a block covers it', () => {
    expect(subtractBusy(window, [{ start: at(8), end: at(18) }])).toEqual([]);
  });

  it('ignores busy intervals outside the window', () => {
    expect(subtractBusy(window, [{ start: at(6), end: at(7) }, { start: at(20), end: at(21) }]))
      .toEqual([window]);
  });

  it('trims from each edge', () => {
    expect(subtractBusy(window, [{ start: at(8), end: at(10) }]))
      .toEqual([{ start: at(10), end: at(17) }]);
    expect(subtractBusy(window, [{ start: at(16), end: at(19) }]))
      .toEqual([{ start: at(9), end: at(16) }]);
  });
});

describe('openTime', () => {
  // The shape the app actually resolves: work 09:00–18:00, home 07:00–08:00 and
  // 18:00–23:00, community unconfigured.
  const windows = {
    work: [{ start: at(9), end: at(18) }],
    home: [{ start: at(7), end: at(8) }, { start: at(18), end: at(23) }],
    community: [],
  };

  it('reports the whole work window when nothing is scheduled', () => {
    expect(shape(openTime(windows, []))).toEqual(['work 9:00am-6:00pm']);
  });

  it('never offers home hours as open time by default', () => {
    // Home windows exist and are free, but the default direction list excludes them
    // — a caller opts a direction in explicitly (see the "per-direction preference"
    // test below), it never appears just because it has configured windows.
    const segs = openTime(windows, []);
    expect(segs.every((s) => !s.directions.includes('home'))).toBe(true);
  });

  it('includes home when the caller explicitly asks for it', () => {
    // The default list is just a default — OpenTimeSummary passes its own list built
    // from the owner's per-direction show_open_time preference.
    const segs = openTime(windows, [], ['work', 'home', 'community']);
    expect(segs.some((s) => s.directions.includes('home'))).toBe(true);
  });

  it('combines two directions that resolve to the exact same open span into one row', () => {
    const w = {
      work: [{ start: at(9), end: at(12) }],
      community: [{ start: at(9), end: at(12) }],
    };
    const segs = openTime(w, [], ['work', 'community']);
    expect(shape(segs)).toEqual(['work+community 9:00am-12:00pm']);
  });

  it('does not combine overlapping-but-not-identical windows from different directions', () => {
    // 8–2 (community) and 10–12 (work) overlap but are not the same span — each
    // keeps its own row rather than being spliced into new sub-segments.
    const w = {
      work: [{ start: at(10), end: at(12) }],
      community: [{ start: at(8), end: at(14) }],
    };
    expect(shape(openTime(w, [], ['work', 'community']))).toEqual([
      'community 8:00am-2:00pm',
      'work 10:00am-12:00pm',
    ]);
  });

  it('subtracts the day’s blocks', () => {
    const segs = openTime(windows, [
      { start: at(9), end: at(10, 30) },
      { start: at(10, 30), end: at(10, 45) },
    ]);
    expect(shape(segs)).toEqual(['work 10:45am-6:00pm']);
    expect(totalOpen(segs)).toBe(at(7, 15));
  });

  it('does not double-subtract overlapping blocks', () => {
    // Two meetings 9–11 and 10–12 leave 12:00, not 11:00 — subtracting the second
    // from an already-advanced cursor would eat an extra hour.
    expect(shape(openTime(windows, [
      { start: at(9), end: at(11) },
      { start: at(10), end: at(12) },
    ]))).toEqual(['work 12:00pm-6:00pm']);
  });

  it(`drops gaps shorter than ${MIN_OPEN_MINUTES} minutes`, () => {
    const segs = openTime(windows, [
      { start: at(9), end: at(12) },
      { start: at(12, 10), end: at(18) },
    ]);
    expect(segs).toEqual([]);
  });

  it('includes community windows when they are configured', () => {
    const withCommunity = { ...windows, community: [{ start: at(18, 30), end: at(20) }] };
    expect(shape(openTime(withCommunity, []))).toEqual([
      'work 9:00am-6:00pm',
      'community 6:30pm-8:00pm',
    ]);
  });

  it('orders segments by start time across directions', () => {
    const w = {
      work: [{ start: at(13), end: at(17) }],
      community: [{ start: at(8), end: at(9) }],
    };
    expect(shape(openTime(w))).toEqual(['community 8:00am-9:00am', 'work 1:00pm-5:00pm']);
  });

  it('is empty when no relevant window is configured', () => {
    expect(openTime({ home: [{ start: at(7), end: at(23) }] }, [])).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats clock times around noon and midnight', () => {
    expect(formatClock(0)).toBe('12:00am');
    expect(formatClock(at(12))).toBe('12:00pm');
    expect(formatClock(at(13, 5))).toBe('1:05pm');
  });

  it('formats durations without empty units', () => {
    expect(formatDuration(75)).toBe('1h 15m');
    expect(formatDuration(240)).toBe('4h');
    expect(formatDuration(30)).toBe('30m');
    expect(formatDuration(0)).toBe('0m');
  });
});

describe('busyFromBlocks', () => {
  const DAY = '2026-08-14';

  /** Local wall clock → the stored UTC instant (host TZ pinned to America/LA). */
  const iso = (hhmm: string, day = DAY): string => {
    const [h, m] = hhmm.split(':').map(Number);
    const [y, mo, d] = day.split('-').map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0).toISOString();
  };

  const block = (over: Partial<Block> & { id: string }): Block => ({
    title: over.id,
    block_kind: 'task',
    status: 'planned',
    start_at: iso('10:00'),
    end_at: iso('11:00'),
    all_day: false,
    is_locked: false,
    is_auto: false,
    source_kind: 'manual',
    created_at: iso('00:00'),
    ...over,
  } as Block);

  /** Reads as times rather than objects when an assertion fails. */
  const spans = (rs: ReturnType<typeof busyFromBlocks>) =>
    rs.map((r) => `${formatClock(r.start)}-${formatClock(r.end)}`);

  // The day's configured hours, for the openTime assertions below. Work is the only
  // direction with a window, and it is wide enough that every fixture lands inside it.
  const windows = { work: [{ start: at(9), end: at(18) }] };

  it('reads a plain block’s span off the local wall clock', () => {
    expect(spans(busyFromBlocks([block({ id: 'a' })], DAY))).toEqual(['10:00am-11:00am']);
  });

  it('a Time Block is busy for its whole span even when nothing is in it', () => {
    // The point of the phase: a container's span IS the commitment. An empty
    // timeblock 1–3pm must remove those two hours from open time, not read as free
    // because no task has been nested into it yet.
    const empty = block({ id: 'tb', block_kind: 'timeblock', start_at: iso('13:00'), end_at: iso('15:00') });
    expect(spans(busyFromBlocks([empty], DAY))).toEqual(['1:00pm-3:00pm']);
    expect(shape(openTime(windows, busyFromBlocks([empty], DAY))))
      .toEqual(['work 9:00am-1:00pm', 'work 3:00pm-6:00pm']);
  });

  it('a member inside a Time Block does not subtract twice', () => {
    // Two containers, each with a task nested inside it, delivered in the order the
    // store happens to hold them — members and containers interleaved, NOT sorted by
    // start. That ordering is the point: `openTime` merges (and therefore sorts)
    // before walking, and without it the afternoon block would be subtracted first
    // and swallow the morning one's slot.
    const morning = block({ id: 'tb-am', block_kind: 'timeblock', start_at: iso('09:00'), end_at: iso('10:30') });
    const amMember = block({ id: 'm-am', parent_block_id: 'tb-am', start_at: iso('09:00'), end_at: iso('10:00') });
    const afternoon = block({ id: 'tb-pm', block_kind: 'timeblock', start_at: iso('14:00'), end_at: iso('16:00') });
    const pmMember = block({ id: 'm-pm', parent_block_id: 'tb-pm', start_at: iso('14:30'), end_at: iso('16:00') });

    const busy = busyFromBlocks([afternoon, amMember, pmMember, morning], DAY);
    // Every row is busy in its own right — the builder does not try to be clever
    // about nesting, it just reports spans.
    expect(spans(busy)).toEqual([
      '2:00pm-4:00pm', '9:00am-10:00am', '2:30pm-4:00pm', '9:00am-10:30am',
    ]);
    // …and each container is subtracted exactly once: its member costs no extra
    // minutes, and neither block eats the other's gap.
    expect(shape(openTime(windows, busy)))
      .toEqual(['work 10:30am-2:00pm', 'work 4:00pm-6:00pm']);
    expect(totalOpen(openTime(windows, busy))).toBe(at(5, 30));
  });

  it('gives the same answer whichever order the store hands the blocks over', () => {
    // The store's order is an id sort, not a time sort, and it changes as blocks are
    // created. Open time must not.
    const rows = [
      block({ id: 'tb-am', block_kind: 'timeblock', start_at: iso('09:00'), end_at: iso('10:30') }),
      block({ id: 'm-am', parent_block_id: 'tb-am', start_at: iso('09:00'), end_at: iso('10:00') }),
      block({ id: 'tb-pm', block_kind: 'timeblock', start_at: iso('14:00'), end_at: iso('16:00') }),
    ];
    const forward = shape(openTime(windows, busyFromBlocks(rows, DAY)));
    const reversed = shape(openTime(windows, busyFromBlocks([...rows].reverse(), DAY)));
    expect(forward).toEqual(['work 10:30am-2:00pm', 'work 4:00pm-6:00pm']);
    expect(reversed).toEqual(forward);
  });

  it('a member that overruns its container extends the busy span', () => {
    // The mirror of the test above: members are not decoration to be dropped once the
    // container is counted. A task running 2–4pm out of a 1–3pm block keeps 3–4pm busy.
    const container = block({ id: 'tb', block_kind: 'timeblock', start_at: iso('13:00'), end_at: iso('15:00') });
    const member = block({ id: 'm', parent_block_id: 'tb', start_at: iso('14:00'), end_at: iso('16:00') });
    expect(shape(openTime(windows, busyFromBlocks([container, member], DAY))))
      .toEqual(['work 9:00am-1:00pm', 'work 4:00pm-6:00pm']);
  });

  it('an all-day block holds no minutes on the timeline', () => {
    // All-day rows live in the pinned header lane; `end_at` is start + duration, an
    // artifact of the notNull column. Subtracting it would delete the morning.
    const allDay = block({
      id: 'ad', block_kind: 'timeblock', all_day: true,
      start_at: iso('00:00'), end_at: iso('12:00'),
    });
    expect(busyFromBlocks([allDay], DAY)).toEqual([]);
    expect(shape(openTime(windows, busyFromBlocks([allDay], DAY)))).toEqual(['work 9:00am-6:00pm']);
  });

  it('a someday concept holds no minutes on the timeline', () => {
    // Concepts are stored at their goal day's midnight for ordering — no span semantics.
    const concept = block({
      id: 'c', block_kind: 'timeblock', block_type: 'someday',
      start_at: iso('00:00'), end_at: iso('11:00'),
    });
    expect(busyFromBlocks([concept], DAY)).toEqual([]);
  });

  it('a finished or cancelled block gives its slot back', () => {
    for (const status of ['completed', 'done', 'cancelled', 'skipped', 'missed']) {
      expect(busyFromBlocks([block({ id: status, status })], DAY)).toEqual([]);
    }
    // …while an active one still holds it, so the case above is a status rule and not
    // a fixture that fails to produce busy time at all.
    expect(spans(busyFromBlocks([block({ id: 'p', status: 'planned' })], DAY)))
      .toEqual(['10:00am-11:00am']);
  });

  it('another day’s block is not this day’s wall', () => {
    // `blockRange` widens to a whole week while the standalone Calendar is mounted,
    // so the store can hold days the summary is not describing.
    const tomorrow = block({ id: 't', start_at: iso('10:00', '2026-08-15'), end_at: iso('11:00', '2026-08-15') });
    const yesterday = block({ id: 'y', start_at: iso('10:00', '2026-08-13'), end_at: iso('11:00', '2026-08-13') });
    expect(busyFromBlocks([tomorrow, yesterday], DAY)).toEqual([]);
    expect(shape(openTime(windows, busyFromBlocks([tomorrow, yesterday], DAY))))
      .toEqual(['work 9:00am-6:00pm']);
  });

  it('a block running past midnight stays busy to the end of the day', () => {
    // Wall-clock end (2:00am) is a smaller number than the start; taken literally the
    // range inverts and the block vanishes instead of closing the night.
    const overnight = block({ id: 'o', start_at: iso('22:00'), end_at: iso('02:00', '2026-08-15') });
    expect(spans(busyFromBlocks([overnight], DAY))).toEqual(['10:00pm-12:00am']);
  });

  it('skips malformed and zero-length rows rather than poisoning the maths', () => {
    expect(busyFromBlocks([
      block({ id: 'nan', start_at: 'not-a-date', end_at: iso('11:00') }),
      block({ id: 'nan2', start_at: iso('10:00'), end_at: 'not-a-date' }),
      block({ id: 'zero', start_at: iso('10:00'), end_at: iso('10:00') }),
      block({ id: 'inverted', start_at: iso('11:00'), end_at: iso('10:00') }),
    ], DAY)).toEqual([]);
  });

  it('is empty for an empty day', () => {
    expect(busyFromBlocks([], DAY)).toEqual([]);
  });
});
