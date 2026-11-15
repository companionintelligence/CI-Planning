import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@solidjs/testing-library';
import type { DismissalTrendResponse, DismissalTrendRow, LearningResetResult } from '../../lib/api.js';
import type { LearningContext } from './LearningCard.js';
import { ZERO_PERCENT, textWithoutChart } from './learning-test-helpers.js';
import { localISODate } from '../../lib/dates.js';
import { clearedMemory } from '../../lib/learning-cleared.js';
import { COMMON, LEARNING_FACTS, copyProblems } from '../../lib/learning-copy.js';
import { formatRange, wilsonRange } from '../../lib/learning-stats.js';

/**
 * DismissalTile: the "Suggestions you dismiss" card.
 *
 * BUILDER (dismissalView, pure): what the card says for a given response.
 *   - the headline is always the NEWEST reading, whichever way the wire is ordered (this
 *     is the one endpoint that sends OLDEST first);
 *   - fraction first; a percent only at 10 or more decisions, and then with its range;
 *   - a week with nothing decided is "not measured" and a tick, never 0%;
 *   - `created` appears nowhere (it counts every source, so it is not the denominator);
 *   - one comparison, pooled by counts, that states a change and never a cause.
 *
 * COMPONENT: the real LearningCard frame with only the api and the toast mocked: loading,
 * error (never shown as "no readings"), empty, the reset flow, and a copy sweep.
 */

const trendMock = vi.fn(async (_limit?: number): Promise<DismissalTrendResponse> => ({ trend: [] }));
const resetMock = vi.fn(async (): Promise<LearningResetResult> => ({ ok: true, cleared: 0 }));
vi.mock('../../lib/api.js', () => ({
  api: {
    learning: {
      dismissalTrend: (limit?: number) => trendMock(limit),
      resetDismissal: () => resetMock(),
    },
  },
}));

const toastMock = vi.fn();
vi.mock('../../stores/index.js', () => ({
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { DismissalTile, dismissalView } = await import('./DismissalTile.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Nov 1 2026, local noon: the Oct 26 reading is 6 days old. */
const NOW = new Date(2026, 10, 1, 12, 0, 0);
/** `created` is set to a value that appears nowhere else, so any leak of it is visible. */
const CREATED = 4242;

const row = (
  computed_date: string,
  decided: number,
  dismissed: number,
  over: Partial<DismissalTrendRow> = {},
): DismissalTrendRow => ({
  computed_date,
  period_days: 7,
  created: CREATED,
  decided,
  dismissed,
  rate: decided > 0 ? dismissed / decided : null,
  exemplars: 0,
  hinted: 0,
  ...over,
});

/** Eight weekly Monday passes, oldest first, ending Oct 26. The first four are the
 *  "28 days before" block of a comparison anchored on Oct 26 and the last four the latest. */
const MONDAYS = [
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
  '2026-10-05',
  '2026-10-12',
  '2026-10-19',
  '2026-10-26',
] as const;

/** Eight weeks from per-week [decided, dismissed] pairs, oldest first. */
const weeks = (pairs: ReadonlyArray<readonly [number, number]>): DismissalTrendRow[] =>
  pairs.map(([decided, dismissed], i) => row(MONDAYS[i], decided, dismissed));

const ctx = (over: Partial<LearningContext> = {}): LearningContext => ({
  aiAvailable: null,
  smartMode: null,
  now: NOW,
  canReset: true,
  ...over,
});

const view = (trend: DismissalTrendRow[], over: Partial<LearningContext> = {}) =>
  dismissalView({ trend }, ctx(over));
/** The one series this card has. */
const rate = (trend: DismissalTrendRow[], over: Partial<LearningContext> = {}) => view(trend, over).series[0];


// ── BUILDER ──────────────────────────────────────────────────────────────────

describe('dismissalView: newest reading, whatever the wire order', () => {
  const trend = [row('2026-10-12', 6, 2), row('2026-10-19', 8, 3), row('2026-10-26', 5, 4)];

  it('the server sends OLDEST first; the headline is the newest row', () => {
    const s = rate(trend);
    expect(s.state).toBe('measured');
    expect(s.headline).toBe('4 of 5 decisions on suggestions were dismissals, in the 7 days to Oct 26.');
  });

  it('reversed and shuffled input give the same headline and the same table', () => {
    const base = rate(trend);
    for (const shuffled of [[...trend].reverse(), [trend[1], trend[2], trend[0]], [trend[2], trend[0], trend[1]]]) {
      const s = rate(shuffled);
      expect(s.headline).toBe(base.headline);
      expect(s.readings).toEqual(base.readings);
      expect(s.chart?.points).toEqual(base.chart?.points);
    }
  });

  it('the readings table is newest first and the chart is oldest first', () => {
    const s = rate(trend);
    expect(s.readings?.rows.map((r) => r.key)).toEqual(['2026-10-26', '2026-10-19', '2026-10-12']);
    expect(s.chart?.points.map((p) => p.date)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('never presents an older week as current: the newest row decides the state', () => {
    const s = rate([row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)]);
    expect(s.state).toBe('not-measured');
    expect(s.headline).not.toContain('3 of 8');
  });
});

describe('dismissalView: counts first, a percent only at 10 or more', () => {
  it('under 10 decisions: a fraction and no percent anywhere in the headline', () => {
    const s = rate([row('2026-10-26', 6, 4)]);
    expect(s.headline).toBe('4 of 6 decisions on suggestions were dismissals, in the 7 days to Oct 26.');
    expect(s.headline).not.toContain('%');
  });

  it('9 decisions gives a fraction; 10 gives the percent with the Wilson range', () => {
    const nine = rate([row('2026-10-26', 9, 4)]);
    expect(nine.headline).not.toContain('%');
    expect(nine.headline).toContain('4 of 9');

    const ten = rate([row('2026-10-26', 10, 4)]);
    const range = formatRange(wilsonRange(4, 10)!);
    expect(ten.headline).toBe(
      `40% dismissed (4 of 10 decisions) in the 7 days to Oct 26. With this many cases the true figure could be anywhere from ${range}.`,
    );
  });

  it('the spec example: 5 of 14 is 36% dismissed with its range', () => {
    const s = rate([row('2026-10-26', 14, 5)]);
    const range = formatRange(wilsonRange(5, 14)!);
    expect(s.headline).toBe(
      `36% dismissed (5 of 14 decisions) in the 7 days to Oct 26. With this many cases the true figure could be anywhere from ${range}.`,
    );
  });

  it('computes the percent from the counts, not from the wire rate', () => {
    // The wire rate is nonsense (0.99) but is a valid number, so it only says "measured".
    const s = rate([row('2026-10-26', 14, 5, { rate: 0.99 })]);
    expect(s.headline).toContain('36% dismissed (5 of 14 decisions)');
    expect(s.headline).not.toContain('99%');
  });

  it('a real zero is a measured 0%, not a gap', () => {
    const s = rate([row('2026-10-26', 12, 0)]);
    expect(s.state).toBe('measured');
    expect(s.headline).toContain('0% dismissed (0 of 12 decisions) in the 7 days to Oct 26.');
    expect(s.chart?.points[0].value).toBe(0);
  });

  it('a real zero under 10 stays a fraction', () => {
    const s = rate([row('2026-10-26', 5, 0)]);
    expect(s.headline).toBe('0 of 5 decisions on suggestions were dismissals, in the 7 days to Oct 26.');
    expect(s.chart?.points[0].value).toBe(0);
  });

  it('one decision reads as singular', () => {
    expect(rate([row('2026-10-26', 1, 1)]).headline).toBe('1 of 1 decision on suggestions was a dismissal, in the 7 days to Oct 26.');
  });

  it('the period phrase uses the row period_days', () => {
    expect(rate([row('2026-10-26', 6, 4, { period_days: 14 })]).headline).toContain('in the 14 days to Oct 26.');
  });

  it('detail says lower is better and how old the reading is', () => {
    expect(rate([row('2026-10-26', 6, 4)]).detail).toBe('Lower is better. Latest reading: Oct 26 (6 days ago).');
    expect(rate([row('2026-10-26', 6, 4)], { now: new Date(2026, 9, 27, 9, 0) }).detail).toBe(
      'Lower is better. Latest reading: Oct 26 (yesterday).',
    );
  });
});

describe('dismissalView: nothing decided is "not measured", never 0%', () => {
  it('decided 0 gives the Not measured sentence, a tick, and no 0% in the view', () => {
    const v = view([row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)]);
    const s = v.series[0];
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe('Not measured: you did not approve or dismiss any suggestion in the 7 days to Oct 26.');
    // A tick, not a dot: the last point has no value.
    expect(s.chart?.points.at(-1)?.value).toBeNull();
    expect(s.chart?.points.at(-1)?.label).toBe('Oct 26: not measured');
    expect(JSON.stringify(v)).not.toMatch(ZERO_PERCENT);
  });

  it('a not-measured week says nothing about direction', () => {
    expect(rate([row('2026-10-26', 0, 0)]).detail).toBe('Latest reading: Oct 26 (6 days ago).');
  });

  it('a null newest week keeps the older reading as a note, never as the headline', () => {
    const s = rate([row('2026-10-12', 6, 2), row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)]);
    expect(s.notes).toEqual(['Last measured: 3 of 8 decisions were dismissals, on Oct 19.']);
    expect(s.headline?.startsWith('Not measured')).toBe(true);
  });

  it('no note when nothing was ever measured', () => {
    expect(rate([row('2026-10-19', 0, 0), row('2026-10-26', 0, 0)]).notes).toEqual([]);
  });

  it('the table says "not measured" for the share and no dismissal rate appears', () => {
    const s = rate([row('2026-10-26', 0, 0)]);
    expect(s.readings?.rows[0].cells).toEqual(['Oct 26', '0', '0', 'not measured', '0']);
  });

  it('a row with decisions but no usable rate is not explained as "you decided nothing"', () => {
    const s = rate([row('2026-10-26', 5, 2, { rate: null })]);
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe('Not measured: the reading in the 7 days to Oct 26 could not be used.');
    expect(s.headline).not.toContain('did not approve');
  });

  it('an impossible row (more dismissed than decided) is not measured and plots nothing', () => {
    const s = rate([row('2026-10-26', 4, 9, { rate: 2.25 })]);
    expect(s.state).toBe('not-measured');
    expect(s.chart?.points[0].value).toBeNull();
  });
});

describe('dismissalView: no rows at all', () => {
  it('is state none with the Monday wording and no chart, table, status or reset', () => {
    const v = view([]);
    const s = v.series[0];
    expect(s.state).toBe('none');
    expect(s.headline).toBeNull();
    expect(s.detail).toBeNull();
    expect(s.chart).toBeNull();
    expect(s.readings).toBeNull();
    expect(s.comparison).toBeNull();
    expect(s.empty).toBe(
      'No readings yet. A reading is added every Monday, even when you decided nothing. If this stays empty after a Monday, the weekly pass has not run.',
    );
    expect(v.status).toBeNull();
    expect(v.contextLines).toEqual([]);
    expect(v.startOpen).toBe(true);
    expect(v.resetAvailable).toBe(false);
  });

  it('survives a response with no trend array', () => {
    expect(dismissalView({} as DismissalTrendResponse, ctx()).series[0].state).toBe('none');
  });
});

describe('dismissalView: created is never shown', () => {
  it('appears nowhere in the view, and the old "new suggestions arrived" wording is gone', () => {
    const v = view([row('2026-10-19', 8, 3, { exemplars: 23, hinted: 1 }), row('2026-10-26', 14, 5, { exemplars: 23, hinted: 1 })]);
    const json = JSON.stringify(v);
    expect(json).not.toContain(String(CREATED));
    expect(json).not.toMatch(/created/i);
    expect(json).not.toContain('new suggestions arrived');
    expect(json).not.toContain('from all sources');
    // The readings table has no column for it.
    expect(v.series[0].readings?.columns).toEqual(['Date', 'Decided', 'Dismissed', 'Share', 'Examples stored at this pass']);
  });
});

describe('dismissalView: status and reset availability come from the newest row', () => {
  it('exemplars 0: shown no past dismissals right now, says what it needs including the 90-day window, and nothing to clear', () => {
    const v = view([row('2026-10-26', 6, 4, { exemplars: 0 })]);
    expect(v.status).toBe(
      'The model is shown no past dismissals right now. ' +
        'That needs 5 dismissals from the last 90 days that are over a day old and that you did not reverse by approving. Older ones drop out.',
    );
    expect(v.resetAvailable).toBe(false);
    // Built from the facts, so a change to the window or the floor in LEARNING_FACTS follows through.
    expect(v.status).toContain(`${LEARNING_FACTS.dismissal.settledFloor} dismissals from the last ${LEARNING_FACTS.dismissal.windowDays} days`);
  });

  it('exemplars 23: names the count, dates it, and offers the clear', () => {
    const v = view([row('2026-10-26', 6, 4, { exemplars: 23, hinted: 1 })]);
    // Worded as a dated reading, not as the present: a clear made since writes no row.
    expect(v.status).toBe(
      'At the Oct 26 reading, 23 past dismissals were stored. ' +
        'Up to 3 are shown to the model at a time while it reads email, calendar events or text notes for suggestions.',
    );
    expect(v.resetAvailable).toBe(true);
  });

  it('one stored dismissal reads as a singular', () => {
    expect(view([row('2026-10-26', 6, 4, { exemplars: 1, hinted: 1 })]).status).toContain('1 past dismissal was stored.');
  });

  it('does not say the examples are used only for email: calendar events and text notes get them too', () => {
    const v = view([row('2026-10-26', 6, 4, { exemplars: 23, hinted: 1 })]);
    expect(v.status).toContain('email, calendar events or text notes');
    expect(v.status).not.toMatch(/while it reads new email\.|only (for )?email/i);
  });

  it('only the newest row counts: old exemplars do not keep the clear available', () => {
    const v = view([row('2026-10-19', 6, 4, { exemplars: 23, hinted: 1 }), row('2026-10-26', 6, 4, { exemplars: 0, hinted: 1 })]);
    expect(v.resetAvailable).toBe(false);
    expect(v.status).toContain('shown no past dismissals right now');
  });

  it('a not-measured newest week still reports the stored count', () => {
    const v = view([row('2026-10-26', 0, 0, { exemplars: 4, hinted: 1 })]);
    expect(v.status).toContain('At the Oct 26 reading, 4 past dismissals were stored.');
    expect(v.resetAvailable).toBe(true);
  });
});

describe('dismissalView: a clear made this session overrides the Monday count', () => {
  const stored = [row('2026-10-19', 8, 3, { exemplars: 23, hinted: 1 }), row('2026-10-26', 14, 5, { exemplars: 23, hinted: 1 })];

  it('a clear after the newest reading says so, and offers nothing more to clear', () => {
    const v = view(stored, { clearedOn: { dismissal: '2026-10-28' } });
    expect(v.status).toBe("Cleared on Oct 28. The model is shown no past dismissals until Monday's pass.");
    expect(v.resetAvailable).toBe(false);
    // The stale count is not printed as if it were current.
    expect(v.status).not.toContain('23');
  });

  it('a clear on the same day as the reading counts as after it (the pass runs early Monday)', () => {
    const v = view(stored, { clearedOn: { dismissal: '2026-10-26' } });
    expect(v.status).toMatch(/^Cleared on Oct 26\./);
    expect(v.resetAvailable).toBe(false);
  });

  it('a clear older than the newest reading is ignored: that reading already reflects it', () => {
    const v = view(stored, { clearedOn: { dismissal: '2026-10-20' } });
    expect(v.status).toContain('At the Oct 26 reading, 23 past dismissals were stored.');
    expect(v.resetAvailable).toBe(true);
  });

  it('only the dismissal loop reads it', () => {
    const v = view(stored, { clearedOn: { placement: '2026-10-28', classification: '2026-10-28' } });
    expect(v.resetAvailable).toBe(true);
  });

  it('leaves the headline and the table alone: past readings stay', () => {
    const base = view(stored);
    const after = view(stored, { clearedOn: { dismissal: '2026-10-28' } });
    expect(after.series).toEqual(base.series);
  });
});

describe('dismissalView: where the examples are shown', () => {
  it('says calendar events and text notes get past dismissals too, but only email decisions are counted', () => {
    const text = JSON.stringify(view([row('2026-10-26', 6, 4, { exemplars: 3, hinted: 1 })]));
    expect(text).toContain('calendar events or text notes');
  });
});

describe('dismissalView: the examples-stored marker', () => {
  it('sits on the first hinted reading', () => {
    const s = rate([row('2026-10-05', 6, 2), row('2026-10-12', 6, 2, { hinted: 1 }), row('2026-10-19', 6, 2, { hinted: 1 })]);
    expect(s.chart?.marker).toEqual({ date: '2026-10-12', text: 'Examples stored by Oct 12' });
  });

  it('says "by", not "from": hinted is sampled before the weekly rebuild, so the set can be a week older', () => {
    const s = rate([row('2026-10-05', 6, 2), row('2026-10-12', 6, 2, { hinted: 1 })]);
    expect(s.chart?.marker?.text).toBe('Examples stored by Oct 12');
    expect(s.chart?.marker?.text).not.toMatch(/stored from/);
  });

  it('draws no marker when the first reading in the window is already flagged, and the caption says why', () => {
    // A longer history than the 12 rows requested: the set was stored before this window began,
    // so a marker at the first row would claim a start date that is up to weeks too late.
    const s = rate([row('2026-10-05', 6, 2, { hinted: 1 }), row('2026-10-12', 6, 2, { hinted: 1 }), row('2026-10-19', 6, 2, { hinted: 1 })]);
    expect(s.chart?.marker).toBeNull();
    expect(s.chart?.caption).toContain(COMMON.chartCaption);
    expect(s.chart?.caption).toContain('Past dismissals were already stored at the earliest reading shown, so no marker is drawn.');
    expect(s.chart?.caption).not.toContain('The dashed line marks');
  });

  it('still marks a flip that happens after the first reading shown', () => {
    const s = rate([row('2026-10-05', 6, 2, { hinted: 0 }), row('2026-10-12', 6, 2, { hinted: 1 })]);
    expect(s.chart?.marker?.date).toBe('2026-10-12');
    expect(s.chart?.caption).not.toContain('already stored at the earliest reading shown');
  });

  it('is null when no reading was hinted, and the legend is then left out', () => {
    const s = rate([row('2026-10-12', 6, 2), row('2026-10-19', 6, 2)]);
    expect(s.chart?.marker).toBeNull();
    expect(s.chart?.caption).toBe(COMMON.chartCaption);
  });

  it('a hinted run that falls back to 0 and returns still marks only the first flip', () => {
    const s = rate([
      row('2026-10-05', 6, 2, { hinted: 0 }),
      row('2026-10-12', 6, 2, { hinted: 1 }),
      row('2026-10-19', 6, 2, { hinted: 0 }),
      row('2026-10-26', 6, 2, { hinted: 1 }),
    ]);
    expect(s.chart?.marker).toEqual({ date: '2026-10-12', text: 'Examples stored by Oct 12' });
  });

  it('is found by date, not by wire position', () => {
    const rows = [row('2026-10-05', 6, 2), row('2026-10-12', 6, 2, { hinted: 1 }), row('2026-10-19', 6, 2, { hinted: 1 })];
    expect(rate([...rows].reverse()).chart?.marker?.date).toBe('2026-10-12');
  });

  it('the legend says it does not show use', () => {
    const s = rate([row('2026-10-05', 6, 2), row('2026-10-12', 6, 2, { hinted: 1 })]);
    expect(s.chart?.caption).toContain(COMMON.chartCaption);
    expect(s.chart?.caption).toContain(
      'The dashed line marks the first reading taken after a set of past dismissals was stored. It does not show that any email was read with one.',
    );
  });

  it('the chart is weekly', () => {
    expect(rate([row('2026-10-26', 6, 2)]).chart?.cadenceDays).toBe(7);
  });
});

/** 'could be 17% to 50%', generated from wilsonRange so a typed range cannot drift from the maths. */
const could = (hits: number, n: number) => `could be ${formatRange(wilsonRange(hits, n)!)}`;

describe('dismissalView: the 28-day comparison', () => {
  it('overlapping ranges say no clear change, with pooled counts (not averaged rates)', () => {
    // Latest four weeks 9 of 29, the four before 12 of 27.
    const s = rate(weeks([[7, 3], [7, 3], [7, 3], [6, 3], [8, 2], [7, 3], [7, 2], [7, 2]]));
    expect(s.comparison).toBe(
      `The 28 days to Oct 26 (4 readings, Oct 5 to Oct 26): 31% dismissed (9 of 29, ${could(9, 29)}). ` +
        `The 28 days before (4 readings, Sep 7 to Sep 28): 44% (12 of 27, ${could(12, 27)}). ` +
        'The ranges overlap, so this is no clear change. A gap this size could be chance.',
    );
  });

  it('pools counts: weeks of different sizes are not averaged', () => {
    // Latest block: 1 of 14, 0 of 2, 0 of 2, 1 of 2 = 2 of 20 (10%), not the mean of the four
    // weekly rates (7%, 0%, 0%, 50% averages to 14%).
    const s = rate(weeks([[10, 5], [10, 5], [10, 5], [10, 5], [14, 1], [2, 0], [2, 0], [2, 1]]));
    expect(s.comparison).toContain(`The 28 days to Oct 26 (4 readings, Oct 5 to Oct 26): 10% dismissed (2 of 20, ${could(2, 20)}).`);
  });

  it('separated ranges with a drop say lower, and say it is not a cause', () => {
    const s = rate(weeks([[10, 6], [10, 6], [10, 6], [10, 6], [10, 1], [10, 1], [10, 1], [10, 1]]));
    expect(s.comparison).toBe(
      `The 28 days to Oct 26 (4 readings, Oct 5 to Oct 26): 10% dismissed (4 of 40, ${could(4, 40)}). ` +
        `The 28 days before (4 readings, Sep 7 to Sep 28): 60% (24 of 40, ${could(24, 40)}). ` +
        'That is lower by more than chance would explain. It shows a change, not the reason for it.',
    );
  });

  it('separated ranges with a rise say higher', () => {
    const s = rate(weeks([[10, 1], [10, 1], [10, 1], [10, 1], [10, 6], [10, 6], [10, 6], [10, 6]]));
    expect(s.comparison).toContain('That is higher by more than chance would explain.');
    expect(s.comparison).toContain('not the reason for it');
  });

  it('a side under 10 decisions gives the too-few line', () => {
    // The earlier four weeks hold 9 decisions in total.
    const s = rate(weeks([[3, 1], [3, 1], [3, 1], [0, 0], [10, 3], [10, 3], [10, 3], [10, 3]]));
    expect(s.comparison).toBe('Not enough cases to compare yet. Each 28-day period needs at least 10 decisions.');
  });

  it('too few readings at all gives the too-few line', () => {
    expect(rate([row('2026-10-26', 12, 3)]).comparison).toBe(
      'Not enough cases to compare yet. Each 28-day period needs at least 10 decisions.',
    );
  });

  it('never gives a direction of good or a cause', () => {
    const fixtures = [
      weeks([[7, 3], [7, 3], [7, 3], [6, 3], [8, 2], [7, 3], [7, 2], [7, 2]]),
      weeks([[10, 6], [10, 6], [10, 6], [10, 6], [10, 1], [10, 1], [10, 1], [10, 1]]),
      weeks([[10, 1], [10, 1], [10, 1], [10, 1], [10, 6], [10, 6], [10, 6], [10, 6]]),
      [row('2026-10-26', 3, 1)],
    ];
    for (const trend of fixtures) {
      const c = rate(trend).comparison ?? '';
      expect(c).not.toMatch(/better|worse|the direction you want|because|due to|caused|improv/i);
      expect(copyProblems(c)).toEqual([]);
    }
  });

  it('a null newest week does not move the window', () => {
    // Oct 26 is a null week. The anchor is the newest MEASURED reading, Oct 19.
    const s = rate([
      ...weeks([[10, 5], [10, 5], [10, 5], [10, 5], [10, 5], [10, 5], [10, 5]]),
      row('2026-10-26', 0, 0),
    ]);
    expect(s.comparison).toContain('The 28 days to Oct 19 (');
  });
});

describe('dismissalView: the stale line', () => {
  const trend = [row('2026-10-19', 8, 3), row('2026-10-26', 6, 4)];

  it('15 days after the newest reading adds the line', () => {
    const v = view(trend, { now: new Date(2026, 10, 10, 12) });
    expect(v.contextLines).toEqual([
      'No new reading for 15 days. The weekly pass may not have run; it needs the server to be on early on Monday.',
    ]);
  });

  it('9 days does not; 10 days does', () => {
    expect(view(trend, { now: new Date(2026, 10, 4, 12) }).contextLines).toEqual([]);
    expect(view(trend, { now: new Date(2026, 10, 5, 12) }).contextLines[0]).toContain('No new reading for 10 days.');
  });

  it('is not shown when there are no rows, or for a fresh reading', () => {
    expect(view([], { now: new Date(2026, 10, 10, 12) }).contextLines).toEqual([]);
    expect(view(trend).contextLines).toEqual([]);
  });

  it('applies to a not-measured newest week too: a quiet gap is a real signal here', () => {
    const v = view([row('2026-10-26', 0, 0)], { now: new Date(2026, 10, 20, 12) });
    expect(v.contextLines[0]).toContain('No new reading for 25 days.');
  });
});

describe('dismissalView: the readings table', () => {
  it('shows counts always, the share only at 10 or more, and the count stored at each pass', () => {
    const s = rate([
      row('2026-10-12', 0, 0),
      row('2026-10-19', 6, 4, { hinted: 1, exemplars: 5 }),
      row('2026-10-26', 14, 5, { hinted: 1, exemplars: 5 }),
    ]);
    expect(s.readings?.columns).toEqual(['Date', 'Decided', 'Dismissed', 'Share', 'Examples stored at this pass']);
    expect(s.readings?.rows).toEqual([
      { key: '2026-10-26', cells: ['Oct 26', '14', '5', '36%', '5'] },
      { key: '2026-10-19', cells: ['Oct 19', '6', '4', 'under 10 cases', '5'] },
      { key: '2026-10-12', cells: ['Oct 12', '0', '0', 'not measured', '0'] },
    ]);
  });

  it('the stored column agrees with the status line for the same reading (it is the count after the rebuild, not hinted)', () => {
    // The run that first builds 7 examples: hinted is 0 (nothing existed before), exemplars is 7.
    const first = view([row('2026-10-19', 8, 3, { hinted: 0, exemplars: 7 })]);
    expect(first.series[0].readings?.rows[0].cells.at(-1)).toBe('7');
    expect(first.status).toContain('At the Oct 19 reading, 7 past dismissals were stored.');
    // And the marker, which is about hinted, does not claim the set was stored from that date.
    expect(first.series[0].chart?.marker).toBeNull();
  });
});

describe('dismissalView: startOpen', () => {
  it('is open when the newest reading is not measured, closed when it is', () => {
    expect(view([row('2026-10-26', 0, 0)]).startOpen).toBe(true);
    expect(view([row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)]).startOpen).toBe(true);
    expect(view([row('2026-10-26', 6, 4)]).startOpen).toBe(false);
  });
});

describe('dismissalView: copy is clean', () => {
  it('passes the sweep for measured, not-measured, empty and stale views', () => {
    const many = [
      view([row('2026-10-26', 14, 5, { exemplars: 23, hinted: 1 })]),
      view([row('2026-10-26', 6, 4)]),
      view([row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)]),
      view([]),
      view([row('2026-10-26', 6, 4)], { now: new Date(2026, 10, 20, 12) }),
      view(weeks([[10, 6], [10, 6], [10, 6], [10, 6], [10, 1], [10, 1], [10, 1], [10, 1]])),
    ];
    for (const v of many) expect(copyProblems(JSON.stringify(v))).toEqual([]);
  });
});

// ── COMPONENT ────────────────────────────────────────────────────────────────

const ID = {
  card: 'learning-card-dismissal',
  headline: 'learning-headline-dismissal-rate',
  detail: 'learning-detail-dismissal-rate',
  comparison: 'learning-comparison-dismissal-rate',
  empty: 'learning-empty-dismissal-rate',
  chart: 'learning-chart-dismissal-rate',
  readings: 'learning-readings-dismissal-rate',
  status: 'learning-status-dismissal',
  more: 'learning-more-dismissal',
  about: 'learning-about-dismissal',
  reset: 'learning-reset-dismissal',
  hint: 'learning-reset-hint-dismissal',
  nothing: 'learning-nothing-to-clear-dismissal',
  readonly: 'learning-readonly-dismissal',
  error: 'learning-error-dismissal',
  retry: 'learning-retry-dismissal',
  caveat: 'learning-primary-caveat-dismissal',
  context: 'learning-context-dismissal',
} as const;

const confirmMock = vi.fn(() => true);

/** A response the server could send: oldest first. */
const MEASURED: DismissalTrendRow[] = [
  row('2026-10-12', 6, 2, { exemplars: 0, hinted: 0 }),
  row('2026-10-19', 8, 3, { exemplars: 23, hinted: 1 }),
  row('2026-10-26', 14, 5, { exemplars: 23, hinted: 1 }),
];

function mount(trend: DismissalTrendRow[] | Error | Promise<DismissalTrendResponse>, over: Partial<LearningContext> = {}) {
  trendMock.mockReset();
  if (trend instanceof Error) trendMock.mockRejectedValue(trend);
  else if (trend instanceof Promise) trendMock.mockReturnValue(trend);
  else trendMock.mockResolvedValue({ trend });
  return render(() => <DismissalTile context={ctx(over)} />);
}
const ready = async () => {
  // Either a headline (rows exist) or the empty text (none).
  await waitFor(() => expect(screen.queryByTestId(ID.headline) ?? screen.queryByTestId(ID.empty)).toBeTruthy());
};
const card = () => screen.getByTestId(ID.card);
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

beforeEach(() => {
  trendMock.mockReset().mockResolvedValue({ trend: [] });
  resetMock.mockReset().mockResolvedValue({ ok: true, cleared: 0 });
  toastMock.mockReset();
  confirmMock.mockReset().mockReturnValue(true);
  vi.stubGlobal('confirm', confirmMock);
});

describe('DismissalTile: loading and reading', () => {
  it('asks for 12 rows, once, and renders the newest reading', async () => {
    mount(MEASURED);
    await ready();
    expect(trendMock).toHaveBeenCalledTimes(1);
    expect(trendMock).toHaveBeenCalledWith(12);
    expect(screen.getByTestId(ID.headline).textContent).toContain('36% dismissed (5 of 14 decisions) in the 7 days to Oct 26.');
    expect(screen.getByTestId(ID.headline).getAttribute('data-state')).toBe('measured');
    expect(screen.getByTestId(ID.detail).textContent).toBe('Lower is better. Latest reading: Oct 26 (6 days ago).');
    expect(screen.getByTestId(ID.status).textContent).toContain('At the Oct 26 reading, 23 past dismissals were stored.');
  });

  it('shows the loading text while the request is pending, and the caveat even then', async () => {
    let release!: (v: DismissalTrendResponse) => void;
    mount(new Promise<DismissalTrendResponse>((res) => (release = res)));
    expect(card().textContent).toContain(COMMON.loading);
    expect(screen.queryByTestId(ID.headline)).toBeNull();
    expect(screen.getByTestId(ID.caveat).textContent).toContain('does not mean the model got better');
    release({ trend: MEASURED });
    await ready();
    expect(card().textContent).not.toContain(COMMON.loading);
  });

  it('renders the wire order it is given (oldest first) with the newest as the headline', async () => {
    mount(MEASURED);
    await ready();
    // Newest first in the table, whatever order the rows arrived in.
    const text = screen.getByTestId(ID.readings).textContent ?? '';
    expect(text.indexOf('Oct 26')).toBeGreaterThan(-1);
    expect(text.indexOf('Oct 26')).toBeLessThan(text.indexOf('Oct 19'));
    expect(text.indexOf('Oct 19')).toBeLessThan(text.indexOf('Oct 12'));
  });

  it('shows the comparison under the chart, and the marker text in the caption', async () => {
    mount(weeks([[7, 3], [7, 3], [7, 3], [6, 3], [8, 2], [7, 3], [7, 2], [7, 2]]).map((r, i) => ({ ...r, hinted: i >= 5 ? 1 : 0 })));
    await ready();
    expect(screen.getByTestId(ID.comparison).textContent).toContain('this is no clear change');
    expect(screen.getByTestId(ID.chart)).toBeTruthy();
    expect(card().textContent).toContain('The dashed line marks the first reading taken after a set of past dismissals was stored.');
  });

  it('shows the stale line for an old reading', async () => {
    mount(MEASURED, { now: new Date(2026, 10, 10, 12) });
    await ready();
    expect(screen.getByTestId(ID.context).textContent).toBe(
      'No new reading for 15 days. The weekly pass may not have run; it needs the server to be on early on Monday.',
    );
  });

  it('shows no context line for a fresh reading, or for a model that is off (this loop only reads logged decisions)', async () => {
    mount(MEASURED, { aiAvailable: false, smartMode: false });
    await ready();
    expect(screen.queryByTestId(ID.context)).toBeNull();
    expect(card().textContent).not.toMatch(/local model is not ready/i);
  });

  it('never prints created', async () => {
    mount(MEASURED);
    await ready();
    expect(card().textContent).not.toMatch(/\b4242\b/);
    expect(card().textContent).not.toContain('new suggestions arrived');
    expect(card().textContent).not.toContain('from all sources');
  });
});

describe('DismissalTile: where past dismissals are used', () => {
  it('the card says calendar events and text notes are read with them too, and are never counted', async () => {
    mount(MEASURED);
    await ready();
    const text = card().textContent ?? '';
    expect(text).toContain('whenever the app reads email, calendar events or text notes for suggestions');
    expect(text).toContain('Only decisions on email suggestions are counted');
    const more = screen.getByTestId(ID.more).textContent ?? '';
    expect(more).toContain('Past email dismissals are also shown to the model when it reads calendar events and text notes.');
    expect(more).toContain('new email, calendar events or text notes are read for the examples to be shown to it');
    // The narrow wording is gone.
    expect(text).not.toContain('while it reads that email');
    expect(more).not.toContain('while new email is read');
  });

  it('remembers a real clear for the rest of the session, and not a clear that found nothing', async () => {
    clearedMemory.forget();
    resetMock.mockResolvedValue({ ok: true, cleared: 23 });
    mount(MEASURED);
    await ready();
    fireEvent.click(screen.getByTestId(ID.reset));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(clearedMemory.recall().dismissal).toBe(localISODate(new Date()));
    clearedMemory.forget();

    resetMock.mockResolvedValue({ ok: true, cleared: 0 });
    toastMock.mockReset();
    cleanup();
    mount(MEASURED);
    await ready();
    fireEvent.click(screen.getByTestId(ID.reset));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(clearedMemory.recall().dismissal).toBeUndefined();
  });
});

describe('DismissalTile: the primary caveat and the details', () => {
  it('the first caveat is visible; the details are closed for a measured reading', async () => {
    mount(MEASURED);
    await ready();
    expect(screen.getByTestId(ID.caveat).textContent).toBe(
      'A lower rate does not mean the model got better. It can also mean different mail arrived, or that you reviewed fewer suggestions.',
    );
    expect((screen.getByTestId(ID.more) as HTMLDetailsElement).open).toBe(false);
  });

  it('the details are open when the newest reading is not measured, and hold the corrected start steps', async () => {
    mount([row('2026-10-26', 0, 0)]);
    await ready();
    const more = screen.getByTestId(ID.more) as HTMLDetailsElement;
    expect(more.open).toBe(true);
    expect(more.textContent).toContain('Connect a Google account under Settings → Connections');
    expect(more.textContent).toContain("'Suggested from email' in the Tasks tab");
    expect(more.textContent).toContain('After 5 dismissals from the last 90 days that are over a day old');
    expect(more.textContent).toContain('Dismissals older than 90 days drop out');
    expect(more.textContent).toContain('It counts decisions (clicks), not suggestions.');
    expect(more.textContent).toContain('Only email suggestions wait for your decision.');
  });

  it('the details are open when there are no rows', async () => {
    mount([]);
    await ready();
    expect((screen.getByTestId(ID.more) as HTMLDetailsElement).open).toBe(true);
  });
});

describe('DismissalTile: what the card says about itself', () => {
  const open = async () => {
    mount(MEASURED);
    await ready();
    return {
      about: screen.getByTestId(ID.about).textContent ?? '',
      more: screen.getByTestId(ID.more),
    };
  };

  it('what it counts: the 7-day window, the share, and what is left out', async () => {
    const { about } = await open();
    expect(about).toContain('Email suggestions that you approved or dismissed by hand, counted over the last 7 days.');
    expect(about).toContain('One reading is added early on Monday (server time).');
    expect(about).toContain('The share dismissed is dismissals divided by decisions.');
    expect(about).toContain('Suggestions the app added by itself are not counted, and neither are ones you left waiting.');
    expect(about).toContain('It counts decisions, not distinct suggestions.');
    expect(about).toContain(`last ${LEARNING_FACTS.dismissal.periodDays} days`);
  });

  it('what it changes: the floor, the 90-day window, the number shown, and that it never hides a suggestion', async () => {
    const { about } = await open();
    expect(about).toContain('It changes what is proposed, never what is hidden.');
    expect(about).toContain(
      'After 5 dismissals from the last 90 days that have settled (over a day old, and not reversed by approving), ' +
        'up to 3 past dismissals that look like a new item are shown to the model as history',
    );
    expect(about).toContain('whenever the app reads email, calendar events or text notes for suggestions');
    expect(about).toContain('Only decisions on email suggestions are counted in the share below.');
    expect(about).toContain('It never hides or filters a suggestion.');
    // The same two facts the status line and the start steps quote.
    expect(about).toContain(`${LEARNING_FACTS.dismissal.settledFloor} dismissals from the last ${LEARNING_FACTS.dismissal.windowDays} days`);
    expect(about).toContain(`up to ${LEARNING_FACTS.dismissal.retrieveK} past dismissals`);
  });

  it('how it starts: the floor with its 90-day window, that older ones drop out, and that nothing is needed to begin the readings', async () => {
    const { more } = await open();
    const steps = more.textContent ?? '';
    expect(steps).toContain('After 5 dismissals from the last 90 days that are over a day old and that you did not reverse by approving, the weekly pass builds the examples.');
    expect(steps).toContain('Dismissals older than 90 days drop out, so the examples go again if fewer than 5 are left.');
    expect(steps).toContain('Readings start on the first Monday after install whether or not you have decided anything.');
    expect(steps).toContain("The rate stays 'not measured' until you do.");
  });

  it('the caveats under "More about this number": all eight', async () => {
    const { more } = await open();
    const items = [...more.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(8);
    expect(items[0]).toContain('It counts decisions (clicks), not suggestions.');
    expect(items[1]).toContain('Only suggestions you decided on are in the rate.');
    expect(items[2]).toContain('Only email suggestions wait for your decision.');
    expect(items[3]).toContain('Past email dismissals are also shown to the model when it reads calendar events and text notes.');
    expect(items[4]).toContain('can lag the examples by more than one reading');
    expect(items[5]).toContain("'Examples stored' means the stored set was not empty before that reading's weekly pass.");
    expect(items[6]).toContain('not a controlled test');
    expect(items[7]).toContain("A week with nothing decided is 'not measured', not a good week.");
  });

  it('the Last measured note names what is counted, singular for one decision', () => {
    const one = view([row('2026-10-19', 1, 1), row('2026-10-26', 0, 0)]);
    expect(one.series[0].notes).toEqual(['Last measured: 1 of 1 decision was a dismissal, on Oct 19.']);
    const eight = view([row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)]);
    expect(eight.series[0].notes).toEqual(['Last measured: 3 of 8 decisions were dismissals, on Oct 19.']);
  });
});

describe('DismissalTile: empty and not measured', () => {
  it('no rows: the Monday wording, no chart, and never an error', async () => {
    mount([]);
    await ready();
    expect(screen.getByTestId(ID.empty).textContent).toContain('A reading is added every Monday, even when you decided nothing.');
    expect(screen.queryByTestId(ID.chart)).toBeNull();
    expect(screen.queryByTestId(ID.readings)).toBeNull();
    expect(screen.queryByTestId(ID.error)).toBeNull();
  });

  it('a week with nothing decided: Not measured, a chart, and no 0% in the card', async () => {
    mount([row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)]);
    await ready();
    const headline = screen.getByTestId(ID.headline);
    expect(headline.getAttribute('data-state')).toBe('not-measured');
    expect(headline.textContent).toBe('Not measured: you did not approve or dismiss any suggestion in the 7 days to Oct 26.');
    expect(card().textContent).toContain('Last measured: 3 of 8 decisions were dismissals, on Oct 19.');
    expect(screen.getByTestId(ID.chart)).toBeTruthy();
    expect(textWithoutChart(card())).not.toMatch(ZERO_PERCENT);
  });
});

describe('DismissalTile: a failed fetch is an error, not emptiness', () => {
  it('shows the failure text and Try again, never "No readings yet"', async () => {
    mount(httpError('db exploded', 500));
    await waitFor(() => expect(screen.getByTestId(ID.error)).toBeTruthy());
    expect(screen.getByTestId(ID.error).textContent).toContain(COMMON.errorFailed);
    expect(card().textContent).not.toContain('No readings yet');
    expect(card().textContent).not.toContain('db exploded');
    expect(screen.queryByTestId(ID.headline)).toBeNull();
    expect(screen.queryByTestId(ID.empty)).toBeNull();
    expect(screen.getByTestId(ID.caveat)).toBeTruthy();
  });

  it('status 0 reads as offline and 404 as an older server', async () => {
    const off = mount(httpError('Failed to fetch', 0));
    await waitFor(() => expect(screen.getByTestId(ID.error).textContent).toContain(COMMON.errorOffline));
    off.unmount();

    mount(httpError('Not found', 404));
    await waitFor(() => expect(screen.getByTestId(ID.error).textContent).toContain(COMMON.errorUnsupported));
    expect(card().textContent).not.toContain('No readings yet');
  });

  it('Try again calls this loader once more and then shows the data', async () => {
    mount(httpError('nope', 500));
    await waitFor(() => expect(screen.getByTestId(ID.retry)).toBeTruthy());
    expect(trendMock).toHaveBeenCalledTimes(1);

    trendMock.mockResolvedValue({ trend: MEASURED });
    fireEvent.click(screen.getByTestId(ID.retry));
    await waitFor(() => expect(screen.getByTestId(ID.headline)).toBeTruthy());
    expect(trendMock).toHaveBeenCalledTimes(2);
    expect(trendMock).toHaveBeenLastCalledWith(12);
    expect(screen.queryByTestId(ID.error)).toBeNull();
  });
});

describe('DismissalTile: the clear', () => {
  it('is offered only when the newest reading has stored dismissals, with the hint visible up front', async () => {
    mount(MEASURED);
    await ready();
    const btn = screen.getByTestId(ID.reset) as HTMLButtonElement;
    expect(btn.textContent).toBe('Clear learned dismissals');
    expect(btn.type).toBe('button');
    const hint = screen.getByTestId(ID.hint).textContent ?? '';
    expect(hint).toContain('Your approve and dismiss history is kept');
    expect(hint).toContain("Monday's pass builds them again");
    expect(hint).toContain('Past readings stay');
    expect(hint).toContain('There is no setting that turns this off.');
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('with no stored dismissals there is no button, and the card says there is nothing to clear', async () => {
    mount([row('2026-10-26', 6, 4, { exemplars: 0 })]);
    await ready();
    expect(screen.queryByTestId(ID.reset)).toBeNull();
    expect(screen.getByTestId(ID.nothing).textContent).toBe('No past dismissals are stored, so there is nothing to clear.');
  });

  it('is not offered with no rows', async () => {
    mount([]);
    await ready();
    expect(screen.queryByTestId(ID.reset)).toBeNull();
  });

  it('a viewer sees the read-only note and no button; an unknown role sees neither', async () => {
    const a = mount(MEASURED, { canReset: false });
    await ready();
    expect(screen.queryByTestId(ID.reset)).toBeNull();
    expect(screen.getByTestId(ID.readonly).textContent).toBe(COMMON.readOnlyNote);
    a.unmount();

    mount(MEASURED, { canReset: null });
    await ready();
    expect(screen.queryByTestId(ID.reset)).toBeNull();
    expect(screen.queryByTestId(ID.readonly)).toBeNull();
  });

  it('Cancel on the confirm sends no request', async () => {
    confirmMock.mockReturnValue(false);
    mount(MEASURED);
    await ready();
    fireEvent.click(screen.getByTestId(ID.reset));
    expect(confirmMock).toHaveBeenCalledWith(
      "Stop showing the model your past dismissals? Your history is kept and Monday's pass will rebuild them.",
    );
    expect(resetMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(screen.getByTestId(ID.reset)).toBeTruthy();
  });

  it('OK calls the clear once, toasts the count, shows the done status and fetches nothing more', async () => {
    resetMock.mockResolvedValue({ ok: true, cleared: 7 });
    mount(MEASURED);
    await ready();
    fireEvent.click(screen.getByTestId(ID.reset));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('Cleared 7 past dismissals. They are rebuilt from your history on Monday.', 'success');
    await waitFor(() =>
      expect(screen.getByTestId(ID.status).textContent).toBe("Cleared. The model is shown no past dismissals until Monday's pass."),
    );
    expect(screen.queryByTestId(ID.reset)).toBeNull();
    // The readings cannot change before Monday, so there is no refetch.
    expect(trendMock).toHaveBeenCalledTimes(1);
  });

  it('cleared 0 says there was nothing to clear', async () => {
    resetMock.mockResolvedValue({ ok: true, cleared: 0 });
    mount(MEASURED);
    await ready();
    fireEvent.click(screen.getByTestId(ID.reset));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0][0]).toBe('Nothing to clear. No past dismissals are stored.');
    expect(toastMock.mock.calls[0][1]).not.toBe('error');
    expect(screen.queryByTestId(ID.reset)).toBeNull();
    expect(screen.getByTestId(ID.nothing).textContent).toBe('No past dismissals are stored, so there is nothing to clear.');
    expect(trendMock).toHaveBeenCalledTimes(1);
  });

  it('a failure toasts one fixed sentence (never the server text), says it beside the button, and leaves the button to try again', async () => {
    resetMock.mockRejectedValue(httpError('database is locked', 500));
    const onResetForbidden = vi.fn();
    mount(MEASURED, { onResetForbidden });
    await ready();
    fireEvent.click(screen.getByTestId(ID.reset));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
    expect(toastMock).not.toHaveBeenCalledWith('database is locked', expect.anything());
    expect(screen.getByTestId(`${ID.reset}-error`).textContent).toBe(COMMON.clearFailed);
    expect(onResetForbidden).not.toHaveBeenCalled();
    const btn = screen.getByTestId(ID.reset) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByTestId(ID.status).textContent).toContain('At the Oct 26 reading, 23 past dismissals were stored.');
  });

  it('a 403 tells the panel and toasts the fixed message', async () => {
    resetMock.mockRejectedValue(httpError('forbidden', 403));
    const onResetForbidden = vi.fn();
    mount(MEASURED, { onResetForbidden });
    await ready();
    fireEvent.click(screen.getByTestId(ID.reset));
    await waitFor(() => expect(onResetForbidden).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(COMMON.forbiddenToast, 'error');
  });

  it('is disabled while the request runs, so two quick clicks make one request', async () => {
    let finish!: (v: LearningResetResult) => void;
    resetMock.mockReturnValue(new Promise<LearningResetResult>((res) => (finish = res)));
    mount(MEASURED);
    await ready();
    const btn = screen.getByTestId(ID.reset) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn);
    expect(resetMock).toHaveBeenCalledTimes(1);
    finish({ ok: true, cleared: 3 });
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
  });

  it('every button in the card is type="button"', async () => {
    mount(MEASURED);
    await ready();
    const buttons = [...card().querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button');
  });
});

describe('DismissalTile: the rendered copy is clean', () => {
  it('has no banned wording or dashes for measured, not-measured, empty and stale cards', async () => {
    const cases: Array<[DismissalTrendRow[], Partial<LearningContext>]> = [
      [MEASURED, {}],
      [MEASURED, { now: new Date(2026, 10, 20, 12) }],
      [[row('2026-10-19', 8, 3), row('2026-10-26', 0, 0)], {}],
      [[], {}],
      [weeks([[10, 6], [10, 6], [10, 6], [10, 6], [10, 1], [10, 1], [10, 1], [10, 1]]), {}],
    ];
    for (const [trend, over] of cases) {
      const r = mount(trend, over);
      await ready();
      expect(copyProblems(card().textContent ?? '')).toEqual([]);
      r.unmount();
    }
  });

  it('has none while loading or after an error either', async () => {
    const r = mount(new Promise<DismissalTrendResponse>(() => {}));
    expect(copyProblems(card().textContent ?? '')).toEqual([]);
    r.unmount();
    mount(httpError('x', 500));
    await waitFor(() => expect(screen.getByTestId(ID.error)).toBeTruthy());
    expect(copyProblems(card().textContent ?? '')).toEqual([]);
  });
});
