import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@solidjs/testing-library';
import type { PlacementSurvivalResponse, PlacementSurvivalRun } from '../../lib/api.js';
import type { LearningContext } from './LearningCard.js';
import { ZERO_PERCENT, textWithoutChart } from './learning-test-helpers.js';
import { COMMON, copyProblems } from '../../lib/learning-copy.js';
import { LEARNING_LIMITS, MIN_N, formatRange, wilsonRange } from '../../lib/learning-stats.js';

/**
 * PlacementTile: "Where Auto places your blocks".
 *
 * Two layers. The pure builder (placementView) is checked on its own, because that is
 * where every honesty rule lives: counts before percents, a percent only at MIN_N cases
 * with its Wilson range, null as "not measured" (never 0%), the newest reading as the
 * headline whatever order the wire used, and a comparison pooled over readings that do not
 * overlap. The rendered tile is then checked through the real card frame: the request it
 * makes, loading and error states, and the clear flow with its confirm, toasts and 403.
 */

const survivalMock = vi.fn(async (_limit?: number): Promise<PlacementSurvivalResponse> => ({ runs: [] }));
const resetMock = vi.fn(async (): Promise<{ ok: boolean; cleared: number }> => ({ ok: true, cleared: 0 }));
vi.mock('../../lib/api.js', () => ({
  api: {
    learning: {
      placementSurvival: (limit?: number) => survivalMock(limit),
      resetPlacement: () => resetMock(),
    },
  },
}));

const toastMock = vi.fn();
vi.mock('../../stores/index.js', () => ({
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { PlacementTile, placementView } = await import('./PlacementTile.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Sunday 1 Nov 2026, local noon. The newest reading below (Monday 26 Oct) is 6 days old. */
const NOW = new Date(2026, 10, 1, 12, 0, 0);

/** Mondays, newest first. */
const MONDAYS = [
  '2026-10-26',
  '2026-10-19',
  '2026-10-12',
  '2026-10-05',
  '2026-09-28',
  '2026-09-21',
  '2026-09-14',
  '2026-09-07',
  '2026-08-31',
  '2026-08-24',
] as const;

/** One wire row. decided and the rate are derived from the counts, the way the server
 *  writes them, so a fixture can never contradict itself by accident. */
function run(
  date: string,
  accepted: number,
  corrected: number,
  over: Partial<PlacementSurvivalRun> = {},
): PlacementSurvivalRun {
  const decided = accepted + corrected;
  return {
    computed_date: date,
    period_days: 28,
    decided,
    accepted,
    corrected,
    survival_rate: decided > 0 ? accepted / decided : null,
    keys_learned: 0,
    biased: 0,
    ...over,
  };
}

const res = (...runs: PlacementSurvivalRun[]): PlacementSurvivalResponse => ({ runs });

function ctx(over: Partial<LearningContext> = {}): LearningContext {
  return { aiAvailable: null, smartMode: null, now: NOW, canReset: true, ...over };
}

/** The range text exactly as the headline builds it: from wilsonRange, never typed. */
const rangeText = (hits: number, n: number) => formatRange(wilsonRange(hits, n)!);
const could = (hits: number, n: number) => `could be ${rangeText(hits, n)}`;

const oneSeries = (view: ReturnType<typeof placementView>) => {
  expect(view.series).toHaveLength(1);
  return view.series[0];
};

const NO_ROWS_TEXT =
  'No readings yet. A reading is added every Monday, even when no blocks were settled. If this stays empty after a Monday, the weekly pass has not run.';

// ── The pure builder ─────────────────────────────────────────────────────────

describe('placementView: headline', () => {
  it('under 10 settled blocks leads with the counts and prints no percent', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 5, 2)), ctx()));
    expect(s.state).toBe('measured');
    expect(s.headline).toBe(
      '5 of 7 settled blocks were not moved to a different hour, in the 28 days to Oct 26. 2 were moved to a different hour.',
    );
    // "Kept where Auto put them" would be false for a block nudged within the hour, resized,
    // or moved to another day at the same hour: all of those count as kept.
    expect(s.headline).not.toContain('where Auto put');
    expect(s.headline).not.toContain('%');
    expect(s.headline).not.toContain('could be anywhere');
    expect(s.detail).toBe('Higher is better. Latest reading: Oct 26 (6 days ago).');
  });

  it('10 or more: percent computed from the counts, with the Wilson range from wilsonRange', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 20, 8)), ctx()));
    expect(s.headline).toBe(
      `71% kept (20 of 28) in the 28 days to Oct 26. 8 were moved to a different hour. With this many cases the true figure could be anywhere from ${rangeText(20, 28)}.`,
    );
  });

  it('the percent threshold is exactly MIN_N: 9 cases is a fraction, 10 is a percent with a range', () => {
    expect(MIN_N).toBe(10);
    const nine = oneSeries(placementView(res(run('2026-10-26', 6, 3)), ctx()));
    expect(nine.headline).not.toContain('%');
    const ten = oneSeries(placementView(res(run('2026-10-26', 6, 4)), ctx()));
    expect(ten.headline).toContain('60% kept (6 of 10)');
    expect(ten.headline).toContain(`anywhere from ${rangeText(6, 10)}`);
  });

  it('the percent comes from the counts, not from the wire rate', () => {
    // 20 of 28 is 71%. A wire rate of 0.5 must be used only to detect null, never copied.
    const s = oneSeries(placementView(res(run('2026-10-26', 20, 8, { survival_rate: 0.5 })), ctx()));
    expect(s.headline).toContain('71% kept (20 of 28)');
    expect(s.headline).not.toContain('50%');
  });

  it('the moved count is the wire corrected, and the singular reads correctly', () => {
    for (const moved of [0, 1, 2, 9]) {
      const s = oneSeries(placementView(res(run('2026-10-26', 4, moved)), ctx()));
      const verb = moved === 1 ? 'was' : 'were';
      expect(s.headline).toContain(`${moved} ${verb} moved to a different hour.`);
    }
    const one = oneSeries(placementView(res(run('2026-10-26', 1, 0)), ctx()));
    expect(one.headline).toBe(
      '1 of 1 settled block was not moved to a different hour, in the 28 days to Oct 26. 0 were moved to a different hour.',
    );
  });

  it('a row whose counts do not add up leaves the moved sentence out rather than contradict itself', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 5, 2, { decided: 9 })), ctx()));
    expect(s.headline).toBe('5 of 9 settled blocks were not moved to a different hour, in the 28 days to Oct 26.');
  });

  it('the period phrase follows the row period_days', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 5, 2, { period_days: 14 })), ctx()));
    expect(s.headline).toContain('in the 14 days to Oct 26');
  });

  it('a real zero prints as a zero: 0 of 4, and 0% at 10 or more', () => {
    const few = oneSeries(placementView(res(run('2026-10-26', 0, 4)), ctx()));
    expect(few.state).toBe('measured');
    expect(few.headline).toContain('0 of 4 settled blocks were not moved to a different hour');
    expect(few.headline).toContain('4 were moved to a different hour.');
    const many = oneSeries(placementView(res(run('2026-10-26', 0, 12)), ctx()));
    expect(many.state).toBe('measured');
    expect(many.headline).toContain('0% kept (0 of 12)');
    expect(many.headline).toContain(`anywhere from ${rangeText(0, 12)}`);
    // A measured zero IS plotted, at the bottom, unlike a null.
    expect(many.chart!.points[0].value).toBe(0);
  });
});

describe('placementView: order of the wire', () => {
  const wire = [run('2026-10-26', 5, 2), run('2026-10-19', 7, 1), run('2026-10-12', 3, 3)];

  it('the same rows newest first, oldest first and shuffled give the same headline and an ascending chart', () => {
    const orders = [wire, [...wire].reverse(), [wire[1], wire[2], wire[0]]];
    for (const runs of orders) {
      const s = oneSeries(placementView({ runs }, ctx()));
      expect(s.headline).toContain('5 of 7 settled blocks');
      expect(s.headline).toContain('Oct 26');
      expect(s.chart!.points.map((p) => p.date)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
      expect(s.readings!.rows.map((r) => r.key)).toEqual(['2026-10-26', '2026-10-19', '2026-10-12']);
    }
  });

  it('an older number is never shown as the current one', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 1, 3), run('2026-10-19', 20, 1)), ctx()));
    expect(s.headline).toContain('1 of 4');
    expect(s.headline).not.toContain('20 of 21');
  });
});

describe('placementView: not measured is never a number', () => {
  it('decided 0 with a null rate is Not measured, a tick, and no 0% anywhere in the view', () => {
    const view = placementView(res(run('2026-10-26', 0, 0)), ctx());
    const s = oneSeries(view);
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe('Not measured: no auto-placed block was settled in the 28 days to Oct 26.');
    expect(s.detail).toBe('Latest reading: Oct 26 (6 days ago).');
    expect(s.chart!.points).toHaveLength(1);
    expect(s.chart!.points[0].value).toBeNull();
    expect(s.chart!.points[0].label).toBe('Oct 26: not measured');
    expect(s.readings!.rows[0].cells[4]).toBe(COMMON.notMeasured);
    expect(JSON.stringify(view)).not.toMatch(/(^|[^0-9])0%/);
  });

  it('a null newest week keeps the last measured counts as a note, never as the headline', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 0, 0), run('2026-10-19', 5, 2)), ctx()));
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe('Not measured: no auto-placed block was settled in the 28 days to Oct 26.');
    expect(s.headline).not.toContain('5 of 7');
    expect(s.notes).toEqual(['Last measured: 5 of 7 settled blocks were not moved to a different hour, on Oct 19.']);
    expect(s.chart!.points.map((p) => p.value)).toEqual([5 / 7, null]);
  });

  it('the Last measured note names what is counted, singular for one block, so 3 of 4 cannot be read as the moved ones', () => {
    const one = oneSeries(placementView(res(run('2026-10-26', 0, 0), run('2026-10-19', 1, 0)), ctx()));
    expect(one.notes).toEqual(['Last measured: 1 of 1 settled block was not moved to a different hour, on Oct 19.']);
    const four = oneSeries(placementView(res(run('2026-10-26', 0, 0), run('2026-10-19', 3, 1)), ctx()));
    expect(four.notes[0]).toBe('Last measured: 3 of 4 settled blocks were not moved to a different hour, on Oct 19.');
  });

  it('with no earlier measured reading there is no Last measured note', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 0, 0), run('2026-10-19', 0, 0)), ctx()));
    expect(s.notes).toEqual([]);
  });

  it('a fixture mixing a real 0 of 4 with a null week shows the zero and never the null as a number', () => {
    const view = placementView(res(run('2026-10-26', 0, 4), run('2026-10-19', 0, 0)), ctx());
    const s = oneSeries(view);
    expect(s.state).toBe('measured');
    expect(s.chart!.points.map((p) => p.value)).toEqual([null, 0]);
    expect(s.readings!.rows.map((r) => r.cells[4])).toEqual(['under 10 cases', COMMON.notMeasured]);
  });

  it('a row that has cases but no usable rate is not shown as measured, and the sentence stays true', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 3, 2, { survival_rate: null })), ctx()));
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe('Not measured: the reading for the 28 days to Oct 26 could not be used.');
    expect(s.headline).not.toContain('no auto-placed block was settled');
    expect(s.chart!.points[0].value).toBeNull();
  });

  it('a rate outside 0 to 1 or more accepted than decided is not measured', () => {
    for (const bad of [run('2026-10-26', 5, 2, { survival_rate: 1.4 }), run('2026-10-26', 5, 2, { accepted: 9 })]) {
      const s = oneSeries(placementView(res(bad), ctx()));
      expect(s.state).toBe('not-measured');
      expect(s.chart!.points[0].value).toBeNull();
    }
  });
});

describe('placementView: no rows', () => {
  it('says no readings yet, draws nothing, and opens the how-it-starts block', () => {
    const view = placementView(res(), ctx());
    const s = oneSeries(view);
    expect(s.key).toBe('survival');
    expect(s.state).toBe('none');
    expect(s.headline).toBeNull();
    expect(s.detail).toBeNull();
    expect(s.comparison).toBeNull();
    expect(s.chart).toBeNull();
    expect(s.readings).toBeNull();
    expect(s.empty).toBe(NO_ROWS_TEXT);
    expect(view.status).toBeNull();
    expect(view.contextLines).toEqual([]);
    expect(view.startOpen).toBe(true);
    expect(view.resetAvailable).toBe(false);
  });
});

describe('placementView: chart', () => {
  it('carries the overlap caption, the shared chart caption, and no marker legend without a marker', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 5, 2)), ctx()));
    const chart = s.chart!;
    expect(chart.caption).toContain(
      'Each dot covers the 28 days before its date, and one is added every week, so neighbouring dots share most of their blocks. The line is smoother than the evidence.',
    );
    expect(chart.caption).toContain(COMMON.chartCaption);
    expect(chart.caption).not.toContain('dashed line marks');
    expect(chart.marker).toBeNull();
    expect(chart.cadenceDays).toBe(7);
  });

  it('points carry the counts, a value only when measured, and a label that never shows a percent under 10', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 20, 8), run('2026-10-19', 3, 1), run('2026-10-12', 0, 0)), ctx()));
    expect(s.chart!.points).toEqual([
      { date: '2026-10-12', value: null, n: 0, label: 'Oct 12: not measured' },
      { date: '2026-10-19', value: 0.75, n: 4, label: 'Oct 19: 3 of 4' },
      { date: '2026-10-26', value: 20 / 28, n: 28, label: expect.stringContaining('Oct 26: 20 of 28 (71%, could be ') },
    ]);
  });

  it('puts the marker on the first reading taken after preferences were stored, with its legend', () => {
    const view = placementView(
      res(
        run('2026-10-26', 5, 2, { biased: 1, keys_learned: 2 }),
        run('2026-10-19', 5, 2, { biased: 1, keys_learned: 2 }),
        run('2026-10-12', 5, 2, { biased: 1, keys_learned: 1 }),
        run('2026-10-05', 5, 2, { biased: 0, keys_learned: 1 }),
      ),
      ctx(),
    );
    const chart = oneSeries(view).chart!;
    expect(chart.marker).toEqual({ date: '2026-10-12', text: 'Preferences stored by Oct 12' });
    // "by", not "from": biased is sampled before the weekly rebuild, so they can be a week older.
    expect(chart.marker?.text).not.toMatch(/stored from/);
    expect(chart.caption).toContain(
      'The dashed line marks the first reading taken after Auto had stored hour preferences. It does not show that any block was placed using one.',
    );
  });

  it('draws no marker when the first reading in the window already had preferences, and the caption says why', () => {
    // More history than the 12 rows requested: a marker on the window's first row would claim a
    // start date that is up to weeks too late.
    const chart = oneSeries(
      placementView(
        res(run('2026-10-26', 5, 2, { biased: 1 }), run('2026-10-19', 5, 2, { biased: 1 }), run('2026-10-12', 5, 2, { biased: 1 })),
        ctx(),
      ),
    ).chart!;
    expect(chart.marker).toBeNull();
    expect(chart.caption).toContain('Auto already had hour preferences at the earliest reading shown, so no marker is drawn.');
    expect(chart.caption).not.toContain('The dashed line marks');
  });

  it('still marks a flip after the first reading shown, without the before-the-window note', () => {
    const chart = oneSeries(placementView(res(run('2026-10-26', 5, 2, { biased: 1 }), run('2026-10-19', 5, 2, { biased: 0 })), ctx())).chart!;
    expect(chart.marker?.date).toBe('2026-10-26');
    expect(chart.caption).not.toContain('already had hour preferences');
  });

  it('a stored set that is cleared and stored again still marks only the first flip', () => {
    const chart = oneSeries(
      placementView(
        res(
          run('2026-10-26', 5, 2, { biased: 1 }),
          run('2026-10-19', 5, 2, { biased: 0 }),
          run('2026-10-12', 5, 2, { biased: 1 }),
          run('2026-10-05', 5, 2, { biased: 0 }),
        ),
        ctx(),
      ),
    ).chart!;
    expect(chart.marker?.date).toBe('2026-10-12');
  });

  it('no marker when no reading was taken with preferences stored', () => {
    const chart = oneSeries(placementView(res(run('2026-10-26', 5, 2), run('2026-10-19', 5, 2)), ctx())).chart!;
    expect(chart.marker).toBeNull();
  });
});

describe('placementView: comparison', () => {
  /** Ten weekly readings. Only the newest and the one exactly 28 days older may be used. */
  const tenWeeks = (latest: [number, number], earlier: [number, number]) => {
    const filler: Array<[number, number]> = [
      [2, 8], // Oct 19: 10 cases, nothing like either side
      [9, 4], // Oct 12
      [3, 7], // Oct 5
      earlier, // Sep 28 (28 days before Oct 26)
      [7, 3], // Sep 21
      [4, 6], // Sep 14
      [9, 1], // Sep 7
      [1, 9], // Aug 31
      [5, 5], // Aug 24
    ];
    return res(run(MONDAYS[0], ...latest), ...filler.map(([a, c], i) => run(MONDAYS[i + 1], a, c)));
  };

  it('compares the newest reading with the one 28 days older and nothing else', () => {
    const s = oneSeries(placementView(tenWeeks([20, 8], [18, 11]), ctx()));
    // Pooling all ten would give a different n and a different share.
    expect(s.comparison).toBe(
      `The 28 days to Oct 26 (1 reading, Oct 26): 71% kept (20 of 28, ${could(20, 28)}). ` +
        `The 28 days before (1 reading, Sep 28): 62% (18 of 29, ${could(18, 29)}). ` +
        'The ranges overlap, so this is no clear change. A gap this size could be chance.',
    );
  });

  it('a clear rise is stated as a change, with no cause', () => {
    const s = oneSeries(placementView(tenWeeks([40, 10], [20, 30]), ctx()));
    expect(s.comparison).toBe(
      `The 28 days to Oct 26 (1 reading, Oct 26): 80% kept (40 of 50, ${could(40, 50)}). ` +
        `The 28 days before (1 reading, Sep 28): 40% (20 of 50, ${could(20, 50)}). ` +
        'That is higher by more than chance would explain. It shows a change, not the reason for it.',
    );
  });

  it('a clear fall is stated the same way', () => {
    const s = oneSeries(placementView(tenWeeks([20, 30], [40, 10]), ctx()));
    expect(s.comparison).toBe(
      `The 28 days to Oct 26 (1 reading, Oct 26): 40% kept (20 of 50, ${could(20, 50)}). ` +
        `The 28 days before (1 reading, Sep 28): 80% (40 of 50, ${could(40, 50)}). ` +
        'That is lower by more than chance would explain. It shows a change, not the reason for it.',
    );
  });

  it('never adds a cause, a judgement of good or bad, or a colour word', () => {
    for (const [a, b] of [
      [[40, 10], [20, 30]],
      [[20, 30], [40, 10]],
      [[20, 8], [18, 11]],
    ] as Array<[[number, number], [number, number]]>) {
      const text = oneSeries(placementView(tenWeeks(a, b), ctx())).comparison!;
      expect(text).not.toMatch(/\b(because|due to|caused|better|worse|improv\w*|good|bad|red|green)\b/i);
    }
  });

  it('a side under 10 settled blocks is too few, even when the other side is large', () => {
    const s = oneSeries(placementView(tenWeeks([20, 8], [6, 3]), ctx()));
    expect(s.comparison).toBe('Not enough cases to compare yet. Each 28-day period needs at least 10 settled blocks.');
    const exactly = oneSeries(placementView(tenWeeks([20, 8], [6, 4]), ctx()));
    expect(exactly.comparison).toContain(`The 28 days before (1 reading, Sep 28): 60% (6 of 10, ${could(6, 10)})`);
  });

  it('a single reading, or no reading 28 days older, is too few', () => {
    const lone = oneSeries(placementView(res(run('2026-10-26', 20, 8)), ctx()));
    expect(lone.comparison).toBe('Not enough cases to compare yet. Each 28-day period needs at least 10 settled blocks.');
    // A neighbour only 7 days older is never an "earlier period": it shares most of its blocks.
    const neighbour = oneSeries(placementView(res(run('2026-10-26', 20, 8), run('2026-10-19', 2, 28)), ctx()));
    expect(neighbour.comparison).toBe('Not enough cases to compare yet. Each 28-day period needs at least 10 settled blocks.');
  });
});

describe('placementView: status and reset availability', () => {
  it('no hour preferences yet: says how they start, and nothing can be cleared', () => {
    const view = placementView(res(run('2026-10-26', 5, 2, { keys_learned: 0 })), ctx());
    expect(view.status).toBe(
      'Auto has no hour preferences yet. They start after you move at least 5 blocks of one direction to a different hour.',
    );
    expect(view.resetAvailable).toBe(false);
  });

  it('preferences stored: dated, plural and singular', () => {
    const two = placementView(res(run('2026-10-26', 5, 2, { keys_learned: 2, biased: 1 })), ctx());
    // Worded as a dated reading, not as the present: a clear made since writes no row.
    expect(two.status).toBe('At the Oct 26 reading, Auto had hour preferences for 2 directions.');
    expect(two.status).not.toMatch(/in use/);
    expect(two.resetAvailable).toBe(true);
    const one = placementView(res(run('2026-10-26', 5, 2, { keys_learned: 1 })), ctx());
    expect(one.status).toBe('At the Oct 26 reading, Auto had hour preferences for 1 direction.');
    expect(one.resetAvailable).toBe(true);
  });

  it('reads the status and reset availability from the NEWEST row only', () => {
    const view = placementView(res(run('2026-10-26', 5, 2, { keys_learned: 0 }), run('2026-10-19', 5, 2, { keys_learned: 3 })), ctx());
    expect(view.status).toContain('no hour preferences yet');
    expect(view.resetAvailable).toBe(false);
  });

  it('a not measured newest week still reports what is stored', () => {
    const view = placementView(res(run('2026-10-26', 0, 0, { keys_learned: 2 })), ctx());
    expect(view.status).toBe('At the Oct 26 reading, Auto had hour preferences for 2 directions.');
    expect(view.resetAvailable).toBe(true);
  });

  describe('a clear made this session overrides the Monday count', () => {
    const stored = res(run('2026-10-26', 5, 2, { keys_learned: 2, biased: 1 }));

    it('a clear after the newest reading says so, and offers nothing more to clear', () => {
      const view = placementView(stored, ctx({ clearedOn: { placement: '2026-10-28' } }));
      expect(view.status).toBe("Cleared on Oct 28. Auto chooses with no hour preference until Monday's pass.");
      expect(view.resetAvailable).toBe(false);
    });

    it('a clear on the same day as the reading counts as after it', () => {
      const view = placementView(stored, ctx({ clearedOn: { placement: '2026-10-26' } }));
      expect(view.status).toMatch(/^Cleared on Oct 26\./);
      expect(view.resetAvailable).toBe(false);
    });

    it('a clear older than the newest reading is ignored: that reading already reflects it', () => {
      const view = placementView(stored, ctx({ clearedOn: { placement: '2026-10-20' } }));
      expect(view.status).toContain('At the Oct 26 reading');
      expect(view.resetAvailable).toBe(true);
    });

    it('only the placement loop reads it, and the readings stay as they were', () => {
      const other = placementView(stored, ctx({ clearedOn: { dismissal: '2026-10-28', classification: '2026-10-28' } }));
      expect(other.resetAvailable).toBe(true);
      const after = placementView(stored, ctx({ clearedOn: { placement: '2026-10-28' } }));
      expect(after.series).toEqual(placementView(stored, ctx()).series);
    });
  });

  it('opens the how-it-starts block exactly when the newest reading is not measured', () => {
    expect(placementView(res(run('2026-10-26', 5, 2)), ctx()).startOpen).toBe(false);
    expect(placementView(res(run('2026-10-26', 0, 0)), ctx()).startOpen).toBe(true);
    expect(placementView(res(), ctx()).startOpen).toBe(true);
  });
});

describe('placementView: context lines', () => {
  it('no model line even when the model is not reachable: this loop needs no model', () => {
    for (const aiAvailable of [false, true, null]) {
      const view = placementView(res(run('2026-10-26', 5, 2)), ctx({ aiAvailable }));
      expect(view.contextLines).toEqual([]);
    }
  });

  it('adds the stale line after 9 days, not at 9', () => {
    const at = (day: number) => placementView(res(run('2026-10-26', 5, 2)), ctx({ now: new Date(2026, 10, day, 12) }));
    expect(at(4).contextLines).toEqual([]); // 9 days old
    expect(at(5).contextLines).toEqual([
      'No new reading for 10 days. The weekly pass may not have run; it needs the server to be on early on Monday.',
    ]);
    expect(at(14).contextLines[0]).toContain('No new reading for 19 days.');
  });

  it('the age in the detail line follows the injected clock', () => {
    const s = oneSeries(placementView(res(run('2026-10-26', 5, 2)), ctx({ now: new Date(2026, 9, 27, 9) })));
    expect(s.detail).toBe('Higher is better. Latest reading: Oct 26 (yesterday).');
  });
});

describe('placementView: readings table', () => {
  it('lists newest first with counts, a percent only at 10 or more, and not measured as words', () => {
    const s = oneSeries(
      placementView(
        res(
          run('2026-10-12', 0, 0),
          run('2026-10-26', 20, 8, { keys_learned: 2, biased: 1 }),
          run('2026-10-19', 3, 1),
        ),
        ctx(),
      ),
    );
    expect(s.readings!.columns).toEqual(['Date', 'Settled', 'Kept', 'Moved', 'Share', 'Hour preferences']);
    expect(s.readings!.rows).toEqual([
      { key: '2026-10-26', cells: ['Oct 26', '28', '20', '8', '71%', '2'] },
      { key: '2026-10-19', cells: ['Oct 19', '4', '3', '1', 'under 10 cases', '0'] },
      { key: '2026-10-12', cells: ['Oct 12', '0', '0', '0', 'not measured', '0'] },
    ]);
  });
});

describe('placementView: the words', () => {
  const FIXTURES: Record<string, PlacementSurvivalResponse> = {
    empty: res(),
    nullOnly: res(run('2026-10-26', 0, 0), run('2026-10-19', 0, 0)),
    thin: res(run('2026-10-26', 5, 2, { keys_learned: 1 })),
    measured: res(run('2026-10-26', 20, 8, { keys_learned: 2, biased: 1 }), run('2026-09-28', 18, 11)),
    zero: res(run('2026-10-26', 0, 12)),
    stale: res(run('2026-09-01', 5, 2)),
  };

  it.each(Object.keys(FIXTURES))('%s: no dashes, no banned wording, no "created", no cause', (name) => {
    const view = placementView(FIXTURES[name], ctx());
    const text = JSON.stringify(view);
    expect(copyProblems(text)).toEqual([]);
    expect(text).not.toMatch(/created/i);
    expect(text).not.toMatch(/because|due to/i);
  });

  it('the null-only fixture contains no standalone 0%', () => {
    expect(JSON.stringify(placementView(FIXTURES.nullOnly, ctx()))).not.toMatch(/(^|[^0-9])0%/);
  });
});

// ── The rendered tile ────────────────────────────────────────────────────────

const HEADLINE = 'learning-headline-placement-survival';

let confirmSpy: MockInstance<typeof window.confirm>;

beforeEach(() => {
  survivalMock.mockReset().mockResolvedValue(res());
  resetMock.mockReset().mockResolvedValue({ ok: true, cleared: 0 });
  toastMock.mockReset();
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

function mount(over: Partial<LearningContext> = {}) {
  return render(() => <PlacementTile context={ctx(over)} />);
}

const PREFERENCES = res(run('2026-10-26', 5, 2, { keys_learned: 2, biased: 1 }), run('2026-10-19', 6, 1, { keys_learned: 2 }));

describe('PlacementTile: loading and the request', () => {
  it('asks for 12 rows, once, and shows Loading... first with the caveat already visible', async () => {
    let resolve!: (v: PlacementSurvivalResponse) => void;
    survivalMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    mount();
    expect(screen.getByText(COMMON.loading)).toBeInTheDocument();
    expect(screen.getByTestId('learning-primary-caveat-placement').textContent).toMatch(/kept does not mean liked/i);
    expect(screen.queryByTestId(HEADLINE)).toBeNull();

    resolve(res(run('2026-10-26', 5, 2)));
    const headline = await screen.findByTestId(HEADLINE);
    expect(headline).toHaveAttribute('data-state', 'measured');
    expect(headline.textContent).toContain('5 of 7 settled blocks were not moved to a different hour');
    expect(screen.queryByText(COMMON.loading)).toBeNull();

    expect(survivalMock).toHaveBeenCalledTimes(1);
    expect(survivalMock).toHaveBeenCalledWith(LEARNING_LIMITS.placement);
    expect(LEARNING_LIMITS.placement).toBe(12);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('shows the card title, what it counts, and the always-visible caveat', async () => {
    survivalMock.mockResolvedValue(res(run('2026-10-26', 5, 2)));
    mount();
    await screen.findByTestId(HEADLINE);
    const card = screen.getByTestId('learning-card-placement');
    expect(card.textContent).toContain('Where Auto places your blocks');
    expect(card.textContent).toContain('What it counts: blocks the Auto scheduler placed that have settled.');
    expect(card.textContent).toContain('What it changes:');
    expect(screen.getByTestId('learning-primary-caveat-placement').textContent).toBe(
      'Kept does not mean liked. A block you never looked at counts as kept, so this goes up if you stop opening your calendar.',
    );
  });

  // The words the card prints about itself are claims about the server. A wrong number or a
  // dropped caveat here would be a lie the numbers below it cannot correct, so each is pinned.
  describe('what the card says about itself', () => {
    const open = async () => {
      survivalMock.mockResolvedValue(res(run('2026-10-26', 5, 2)));
      mount();
      await screen.findByTestId(HEADLINE);
      return {
        about: screen.getByTestId('learning-about-placement').textContent ?? '',
        more: screen.getByTestId('learning-more-placement'),
      };
    };

    it('what it counts: says an untouched future block is not counted yet, and that the window is 28 days', async () => {
      const { about } = await open();
      expect(about).toContain('Window: blocks Auto placed in the 28 days before each reading, one reading every Monday (early on Monday, server time), so readings overlap.');
      expect(about).toContain(
        'Not counted: blocks Auto had to shorten to fit, auto blocks that are gone when the weekly pass runs ' +
          '(re-planning deletes and re-places them all the time) unless you had already moved them, ' +
          'untouched blocks whose time has not come yet, and anything placed by routines or patterns.',
      );
      // The old wording called every block whose time has not come uncounted, which is false for a moved one.
      expect(about).not.toContain('blocks whose time has not come, and anything');
      expect(about).toContain('Cases behind it: the number of settled blocks, printed in every line. Direction: higher is better.');
    });

    it('what it changes: the floor, the window, the spread and the budget', async () => {
      const { about } = await open();
      expect(about).toContain('once at least 5 of your moves of one direction to a different hour fall in the last 90 days');
      expect(about).toContain('spans no more than 6 hours');
      expect(about).toContain('by at most one hour of extra fragmentation');
      expect(about).toContain('It never moves a block you placed and never overrides a lock, a pin or a deadline. No model is needed.');
    });

    it('the second caveat says a move counts at once and a kept block only after its time, so the reading leans toward moves', async () => {
      const { more } = await open();
      const items = [...more.querySelectorAll('li')].map((li) => li.textContent ?? '');
      expect(items[0]).toBe(
        'A move counts as soon as you make it, even for a block days away. A block you leave alone counts as kept only after its start time passes. ' +
          'So each reading leans toward moved blocks, and it can read lower than it will once those blocks have passed.',
      );
    });

    it('lists every other caveat under "More about this number", in order', async () => {
      const { more } = await open();
      const items = [...more.querySelectorAll('li')].map((li) => li.textContent ?? '');
      // The first caveat is the always-visible one, so it is not in this list.
      expect(items).toHaveLength(8);
      const starts = [
        'A move counts as soon as you make it',
        'Only blocks that survived long enough to be judged are counted.',
        'Only the hour of day is compared.',
        'Each reading covers 28 days but one is added every week',
        'People move blocks for reasons',
        "Only Auto's choices are logged.",
        'A comparison is between two stretches of time.',
        "A week with nothing settled is 'not measured', not a bad week.",
      ];
      starts.forEach((start, i) => expect(items[i], `caveat ${i + 1}`).toContain(start));
      expect(items[3]).toContain('neighbouring readings share about three quarters of their blocks');
      expect(items[3]).toContain('A smooth line is partly the overlap, and comparisons use readings at least 28 days apart.');
      expect(items[1]).toContain('this describes survivors');
    });

    it('how it starts: the floor, the window, the spread, and that nothing turns it off', async () => {
      const { more } = await open();
      const steps = more.textContent ?? '';
      expect(steps).toContain('After 5 moves of one direction (for example Work, Home or Community, or untagged) to a different hour within 90 days');
      expect(steps).toContain('spans no more than 6 hours');
      expect(steps).toContain('the next Monday pass writes an hour preference for that direction');
      expect(steps).toContain('No model is needed and there is no setting that turns this off.');
    });
  });
});

describe('PlacementTile: states', () => {
  it('no rows: the empty text and the how-it-starts block, open', async () => {
    mount();
    const empty = await screen.findByTestId('learning-empty-placement-survival');
    expect(empty.textContent).toBe(NO_ROWS_TEXT);
    expect(screen.queryByTestId(HEADLINE)).toBeNull();
    expect(screen.queryByTestId('learning-chart-placement-survival')).toBeNull();
    const more = screen.getByTestId('learning-more-placement') as HTMLDetailsElement;
    expect(more.open).toBe(true);
    expect(more.textContent).toContain('Use Auto to place tasks on your calendar');
  });

  it('measured: the how-it-starts block is closed, and the comparison and status render', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    mount();
    await screen.findByTestId(HEADLINE);
    expect((screen.getByTestId('learning-more-placement') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('learning-detail-placement-survival').textContent).toBe(
      'Higher is better. Latest reading: Oct 26 (6 days ago).',
    );
    expect(screen.getByTestId('learning-comparison-placement-survival').textContent).toContain('Not enough cases to compare yet');
    expect(screen.getByTestId('learning-status-placement').textContent).toBe('At the Oct 26 reading, Auto had hour preferences for 2 directions.');
    expect(screen.getByTestId('learning-chart-placement-survival')).toBeInTheDocument();
    expect(screen.getByTestId('learning-readings-placement-survival').textContent).toContain('under 10 cases');
  });

  it('a null week renders Not measured, never 0%, outside the chart axis', async () => {
    survivalMock.mockResolvedValue(res(run('2026-10-26', 0, 0), run('2026-10-19', 5, 2)));
    const { container } = mount();
    const headline = await screen.findByTestId(HEADLINE);
    expect(headline).toHaveAttribute('data-state', 'not-measured');
    expect(headline.textContent).toBe('Not measured: no auto-placed block was settled in the 28 days to Oct 26.');
    expect(container.textContent).toContain('Last measured: 5 of 7 settled blocks were not moved to a different hour, on Oct 19.');
    // The chart legitimately prints a 0% axis label, so the sweep is over everything else.
    expect(textWithoutChart(container)).not.toMatch(ZERO_PERCENT);
  });

  it('shows the stale line only for an old reading, and never a model line', async () => {
    survivalMock.mockResolvedValue(res(run('2026-10-26', 5, 2)));
    mount({ aiAvailable: false, now: new Date(2026, 10, 14, 12) });
    await screen.findByTestId(HEADLINE);
    const lines = screen.getAllByTestId('learning-context-placement');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('No new reading for 19 days.');
    expect(screen.getByTestId('learning-card-placement').textContent).not.toMatch(/local model|not ready/i);
  });

  it('a fresh reading has no context lines at all, even with the model off', async () => {
    survivalMock.mockResolvedValue(res(run('2026-10-26', 5, 2)));
    mount({ aiAvailable: false });
    await screen.findByTestId(HEADLINE);
    expect(screen.queryByTestId('learning-context-placement')).toBeNull();
  });
});

describe('PlacementTile: a failed fetch is an error, never emptiness', () => {
  const failure = (status: number, message = 'SQLITE_ERROR: no such table') => Object.assign(new Error(message), { status });

  it('shows the failed wording and Try again, hides the raw server text, and never says No readings yet', async () => {
    survivalMock.mockRejectedValueOnce(failure(500));
    const { container } = mount();
    const err = await screen.findByTestId('learning-error-placement');
    expect(err.textContent).toContain(COMMON.errorFailed);
    expect(container.textContent).not.toContain('SQLITE_ERROR');
    expect(container.textContent).not.toContain('No readings yet');
    expect(screen.queryByTestId(HEADLINE)).toBeNull();
    expect(screen.queryByTestId('learning-empty-placement-survival')).toBeNull();
    // The caveat does not depend on the data, so it is still there.
    expect(screen.getByTestId('learning-primary-caveat-placement')).toBeInTheDocument();
  });

  it('Try again re-calls only this loader, and a good answer replaces the error', async () => {
    survivalMock.mockRejectedValueOnce(failure(500));
    mount();
    await screen.findByTestId('learning-error-placement');
    survivalMock.mockResolvedValue(res(run('2026-10-26', 5, 2)));
    fireEvent.click(screen.getByTestId('learning-retry-placement'));
    await screen.findByTestId(HEADLINE);
    expect(survivalMock).toHaveBeenCalledTimes(2);
    expect(survivalMock).toHaveBeenLastCalledWith(LEARNING_LIMITS.placement);
    expect(resetMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('learning-error-placement')).toBeNull();
  });

  it('status 0 says the server could not be reached', async () => {
    survivalMock.mockRejectedValueOnce(failure(0, 'Failed to fetch'));
    mount();
    expect((await screen.findByTestId('learning-error-placement')).textContent).toContain(COMMON.errorOffline);
  });

  it('status 404 says the server does not report this yet', async () => {
    survivalMock.mockRejectedValueOnce(failure(404, 'Not found'));
    mount();
    expect((await screen.findByTestId('learning-error-placement')).textContent).toContain(COMMON.errorUnsupported);
  });
});

describe('PlacementTile: clearing learned hours', () => {
  const resetButton = () => screen.queryByTestId('learning-reset-placement');

  it('shows the button and an always-visible hint when hour preferences are stored', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    mount();
    const btn = await screen.findByTestId('learning-reset-placement');
    expect(btn.textContent).toBe('Clear learned hours');
    expect(btn).toHaveAttribute('type', 'button');
    // No click yet: the hint must already say what it does.
    const hint = screen.getByTestId('learning-reset-hint-placement').textContent!;
    expect(hint).toBe(
      "Auto goes back to choosing gaps with no hour preference. Your move history is kept, so Monday's pass can learn the hours again. Past readings stay, and they describe the old preferences. There is no setting that turns this off.",
    );
    expect(hint).toMatch(/Monday/);
    expect(hint).toMatch(/no setting/);
    expect(hint).toMatch(/kept/);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('is not called "Reset learning"', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    const { container } = mount();
    await screen.findByTestId('learning-reset-placement');
    expect(container.textContent).not.toMatch(/reset learning/i);
  });

  it('with no stored preferences there is no button, and the card says there is nothing to clear', async () => {
    survivalMock.mockResolvedValue(res(run('2026-10-26', 5, 2, { keys_learned: 0 })));
    mount();
    await screen.findByTestId(HEADLINE);
    expect(resetButton()).toBeNull();
    expect(screen.getByTestId('learning-nothing-to-clear-placement').textContent).toBe(
      'No hour preferences are stored, so there is nothing to clear.',
    );
  });

  it('with no readings at all there is no button either', async () => {
    mount();
    await screen.findByTestId('learning-empty-placement-survival');
    expect(resetButton()).toBeNull();
  });

  it('Cancel on the confirm makes no request and leaves the button', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    mount();
    const btn = await screen.findByTestId('learning-reset-placement');
    confirmSpy.mockReturnValue(false);
    fireEvent.click(btn);
    await Promise.resolve();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(resetMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(resetButton()).not.toBeNull();
  });

  it('OK sends one DELETE, toasts the count, shows the done status, and does not refetch', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    resetMock.mockResolvedValue({ ok: true, cleared: 2 });
    mount();
    fireEvent.click(await screen.findByTestId('learning-reset-placement'));
    expect(confirmSpy).toHaveBeenCalledWith(
      "Clear the hours Auto has learned? Your move history is kept and Monday's pass can learn them again.",
    );
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0][0]).toBe('Cleared 2 hour preferences. They are learned again from your moves on Monday.');
    expect(toastMock.mock.calls[0][1]).toBe('success');
    await waitFor(() =>
      expect(screen.getByTestId('learning-status-placement').textContent).toBe(
        'Cleared. Auto chooses with no hour preference until Monday.',
      ),
    );
    expect(resetButton()).toBeNull();
    // The readings cannot change before Monday, so there is no second fetch.
    expect(survivalMock).toHaveBeenCalledTimes(1);
  });

  it('one cleared preference reads in the singular', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    resetMock.mockResolvedValue({ ok: true, cleared: 1 });
    mount();
    fireEvent.click(await screen.findByTestId('learning-reset-placement'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0][0]).toBe('Cleared 1 hour preference. It is learned again from your moves on Monday.');
  });

  it('cleared 0 says nothing to clear, removes the button, and shows the nothing-to-clear text', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    resetMock.mockResolvedValue({ ok: true, cleared: 0 });
    mount();
    fireEvent.click(await screen.findByTestId('learning-reset-placement'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0][0]).toBe('Nothing to clear. No hour preferences are stored.');
    expect(toastMock.mock.calls[0][1]).not.toBe('error');
    await waitFor(() => expect(resetButton()).toBeNull());
    expect(screen.getByTestId('learning-nothing-to-clear-placement').textContent).toBe(
      'No hour preferences are stored, so there is nothing to clear.',
    );
    expect(survivalMock).toHaveBeenCalledTimes(1);
  });

  it('a failure toasts one fixed sentence (never the server text), says it beside the button, and keeps the button', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    resetMock.mockRejectedValue(Object.assign(new Error('database is locked'), { status: 500 }));
    mount();
    fireEvent.click(await screen.findByTestId('learning-reset-placement'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0][0]).toBe(COMMON.clearFailed);
    expect(toastMock.mock.calls[0][1]).toBe('error');
    expect(screen.getByTestId('learning-reset-placement-error').textContent).toBe(COMMON.clearFailed);
    await waitFor(() => expect(resetButton()).not.toBeNull());
    expect(resetButton()).not.toBeDisabled();
    expect(screen.getByTestId('learning-status-placement').textContent).toContain('At the Oct 26 reading, Auto had hour preferences');
  });

  it('a 403 tells the panel, toasts the fixed message, and does not show the server text', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    resetMock.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const onResetForbidden = vi.fn();
    mount({ onResetForbidden });
    fireEvent.click(await screen.findByTestId('learning-reset-placement'));
    await waitFor(() => expect(onResetForbidden).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toBe(COMMON.forbiddenToast);
    expect(toastMock.mock.calls[0][1]).toBe('error');
  });

  it('canReset false hides the button and shows the read-only note', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    mount({ canReset: false });
    await screen.findByTestId(HEADLINE);
    expect(resetButton()).toBeNull();
    expect(screen.getByTestId('learning-readonly-placement').textContent).toBe(COMMON.readOnlyNote);
  });

  it('canReset null (not known yet) shows neither the button nor the note', async () => {
    survivalMock.mockResolvedValue(PREFERENCES);
    mount({ canReset: null });
    await screen.findByTestId(HEADLINE);
    expect(resetButton()).toBeNull();
    expect(screen.queryByTestId('learning-readonly-placement')).toBeNull();
    expect(screen.queryByTestId('learning-nothing-to-clear-placement')).toBeNull();
  });
});

describe('PlacementTile: whole-card sweeps', () => {
  const FIXTURES: Record<string, PlacementSurvivalResponse> = {
    empty: res(),
    nullOnly: res(run('2026-10-26', 0, 0), run('2026-10-19', 0, 0)),
    thin: res(run('2026-10-26', 5, 2, { keys_learned: 1 })),
    measured: res(run('2026-10-26', 20, 8, { keys_learned: 2, biased: 1 }), run('2026-09-28', 18, 11)),
  };

  it.each(Object.keys(FIXTURES))('%s: no dashes or banned wording anywhere in the rendered card, every button typed', async (name) => {
    survivalMock.mockResolvedValue(FIXTURES[name]);
    const { container } = mount();
    await waitFor(() => expect(screen.queryByText(COMMON.loading)).toBeNull());
    expect(copyProblems(container.textContent ?? '')).toEqual([]);
    const buttons = container.querySelectorAll('button');
    for (const b of buttons) expect(b).toHaveAttribute('type', 'button');
    expect(container.querySelector('form')).toBeNull();
  });

  it('never prints the created column or a source-mixing explanation', async () => {
    survivalMock.mockResolvedValue(FIXTURES.measured);
    const { container } = mount();
    await screen.findByTestId(HEADLINE);
    expect(container.textContent).not.toMatch(/created|from all sources/i);
  });
});
