import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import type {
  ClassificationAccuracyResponse,
  ClassificationAccuracyRun,
  ClassifiedField,
  LearningResetResult,
} from '../../lib/api.js';
import { COMMON, LEARNING_FACTS, copyProblems } from '../../lib/learning-copy.js';
import { MIN_N, compareRecent, formatRange, wilsonRange } from '../../lib/learning-stats.js';
import type { LearningContext, SeriesView, TileView } from './LearningCard.js';
import { ZERO_PERCENT, textWithoutChart } from './learning-test-helpers.js';

/**
 * ClassificationTile: the "Category and motivation guesses" card.
 *
 * The contracts under test:
 *   1. fraction first ('3 of 4'); a percent only at 10 or more SCORED cases, and then with
 *      the Wilson range from wilsonRange (never typed);
 *   2. accuracy null / held_out 0 is "not measured": a dashed tick, never 0% anywhere, and
 *      an older number is a note, never the headline;
 *   3. both fields always get a block, and are never combined, pooled or compared;
 *   4. the wire order is never trusted: any order gives the same card;
 *   5. a failed fetch is an error with Try again, never "No readings yet";
 *   6. the reset says what it does, confirms first, and handles 0, failure and 403.
 *
 * The pure builder cases do not touch the frame. The rendered cases drive the real
 * LearningCard through the contract test ids.
 */

const accuracyMock = vi.fn(async (_limit?: number): Promise<ClassificationAccuracyResponse> => NONE);
const resetMock = vi.fn(async (): Promise<LearningResetResult> => ({ ok: true, cleared: 0 }));
vi.mock('../../lib/api.js', () => ({
  api: {
    learning: {
      classificationAccuracy: (limit?: number) => accuracyMock(limit),
      resetClassification: () => resetMock(),
    },
  },
}));

const toastMock = vi.fn();
vi.mock('../../stores/index.js', () => ({
  showToast: (...a: unknown[]) => toastMock(...a),
}));

// The card must never compare weeks. A spy over the real function proves the tile does not
// even ask, instead of only checking what it prints.
vi.mock('../../lib/learning-stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/learning-stats.js')>();
  return { ...actual, compareRecent: vi.fn(actual.compareRecent) };
});

const { ClassificationTile, classificationView } = await import('./ClassificationTile.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Sunday 1 Nov 2026, local. The newest reading below is Monday 26 Oct: 6 days ago. */
const NOW = new Date(2026, 10, 1, 12, 0, 0);
const FIELDS: ClassifiedField[] = ['category', 'motivation'];

const ctx = (over: Partial<LearningContext> = {}): LearningContext => ({
  aiAvailable: null,
  smartMode: null,
  now: NOW,
  canReset: true,
  ...over,
});

/** One row as the server writes it. accuracy follows the counts unless the case overrides it. */
const row = (
  field: ClassifiedField,
  date: string,
  held_out: number,
  correct: number,
  accuracy?: number | null,
): ClassificationAccuracyRun => ({
  field,
  computed_date: date,
  held_out,
  correct,
  accuracy: accuracy === undefined ? (held_out > 0 ? correct / held_out : null) : accuracy,
});

/** ORDER BY computed_date DESC, field: what the endpoint really returns. */
const serverOrder = (runs: ClassificationAccuracyRun[]): ClassificationAccuracyRun[] =>
  [...runs].sort((a, b) =>
    a.computed_date === b.computed_date
      ? a.field.localeCompare(b.field)
      : a.computed_date < b.computed_date
        ? 1
        : -1,
  );

const res = (...runs: ClassificationAccuracyRun[]): ClassificationAccuracyResponse => ({
  fields: FIELDS,
  runs: serverOrder(runs),
});

const NONE: ClassificationAccuracyResponse = { fields: FIELDS, runs: [] };

const seriesOf = (v: TileView, key: string): SeriesView => {
  const s = v.series.find((x) => x.key === key);
  if (!s) throw new Error(`no series ${key}`);
  return s;
};

/** Every string a view would put on screen, so a sweep cannot miss a field. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}
const viewText = (v: TileView): string => strings(v).join('\n');

const NO_VERDICT =
  'No week-to-week verdict is given here. The test questions change between weeks, so a verdict would not mean what it says.';

// ── The pure builder ─────────────────────────────────────────────────────────

describe('classificationView: headline', () => {
  it('under 10 scored cases leads with the fraction and shows no percent anywhere', () => {
    const v = classificationView(res(row('category', '2026-10-26', 4, 3)), ctx());
    const s = seriesOf(v, 'category');
    expect(s.state).toBe('measured');
    expect(s.headline).toBe('Category: 3 of 4 held-back corrections answered the way you chose (reading of Oct 26).');
    expect(s.detail).toBe('Higher is better. Latest reading: Oct 26 (6 days ago).');
    // Not in the headline, the chart hover text, the table or anywhere else in the view.
    expect(viewText(v)).not.toContain('%');
    expect(s.chart?.points).toEqual([{ date: '2026-10-26', value: 0.75, n: 4, label: 'Oct 26: 3 of 4' }]);
    expect(s.readings?.rows[0].cells).toEqual(['Oct 26', '3', '4', `under ${MIN_N} cases`]);
  });

  it('at 10 or more it adds the percent and the range, and the range comes from wilsonRange', () => {
    const v = classificationView(res(row('motivation', '2026-10-26', 12, 9)), ctx());
    const range = formatRange(wilsonRange(9, 12)!);
    expect(range).toBe('46% to 92%');
    expect(seriesOf(v, 'motivation').headline).toBe(
      `Motivation: 75% (9 of 12) of held-back corrections answered the way you chose (reading of Oct 26). ` +
        `With this many cases the true figure could be anywhere from ${range}.`,
    );
    expect(seriesOf(v, 'motivation').readings?.rows[0].cells).toEqual(['Oct 26', '9', '12', '75%']);
  });

  it('switches from fraction-only to percent exactly at MIN_N', () => {
    const nine = seriesOf(classificationView(res(row('category', '2026-10-26', MIN_N - 1, 6)), ctx()), 'category');
    const ten = seriesOf(classificationView(res(row('category', '2026-10-26', MIN_N, 7)), ctx()), 'category');
    expect(nine.headline).not.toContain('%');
    expect(nine.headline).not.toContain('anywhere from');
    expect(ten.headline).toContain('70% (7 of 10)');
    expect(ten.headline).toContain(`anywhere from ${formatRange(wilsonRange(7, 10)!)}`);
  });

  it('a count of exactly one reads as a singular noun', () => {
    const s = seriesOf(classificationView(res(row('category', '2026-10-26', 1, 1)), ctx()), 'category');
    expect(s.headline).toBe('Category: 1 of 1 held-back correction answered the way you chose (reading of Oct 26).');
  });

  it('a real zero is printed as a zero, as a fraction under 10 and as 0% with its range at 10 or more', () => {
    const small = seriesOf(classificationView(res(row('category', '2026-10-26', 5, 0)), ctx()), 'category');
    expect(small.state).toBe('measured');
    expect(small.headline).toContain('0 of 5');
    expect(small.headline).not.toContain('%');
    expect(small.chart?.points[0].value).toBe(0);

    const big = seriesOf(classificationView(res(row('category', '2026-10-26', 12, 0)), ctx()), 'category');
    expect(big.headline).toContain('0% (0 of 12)');
    expect(big.headline).toContain(`anywhere from ${formatRange(wilsonRange(0, 12)!)}`);
  });

  it('the headline is always the newest reading, whatever order the rows arrive in', () => {
    const rows = [
      row('category', '2026-10-12', 4, 1),
      row('category', '2026-10-19', 5, 3),
      row('category', '2026-10-26', 6, 4),
      row('motivation', '2026-10-12', 4, 2),
      row('motivation', '2026-10-26', 8, 5),
    ];
    const newestFirst = classificationView({ fields: FIELDS, runs: serverOrder(rows) }, ctx());
    const oldestFirst = classificationView({ fields: FIELDS, runs: [...serverOrder(rows)].reverse() }, ctx());
    const shuffled = classificationView(
      { fields: FIELDS, runs: [2, 4, 0, 3, 1].map((i) => rows[i]) },
      ctx(),
    );
    expect(seriesOf(newestFirst, 'category').headline).toContain('4 of 6');
    expect(seriesOf(newestFirst, 'motivation').headline).toContain('5 of 8');
    // The whole card, not just the headline, is the same.
    expect(oldestFirst).toEqual(newestFirst);
    expect(shuffled).toEqual(newestFirst);
    // And the chart and the table are ascending and newest first respectively.
    expect(seriesOf(newestFirst, 'category').chart?.points.map((p) => p.date)).toEqual([
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
    expect(seriesOf(newestFirst, 'category').readings?.rows.map((r) => r.key)).toEqual([
      '2026-10-26',
      '2026-10-19',
      '2026-10-12',
    ]);
  });
});

describe('classificationView: nothing measured', () => {
  it('accuracy null with held_out 0 is not measured: a tick, no number, no 0% anywhere', () => {
    const v = classificationView(res(row('category', '2026-10-26', 0, 0, null)), ctx());
    const s = seriesOf(v, 'category');
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe(
      'Not measured on Oct 26. The weekly test could not score anything. ' +
        'That happens when your local model was off or did not answer, or when there were too few corrections to hold one back. ' +
        'The app does not record which.',
    );
    expect(s.detail).toBe('Latest reading: Oct 26 (6 days ago).');
    expect(s.notes).toEqual([]);
    expect(s.chart?.points).toEqual([{ date: '2026-10-26', value: null, n: 0, label: 'Oct 26: not measured' }]);
    expect(s.readings?.rows[0].cells).toEqual(['Oct 26', COMMON.notMeasured, COMMON.notMeasured, COMMON.notMeasured]);
    expect(viewText(v)).not.toMatch(ZERO_PERCENT);
    // Nothing is measured on this card, so the explanation starts open.
    expect(v.startOpen).toBe(true);
  });

  it('a newest week that is not measured shows Not measured plus the older number as a note, never as the headline', () => {
    const v = classificationView(
      res(row('category', '2026-10-19', 4, 3), row('category', '2026-10-26', 0, 0, null)),
      ctx(),
    );
    const s = seriesOf(v, 'category');
    expect(s.state).toBe('not-measured');
    expect(s.headline).toMatch(/^Not measured on Oct 26\./);
    expect(s.headline).not.toContain('3 of 4');
    expect(s.notes).toEqual(['Last measured: 3 of 4 held-back corrections answered the way you chose, on Oct 19.']);
    expect(s.chart?.points.map((p) => p.value)).toEqual([0.75, null]);
  });

  it('a real 0 of 4 and a null week stay distinct in either order', () => {
    const zeroThenNull = classificationView(
      res(row('category', '2026-10-19', 4, 0, 0), row('category', '2026-10-26', 0, 0, null)),
      ctx(),
    );
    const a = seriesOf(zeroThenNull, 'category');
    expect(a.chart?.points.map((p) => p.value)).toEqual([0, null]);
    // The real zero is a note with its counts; the null is the headline and is not a number.
    expect(a.notes).toEqual(['Last measured: 0 of 4 held-back corrections answered the way you chose, on Oct 19.']);
    expect(a.headline).toMatch(/^Not measured/);

    const nullThenZero = classificationView(
      res(row('category', '2026-10-19', 0, 0, null), row('category', '2026-10-26', 4, 0, 0)),
      ctx(),
    );
    const b = seriesOf(nullThenZero, 'category');
    expect(b.chart?.points.map((p) => p.value)).toEqual([null, 0]);
    expect(b.state).toBe('measured');
    expect(b.headline).toContain('0 of 4');
    expect(b.notes).toEqual([]);
  });

  it('a corrupt row (a rate with no cases, a rate above 1, more right than scored) is not measured', () => {
    for (const bad of [
      row('category', '2026-10-26', 0, 0, 0.9),
      row('category', '2026-10-26', 5, 2, 1.2),
      row('category', '2026-10-26', 5, 2, Number.NaN),
      row('category', '2026-10-26', 3, 5, 0.5),
    ]) {
      const v = classificationView(res(bad), ctx());
      const s = seriesOf(v, 'category');
      expect(s.state, JSON.stringify(bad)).toBe('not-measured');
      expect(s.chart?.points[0].value).toBeNull();
      expect(viewText(v)).not.toMatch(ZERO_PERCENT);
      expect(s.headline).not.toMatch(/\d+%/);
    }
  });
});

describe('classificationView: both fields', () => {
  it('both fields always get a block, even when only one has rows', () => {
    const v = classificationView(res(row('category', '2026-10-26', 4, 3)), ctx());
    expect(v.series.map((s) => s.key)).toEqual(['category', 'motivation']);
    expect(v.series.map((s) => s.label)).toEqual(['Category', 'Motivation (me, us, them)']);
    const m = seriesOf(v, 'motivation');
    expect(m.state).toBe('none');
    expect(m.headline).toBeNull();
    expect(m.empty).toBe(
      `Motivation: no reading yet. It needs at least ${LEARNING_FACTS.classification.correctionFloor} corrections of this kind, to guesses made in the last ${LEARNING_FACTS.classification.windowDays} days.`,
    );
    expect(m.empty).toBe('Motivation: no reading yet. It needs at least 2 corrections of this kind, to guesses made in the last 90 days.');
    expect(m.chart).toBeNull();
    expect(m.readings).toBeNull();
    // One field has a number, so the card is not "nothing measured".
    expect(v.startOpen).toBe(false);
    expect(v.resetAvailable).toBe(true);
  });

  it('keeps the two fields apart: one field never borrows the other\'s reading', () => {
    const v = classificationView(
      res(row('category', '2026-10-26', 4, 3), row('motivation', '2026-10-26', 12, 3)),
      ctx(),
    );
    expect(seriesOf(v, 'category').headline).toContain('3 of 4');
    expect(seriesOf(v, 'category').headline).not.toContain('12');
    expect(seriesOf(v, 'motivation').headline).toContain('25% (3 of 12)');
    // 7 of 16 combined would be 44%: that number must exist nowhere.
    expect(viewText(v)).not.toContain('7 of 16');
    expect(viewText(v)).not.toContain('44%');
  });

  it('no rows at all: the long explanation once, on the first block, and a short sentence on the other', () => {
    const v = classificationView(NONE, ctx());
    expect(v.series.every((s) => s.state === 'none')).toBe(true);
    expect(seriesOf(v, 'category').empty).toBe(
      'No readings yet. A reading appears after the weekly pass (early on Monday, server time) finds at least 2 of your corrections to guesses made in the last 90 days. ' +
        'Until then the model is shown no examples of your choices and nothing is measured.',
    );
    expect(seriesOf(v, 'motivation').empty).toBe(
      'Motivation: no reading yet. It needs at least 2 corrections of this kind, to guesses made in the last 90 days.',
    );
    for (const s of v.series) {
      expect(s.headline).toBeNull();
      expect(s.chart).toBeNull();
      expect(s.readings).toBeNull();
    }
    expect(v.resetAvailable).toBe(false);
    expect(v.startOpen).toBe(true);
    expect(v.status).toBeNull();
  });

  it('a field the response lists but that has no rows is a block too, and an unexpected field keeps its raw name', () => {
    const v = classificationView(
      {
        fields: FIELDS,
        runs: [row('category', '2026-10-26', 4, 3), row('tone' as unknown as ClassifiedField, '2026-10-26', 4, 1)],
      },
      ctx(),
    );
    expect(v.series.map((s) => s.key)).toEqual(['category', 'motivation', 'tone']);
    expect(seriesOf(v, 'tone').label).toBe('tone');
    expect(seriesOf(v, 'tone').headline).toBe('tone: 1 of 4 held-back corrections answered the way you chose (reading of Oct 26).');
  });
});

describe('classificationView: no verdict', () => {
  it('prints the fixed no-verdict sentence in every state, and never asks compareRecent for one', () => {
    const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
    // A huge, obvious swing with 15 scored cases each week: the case where a comparison
    // WOULD announce a change if this tile computed one.
    const swing = weeks.flatMap((d, i) => [
      row('category', d, 15, i < 4 ? 3 : 13),
      row('motivation', d, 15, i < 4 ? 13 : 3),
    ]);
    const states: Array<[string, ClassificationAccuracyResponse]> = [
      ['none', NONE],
      ['not-measured', res(row('category', '2026-10-26', 0, 0, null), row('motivation', '2026-10-26', 0, 0, null))],
      ['measured', res(row('category', '2026-10-26', 4, 3), row('motivation', '2026-10-26', 12, 9))],
      ['a clear swing', { fields: FIELDS, runs: serverOrder(swing) }],
    ];
    for (const [name, r] of states) {
      const v = classificationView(r, ctx());
      for (const s of v.series) {
        expect(s.comparison, `${name} / ${s.key}`).toBe(NO_VERDICT);
      }
      const text = viewText(v);
      expect(text, name).not.toMatch(/no clear change|by more than chance|ranges overlap/i);
    }
    expect(compareRecent).not.toHaveBeenCalled();
  });

  it('keeps the chart honest: weekly cadence, no marker, the shared caption', () => {
    const v = classificationView(res(row('category', '2026-10-26', 4, 3)), ctx());
    const chart = seriesOf(v, 'category').chart!;
    expect(chart.cadenceDays).toBe(7);
    expect(chart.marker).toBeNull();
    expect(chart.caption).toBe(COMMON.chartCaption);
    expect(chart.caption).toContain(String(MIN_N));
  });

  it('uses the column names Right, Scored and Share, and never "Held back" or a one-in-three chance line', () => {
    const v = classificationView(res(row('category', '2026-10-26', 4, 3)), ctx());
    expect(seriesOf(v, 'category').readings?.columns).toEqual(['Date', 'Right', 'Scored', 'Share']);
    expect(viewText(v)).not.toMatch(/held back/i);
    expect(viewText(v)).not.toMatch(/one time in 3|1 in 3|one in three/i);
  });
});

describe('classificationView: a field whose reading has stopped', () => {
  // A field under the 2-correction floor writes NO row and has its examples removed
  // (calibrateClassification), while a field at or over it writes a row every Monday, null or not.
  // So a field that stops, while the other keeps getting rows, has dropped below the floor.
  const stopped = res(
    row('motivation', '2026-10-26', 5, 2),
    row('motivation', '2026-10-19', 5, 2),
    row('category', '2026-09-28', 4, 3),
  );

  it('names the cause when the other field has a newer reading, which proves the pass ran', () => {
    const cat = seriesOf(classificationView(stopped, ctx()), 'category');
    expect(cat.notes[0]).toBe('No reading since Sep 28.' + ' The weekly pass has run since, and this field had fewer than 2 corrections to guesses made in the last 90 days, so its examples were removed.');
    expect(cat.notes.join(' ')).not.toContain('Either');
  });

  it('calls the old number the last reading, never this week\'s', () => {
    const cat = seriesOf(classificationView(stopped, ctx()), 'category');
    expect(cat.headline).toBe('Category: 3 of 4 held-back corrections answered the way you chose (last reading, Sep 28).');
    expect(cat.headline).not.toContain('reading of');
    // The field that is still current keeps the normal wording and no note.
    const mot = seriesOf(classificationView(stopped, ctx()), 'motivation');
    expect(mot.headline).toContain('(reading of Oct 26)');
    expect(mot.notes).toEqual([]);
  });

  it('does not guess a cause when no field has a newer reading: the pass may simply not have run', () => {
    const v = classificationView(res(row('category', '2026-08-31', 4, 3), row('motivation', '2026-08-31', 5, 2)), ctx());
    for (const key of ['category', 'motivation']) {
      expect(seriesOf(v, key).notes[0]).toBe(
        'No reading since Aug 31. Either the weekly pass has not run, or this field has fewer than 2 corrections to guesses made in the last 90 days and its examples were removed.',
      );
    }
  });

  it('says nothing for a fresh reading, and flips at 10 days old, not 9', () => {
    const r = res(row('category', '2026-10-26', 4, 3));
    expect(seriesOf(classificationView(r, ctx({ now: new Date(2026, 10, 4, 12) })), 'category').notes).toEqual([]); // 9 days
    expect(seriesOf(classificationView(r, ctx({ now: new Date(2026, 10, 5, 12) })), 'category').notes[0]).toContain('No reading since Oct 26.');
  });

  it('a stale not-measured field keeps its Not measured headline, with the cause note ahead of the last-measured note', () => {
    const v = classificationView(
      res(row('category', '2026-09-21', 4, 3), row('category', '2026-09-28', 0, 0, null), row('motivation', '2026-10-26', 5, 2)),
      ctx(),
    );
    const cat = seriesOf(v, 'category');
    expect(cat.state).toBe('not-measured');
    expect(cat.notes[0]).toContain('No reading since Sep 28.');
    expect(cat.notes[1]).toBe('Last measured: 3 of 4 held-back corrections answered the way you chose, on Sep 21.');
  });

  it('the stale wording passes the copy sweep and states no percent', () => {
    const v = classificationView(stopped, ctx());
    expect(copyProblems(viewText(v))).toEqual([]);
    expect(seriesOf(v, 'category').notes.join(' ')).not.toMatch(/\d+%/);
  });
});

describe('classificationView: a clear made this session overrides what the readings imply', () => {
  const rows = res(row('category', '2026-10-26', 4, 3), row('motivation', '2026-10-26', 5, 2));

  it('says it was cleared, dated, and offers nothing more to clear', () => {
    const v = classificationView(rows, ctx({ clearedOn: { classification: '2026-10-28' } }));
    expect(v.status).toBe("Cleared on Oct 28. The model is shown no examples until Monday's pass.");
    expect(v.resetAvailable).toBe(false);
  });

  it('a clear on the same day as the newest reading counts as after it', () => {
    const v = classificationView(rows, ctx({ clearedOn: { classification: '2026-10-26' } }));
    expect(v.status).toMatch(/^Cleared on Oct 26\./);
    expect(v.resetAvailable).toBe(false);
  });

  it('a clear older than the newest reading is ignored', () => {
    const v = classificationView(rows, ctx({ clearedOn: { classification: '2026-10-20' } }));
    expect(v.status).toBeNull();
    expect(v.resetAvailable).toBe(true);
  });

  it('with no readings there is nothing to say about a clear', () => {
    const v = classificationView(NONE, ctx({ clearedOn: { classification: '2026-10-28' } }));
    expect(v.status).toBeNull();
    expect(v.resetAvailable).toBe(false);
  });

  it('only the classification loop reads it, and the readings stay as they were', () => {
    expect(classificationView(rows, ctx({ clearedOn: { dismissal: '2026-10-28' } })).resetAvailable).toBe(true);
    expect(classificationView(rows, ctx({ clearedOn: { classification: '2026-10-28' } })).series).toEqual(
      classificationView(rows, ctx()).series,
    );
  });
});

describe('classificationView: context, status and reset flag', () => {
  it('the model-off line appears only when aiAvailable is exactly false', () => {
    const r = res(row('category', '2026-10-26', 4, 3));
    expect(classificationView(r, ctx({ aiAvailable: false })).contextLines).toEqual([
      "Your local model is not ready right now. New guesses are not being made and Monday's test cannot be scored.",
    ]);
    expect(classificationView(r, ctx({ aiAvailable: null })).contextLines).toEqual([]);
    expect(classificationView(r, ctx({ aiAvailable: true })).contextLines).toEqual([]);
  });

  it('has no card-level stale line and no status line; an old field reading is explained on that field instead', () => {
    const v = classificationView(res(row('category', '2026-08-31', 4, 3)), ctx());
    expect(v.contextLines).toEqual([]);
    expect(v.status).toBeNull();
    expect(viewText(v)).not.toMatch(/No new reading/);
    expect(seriesOf(v, 'category').detail).toBe('Higher is better. Latest reading: Aug 31 (62 days ago).');
  });

  it('resetAvailable is true when any reading exists, even a not-measured one, and false with none', () => {
    expect(classificationView(NONE, ctx()).resetAvailable).toBe(false);
    expect(classificationView(res(row('motivation', '2026-10-26', 0, 0, null)), ctx()).resetAvailable).toBe(true);
    expect(classificationView(res(row('category', '2026-10-26', 4, 3)), ctx()).resetAvailable).toBe(true);
    // A row whose date cannot be read is not a reading anyone can see, so it offers no reset.
    expect(classificationView(res(row('category', 'not-a-date', 4, 3)), ctx()).resetAvailable).toBe(false);
  });

  it('every sentence the builder produces passes the copy sweep', () => {
    const cases = [
      NONE,
      res(row('category', '2026-10-26', 4, 3)),
      res(row('category', '2026-10-26', 12, 9), row('motivation', '2026-10-26', 0, 0, null)),
      res(row('category', '2026-10-19', 5, 0, 0), row('category', '2026-10-26', 0, 0, null)),
    ];
    for (const r of cases) {
      for (const ai of [false, null, true]) {
        expect(copyProblems(viewText(classificationView(r, ctx({ aiAvailable: ai }))))).toEqual([]);
      }
    }
  });
});

// ── The rendered tile ────────────────────────────────────────────────────────

const CARD = 'learning-card-classification';
const cardText = (): string => screen.getByTestId(CARD).textContent ?? '';
/** The card without its chart, whose fixed axis legitimately prints 0%. */
const noChartText = (): string => textWithoutChart(screen.getByTestId(CARD));
const apiError = (status: number, message = 'server said no') => Object.assign(new Error(message), { status });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function mount(over: Partial<LearningContext> = {}) {
  const c = ctx(over);
  return render(() => <ClassificationTile context={c} />);
}

const MEASURED = res(row('category', '2026-10-26', 4, 3), row('motivation', '2026-10-26', 12, 9));
const NOT_MEASURED = res(row('category', '2026-10-26', 0, 0, null), row('motivation', '2026-10-26', 0, 0, null));

let confirmSpy: MockInstance<(message?: string) => boolean>;

beforeEach(() => {
  accuracyMock.mockReset().mockResolvedValue(NONE);
  resetMock.mockReset().mockResolvedValue({ ok: true, cleared: 0 });
  toastMock.mockReset();
  vi.mocked(compareRecent).mockClear();
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe('ClassificationTile: loading, ready and empty', () => {
  it('asks for 24 rows (both fields, about twelve weeks), once, and reads nothing else', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await waitFor(() => expect(screen.getByTestId('learning-headline-classification-category')).toBeTruthy());
    expect(accuracyMock).toHaveBeenCalledTimes(1);
    expect(accuracyMock).toHaveBeenCalledWith(24);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('shows Loading while the request is open, with the caveat already visible, then the readings', async () => {
    const d = deferred<ClassificationAccuracyResponse>();
    accuracyMock.mockReturnValue(d.promise);
    mount();
    expect(cardText()).toContain(COMMON.loading);
    expect(screen.getByTestId('learning-primary-caveat-classification')).toBeTruthy();
    expect(cardText()).not.toContain('No readings yet');
    expect(screen.queryByTestId('learning-headline-classification-category')).toBeNull();

    d.resolve(MEASURED);
    await waitFor(() => expect(screen.getByTestId('learning-headline-classification-category')).toBeTruthy());
    expect(cardText()).not.toContain(COMMON.loading);
  });

  it('renders both fields: counts first for 4 scored, percent and range for 12 scored', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    const cat = await screen.findByTestId('learning-headline-classification-category');
    const mot = screen.getByTestId('learning-headline-classification-motivation');
    expect(cat.textContent).toBe('Category: 3 of 4 held-back corrections answered the way you chose (reading of Oct 26).');
    expect(cat.getAttribute('data-state')).toBe('measured');
    expect(mot.textContent).toContain('Motivation: 75% (9 of 12)');
    expect(mot.textContent).toContain(`could be anywhere from ${formatRange(wilsonRange(9, 12)!)}`);
    expect(screen.getByTestId('learning-detail-classification-category').textContent).toBe(
      'Higher is better. Latest reading: Oct 26 (6 days ago).',
    );
    // The share column is a percent only at 10 or more scored.
    expect(screen.getByTestId('learning-readings-classification-category').textContent).toContain('under 10 cases');
    expect(screen.getByTestId('learning-readings-classification-motivation').textContent).toContain('75%');
    // The column counts answers actually scored, which can be fewer than corrections held back.
    expect(screen.getByTestId('learning-readings-classification-category').textContent).toContain('Scored');
    expect(screen.getByTestId('learning-readings-classification-category').textContent).not.toMatch(/held back/i);
    expect(cardText()).not.toMatch(/one time in 3/i);
  });

  it('shows the no-verdict sentence on each field and nothing that compares weeks', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-headline-classification-category');
    expect(screen.getByTestId('learning-comparison-classification-category').textContent).toBe(NO_VERDICT);
    expect(screen.getByTestId('learning-comparison-classification-motivation').textContent).toBe(NO_VERDICT);
    expect(compareRecent).not.toHaveBeenCalled();
  });

  it('one field with a reading and one without: the empty field says so in its own block', async () => {
    accuracyMock.mockResolvedValue(res(row('category', '2026-10-26', 4, 3)));
    mount();
    await screen.findByTestId('learning-headline-classification-category');
    expect(screen.getByTestId('learning-empty-classification-motivation').textContent).toBe(
      'Motivation: no reading yet. It needs at least 2 corrections of this kind, to guesses made in the last 90 days.',
    );
    expect(screen.queryByTestId('learning-headline-classification-motivation')).toBeNull();
    expect(screen.queryByTestId('learning-chart-classification-motivation')).toBeNull();
    expect(screen.queryByTestId('learning-readings-classification-motivation')).toBeNull();
    // The category block is unaffected by its sibling being empty.
    expect(screen.getByTestId('learning-chart-classification-category')).toBeTruthy();
  });

  it('no rows at all: the empty sentence, no chart, no table, the explanation open', async () => {
    accuracyMock.mockResolvedValue(NONE);
    mount();
    const empty = await screen.findByTestId('learning-empty-classification-category');
    expect(empty.textContent).toMatch(/^No readings yet\. A reading appears after the weekly pass \(early on Monday, server time\)/);
    expect(empty.textContent).toContain('the model is shown no examples of your choices');
    expect(screen.queryByTestId('learning-chart-classification-category')).toBeNull();
    expect(screen.queryByTestId('learning-readings-classification-category')).toBeNull();
    expect((screen.getByTestId('learning-more-classification') as HTMLDetailsElement).open).toBe(true);
    expect(noChartText()).not.toMatch(ZERO_PERCENT);
  });

  it('a reading that measured nothing: Not measured, a chart, no 0% anywhere, the explanation open', async () => {
    accuracyMock.mockResolvedValue(NOT_MEASURED);
    mount();
    const cat = await screen.findByTestId('learning-headline-classification-category');
    expect(cat.getAttribute('data-state')).toBe('not-measured');
    expect(cat.textContent).toMatch(/^Not measured on Oct 26\. The weekly test could not score anything\./);
    expect(cat.textContent).toContain('The app does not record which.');
    expect(screen.getByTestId('learning-chart-classification-category')).toBeTruthy();
    expect(screen.getByTestId('learning-readings-classification-category').textContent).toContain(COMMON.notMeasured);
    expect(noChartText()).not.toMatch(ZERO_PERCENT);
    expect((screen.getByTestId('learning-more-classification') as HTMLDetailsElement).open).toBe(true);
  });

  it('the explanation is closed once something is measured', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-headline-classification-category');
    expect((screen.getByTestId('learning-more-classification') as HTMLDetailsElement).open).toBe(false);
  });

  it('a newest week that measured nothing never shows the older number as current', async () => {
    accuracyMock.mockResolvedValue(
      res(row('category', '2026-10-19', 4, 3), row('category', '2026-10-26', 0, 0, null)),
    );
    mount();
    const cat = await screen.findByTestId('learning-headline-classification-category');
    expect(cat.getAttribute('data-state')).toBe('not-measured');
    expect(cat.textContent).not.toContain('3 of 4');
    expect(cardText()).toContain('Last measured: 3 of 4 held-back corrections answered the way you chose, on Oct 19.');
  });

  it('shows the newest reading whichever order the server sends the rows in', async () => {
    const rows = [row('category', '2026-10-12', 4, 1), row('category', '2026-10-26', 6, 4), row('category', '2026-10-19', 5, 3)];
    accuracyMock.mockResolvedValue({ fields: FIELDS, runs: rows });
    mount();
    const cat = await screen.findByTestId('learning-headline-classification-category');
    expect(cat.textContent).toContain('4 of 6');
    expect(cat.textContent).toContain('reading of Oct 26');
  });
});

describe('ClassificationTile: a perfect score is a score, not "not measured"', () => {
  const chartTitles = (field: string) =>
    [...screen.getByTestId(`learning-chart-classification-${field}`).querySelectorAll('circle title')].map((t) => t.textContent);

  it('12 of 12: 100% with its range, a table row of counts and 100%, and a hover label that is a score', async () => {
    accuracyMock.mockResolvedValue(res(row('category', '2026-10-26', 12, 12), row('motivation', '2026-10-26', 4, 4)));
    mount();
    const cat = await screen.findByTestId('learning-headline-classification-category');
    expect(cat.getAttribute('data-state')).toBe('measured');
    expect(cat.textContent).toContain('Category: 100% (12 of 12)');
    expect(cat.textContent).toContain(`could be anywhere from ${formatRange(wilsonRange(12, 12)!)}`);

    const rows = [...screen.getByTestId('learning-readings-classification-category').querySelectorAll('tbody tr')];
    expect(rows.map((tr) => [...tr.children].map((c) => c.textContent))).toEqual([['Oct 26', '12', '12', '100%']]);
    expect(chartTitles('category')).toEqual([`Oct 26: 12 of 12 (100%, could be ${formatRange(wilsonRange(12, 12)!)})`]);
    expect(chartTitles('category')).not.toContain('Oct 26: not measured');
    // The chart plots it, at the top of the scale, as a dot and not as a tick.
    expect(screen.getByTestId('learning-chart-classification-category').querySelectorAll('[data-tick]')).toHaveLength(0);
  });

  it('4 of 4: the counts, "under 10 cases" in the table, and a hover label with no percent', async () => {
    accuracyMock.mockResolvedValue(res(row('category', '2026-10-26', 4, 4), row('motivation', '2026-10-26', 4, 4)));
    mount();
    const cat = await screen.findByTestId('learning-headline-classification-category');
    expect(cat.getAttribute('data-state')).toBe('measured');
    expect(cat.textContent).toBe('Category: 4 of 4 held-back corrections answered the way you chose (reading of Oct 26).');
    const rows = [...screen.getByTestId('learning-readings-classification-category').querySelectorAll('tbody tr')];
    expect(rows.map((tr) => [...tr.children].map((c) => c.textContent))).toEqual([['Oct 26', '4', '4', 'under 10 cases']]);
    expect(chartTitles('category')).toEqual(['Oct 26: 4 of 4']);
  });
});

describe('ClassificationTile: what the card says about itself', () => {
  const F = LEARNING_FACTS.classification;
  const open = async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-headline-classification-category');
    return {
      about: screen.getByTestId('learning-about-classification').textContent ?? '',
      more: screen.getByTestId('learning-more-classification'),
    };
  };
  const MEMORY_FILL_IN = 'It runs only when Companion Memory is connected and finds something related to the task.';

  it('what it counts: the window, the stride, the cap and the typical count', async () => {
    const { about } = await open();
    expect(about).toContain('it builds a set of examples from your corrections to guesses made in the last 90 days, holds back every 4th correction');
    expect(about).toContain('asks the model about up to 20 of the held-back ones per field');
    expect(about).toContain('often 1 to 5 early on');
    expect(about).toContain('Direction: higher is better.');
    // The same figures as the facts the server test checks.
    expect(about).toContain(`last ${F.windowDays} days`);
    expect(about).toContain(`up to ${F.maxScored} of the held-back`);
  });

  it('what it changes: the three places the examples reach a prompt, each with what it needs', async () => {
    const { about } = await open();
    expect(about).toContain('your past corrections reach the model in three places.');
    // 1. The Describe-it line: most frequent, last in the prompt, no Companion Memory, needs a category the model names (list or one word).
    expect(about).toContain(
      'The Describe-it line in the Add dialog (and quick add through the API) shows up to 3 of the corrections you make most often, ' +
        'for each field, at the end of its prompt, whatever you typed.',
    );
    expect(about).toContain('This needs no Companion Memory, and it is sent only when the model answering is one that was tested with it ');
    expect(about).toContain('(gemma3n:e4b, qwen2.5:3b and gemma3:4b; the others tried answered worse), so on any other model the prompt is the usual one.');
    expect(about).toContain('The category part needs the model to name one of your categories, as a list or as one word;');
    expect(about).toContain('an answer that names none of them gives nothing to learn from.');
    // 2. The memory fill-in: look-alikes (or the most frequent with no embedder), and only with memory.
    expect(about).toContain('the "Fill in details from memory" button and the nightly fill-in');
    expect(about).toContain('shows up to 3 corrections that look like the task, or your most frequent ones with no embedding model.');
    expect(about).toContain(MEMORY_FILL_IN);
    // 3. Monday's test.
    expect(about).toContain("The third is Monday's test, described above.");
    // The batch lag, the floor, and what is not learned from.
    expect(about).toContain('Nothing changes before the next Monday run, and a field starts after 2 corrections it can learn from;');
    expect(about).toContain('a category you clear is kept but not learned from.');
    expect(about).toContain('The model never overwrites a value you already filled in.');
    // The figures come from the facts the server test checks.
    expect(about).toContain(`up to ${F.retrieveK} of the corrections`);
    expect(about).toContain(`after ${F.correctionFloor} corrections it can learn from`);
  });

  it('how it starts: what counts as a correction, the floor, the stride, the Monday lag, and which part needs Companion Memory', async () => {
    const { more } = await open();
    const steps = more.textContent ?? '';
    expect(steps).toContain('Change a category the Describe-it line picked (before you press Add, or later on the task),');
    expect(steps).toContain('or a category or me/us/them label the app filled in from memory.');
    expect(steps).toContain('the Add dialog does not record who a task is for.');
    expect(steps).toContain('2 corrections of one kind, to guesses made in the last 90 days, start the examples.');
    expect(steps).toContain('With 4, the weekly test can hold one back and score it.');
    expect(steps).toContain("Nothing reaches a prompt until Monday's run has built the examples.");
    expect(steps).toContain('The Describe-it line needs no Companion Memory. The fill-in from memory does,');
    expect(steps).toContain('Companion Memory is connected under Settings → Connections.');
    expect(steps).toContain('There is no switch to start it earlier and no setting that turns it off.');
  });

  it('the caveats under "More about this number": all seven, with the small-number example built from the maths', async () => {
    const { more } = await open();
    const items = [...more.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(7);
    expect(items[0]).toContain('A call that failed or returned nothing is skipped, not counted as wrong');
    // The score is of a narrow question with similarity-picked examples, not of any screen's prompt.
    expect(items[1]).toContain('one narrow question for each held-back correction, the category or me/us/them, in the same words every time');
    expect(items[1]).toContain('with examples picked by how closely they match the task (your most frequent ones with no embedding model)');
    expect(items[1]).toContain('The Describe-it line asks a longer question with your most frequent corrections at the end');
    expect(items[1]).toContain('So this number is not a score of either, and it is not a recording of what the app did on your tasks.');
    expect(items[2]).toContain('Answers it already gets right are not tested');
    expect(items[3]).toContain('Each week\'s test is every 4th correction to a guess made in the last 90 days');
    expect(items[3]).toContain('they are never added together or compared');
    expect(items[4]).toContain('At most 20 corrections are scored per field per week, and early on it is 1 to 5.');
    expect(items[4]).toContain(`3 right out of 4 looks like 75%, but the true figure could be anywhere from about ${formatRange(wilsonRange(3, 4)!)}`);
    expect(items[4]).toContain(`a percent appears only at ${MIN_N} or more cases`);
    expect(items[5]).toContain('It says nothing about tasks unlike them.');
    expect(items[6]).toContain('is not a bad week');
  });
});

describe('ClassificationTile: the model-off line', () => {
  it.each([
    [false, true],
    [null, false],
    [true, false],
  ])('aiAvailable %s shows the line: %s', async (ai, shown) => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount({ aiAvailable: ai });
    await screen.findByTestId('learning-headline-classification-category');
    const line = screen.queryByTestId('learning-context-classification');
    if (shown) {
      expect(line?.textContent).toBe(
        "Your local model is not ready right now. New guesses are not being made and Monday's test cannot be scored.",
      );
    } else {
      expect(line).toBeNull();
      expect(cardText()).not.toContain('not ready');
    }
  });
});

describe('ClassificationTile: a failed fetch is an error, never an empty card', () => {
  it.each([
    [500, 'Could not load these readings. Try again in a moment.'],
    [0, 'Could not reach the server. Check your connection and try again.'],
    [404, 'This server does not report this yet. Update the server to see it.'],
  ])('status %i shows its own wording, a Try again button, and no empty-state text', async (status, message) => {
    accuracyMock.mockRejectedValue(apiError(status));
    mount();
    const err = await screen.findByTestId('learning-error-classification');
    expect(err.textContent).toContain(message);
    expect(screen.getByTestId('learning-retry-classification').textContent).toBe('Try again');
    expect(cardText()).not.toContain('No readings yet');
    expect(cardText()).not.toMatch(/no reading yet/i);
    expect(cardText()).not.toContain('server said no'); // the raw server text is not shown
    expect(screen.queryByTestId('learning-headline-classification-category')).toBeNull();
    expect(screen.queryByTestId('learning-empty-classification-category')).toBeNull();
    // The caveat does not depend on data, so it is still there.
    expect(screen.getByTestId('learning-primary-caveat-classification')).toBeTruthy();
    // And no reset is offered on a card that has nothing to reset.
    expect(screen.queryByTestId('learning-reset-classification')).toBeNull();
  });

  it('Try again re-asks only this loader, once, and then shows the readings', async () => {
    accuracyMock.mockRejectedValueOnce(apiError(500)).mockResolvedValue(MEASURED);
    mount();
    const retry = await screen.findByTestId('learning-retry-classification');
    expect(accuracyMock).toHaveBeenCalledTimes(1);
    retry.click();
    await waitFor(() => expect(screen.getByTestId('learning-headline-classification-category')).toBeTruthy());
    expect(accuracyMock).toHaveBeenCalledTimes(2);
    expect(accuracyMock).toHaveBeenLastCalledWith(24);
    expect(resetMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('learning-error-classification')).toBeNull();
  });
});

describe('ClassificationTile: wording the card must carry', () => {
  it('the always-visible caveat says what the number does not prove, before any data and after it', async () => {
    const d = deferred<ClassificationAccuracyResponse>();
    accuracyMock.mockReturnValue(d.promise);
    mount();
    const caveat = screen.getByTestId('learning-primary-caveat-classification');
    expect(caveat.textContent).toContain("first guess was not what you chose");
    expect(caveat.textContent).toContain('cannot show that the examples helped');
    expect(caveat.textContent).toContain('does not show the model is right in general');
    expect(caveat.textContent).toContain('not a score of the Describe-it line');
    // Deliberately not "the stock model": once an index exists the first guess was made WITH examples.
    expect(caveat.textContent).not.toMatch(/stock model/i);
    d.resolve(MEASURED);
    await screen.findByTestId('learning-headline-classification-category');
    expect(screen.getByTestId('learning-primary-caveat-classification').textContent).toBe(caveat.textContent);
  });

  it('says where the examples are used: the Describe-it line, the memory fill-in and the Monday test', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-headline-classification-category');
    const text = cardText();
    expect(text).toContain('Fill in details from memory');
    expect(text).toContain('your past corrections reach the model in three places.');
    expect(text).toContain('The Describe-it line in the Add dialog');
    expect(text).toContain('The third is Monday\'s test, described above.');
    expect(text).toContain('Direction: higher is better.');
    expect(text).toContain('a field starts after 2 corrections it can learn from');
    // The remaining caveats and the start steps are inside the details block.
    const more = screen.getByTestId('learning-more-classification').textContent ?? '';
    expect(more).toContain('A call that failed or returned nothing is skipped, not counted as wrong');
    expect(more).toContain('Readings from different weeks are not independent, so they are never added together or compared.');
    expect(more).toContain('3 right out of 4 looks like 75%, but the true figure could be anywhere from about');
    expect(more).toContain(formatRange(wilsonRange(3, 4)!));
    expect(more).toContain('2 corrections of one kind, to guesses made in the last 90 days, start the examples.');
    expect(more).toContain('There is no switch to start it earlier and no setting that turns it off.');
  });

  // The card was first written when the examples reached a prompt in exactly one place (the
  // memory fill-in). They now reach three, so each of these claims is false and must not come
  // back, in any state the card can be in. The positive half pins the replacements, so deleting
  // the sentences cannot satisfy the first half by itself.
  it('never says the examples reach one place, or that without Companion Memory they are never shown', async () => {
    const STALE: ReadonlyArray<[RegExp, string]> = [
      [/exactly one place/i, 'exactly one place'],
      [/only one place/i, 'only one place'],
      [/never shown to the model/i, 'never shown to the model'],
      [/built and scored every Monday but/i, 'built and scored ... but never shown'],
      [/shown only when the app fills in details/i, 'shown only when the app fills in details'],
      [/not shown examples/i, 'not shown examples'],
      [/while you add a task by typing/i, 'typed guesses are not given examples'],
      // True until 2026-11-02, when quick add began reading a one-word category answer as one category.
      [/only works when the model answers categories as a list/i, 'categories only work from a list answer'],
      [/answers with one word picks no category/i, 'a one-word answer picks no category'],
    ];
    for (const r of [NONE, MEASURED, NOT_MEASURED]) {
      accuracyMock.mockResolvedValue(r);
      const { unmount } = mount({ aiAvailable: false });
      await waitFor(() => expect(screen.getByTestId('learning-more-classification')).toBeTruthy());
      const text = cardText();
      expect(STALE.filter(([re]) => re.test(text)).map(([, what]) => what)).toEqual([]);
      // Present in every state, because the explanation does not depend on the readings.
      expect(text).toContain('your past corrections reach the model in three places.');
      expect(text).toContain('The Describe-it line needs no Companion Memory.');
      expect(text).toContain('needs the model to name one of your categories, as a list or as one word');
      expect(text).toContain('not a score of the Describe-it line');
      unmount();
    }
  });

  it('nothing the card renders overclaims or uses a dash', async () => {
    for (const r of [NONE, MEASURED, NOT_MEASURED]) {
      accuracyMock.mockResolvedValue(r);
      const { unmount } = mount({ aiAvailable: false });
      await waitFor(() => expect(screen.getByTestId('learning-more-classification')).toBeTruthy());
      expect(copyProblems(cardText())).toEqual([]);
      unmount();
    }
  });

  it('every button on the card is type="button"', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    const buttons = screen.getByTestId(CARD).querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button');
  });
});

describe('ClassificationTile: clearing the learned examples', () => {
  const resetBtn = () => screen.getByTestId('learning-reset-classification') as HTMLButtonElement;

  it('is hidden while there are no readings, and says there is nothing to clear', async () => {
    accuracyMock.mockResolvedValue(NONE);
    mount();
    await screen.findByTestId('learning-empty-classification-category');
    expect(screen.queryByTestId('learning-reset-classification')).toBeNull();
    expect(screen.getByTestId('learning-nothing-to-clear-classification').textContent).toBe(
      'No learned examples are stored, so there is nothing to clear.',
    );
  });

  it('is offered once a reading exists, with a label and a hint that say what it does, visible without any click', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-headline-classification-category');
    expect(resetBtn().textContent).toBe('Clear learned examples');
    expect(resetBtn().textContent).not.toMatch(/reset learning/i);
    expect(resetBtn().disabled).toBe(false);
    const hint = screen.getByTestId('learning-reset-hint-classification').textContent ?? '';
    expect(hint).toBe(
      'Removes the examples shown to the model, for category and motivation. ' +
        "Your corrections are kept, so Monday's pass builds the examples again from them. " +
        'Past readings stay, and they describe the old examples. ' +
        'There is no setting that turns this learning off.',
    );
    expect(hint).toContain('corrections are kept');
    expect(hint).toContain('Monday');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('is offered even when the only reading is a not-measured one', async () => {
    accuracyMock.mockResolvedValue(NOT_MEASURED);
    mount();
    await screen.findByTestId('learning-headline-classification-category');
    expect(resetBtn()).toBeTruthy();
  });

  it('asks first, and Cancel makes no request', async () => {
    confirmSpy.mockReturnValue(false);
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    resetBtn().click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(
      'Clear the learned examples for category and motivation guesses? Your corrections are kept and will be used again on Monday.',
    );
    await Promise.resolve();
    expect(resetMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(resetBtn()).toBeTruthy();
  });

  it('OK sends one DELETE, toasts the count, swaps the status line, drops the button, and does not refetch', async () => {
    resetMock.mockResolvedValue({ ok: true, cleared: 7 });
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    resetBtn().click();
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        'Cleared 7 learned examples. They are rebuilt from your corrections on Monday.',
        'success',
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('learning-status-classification').textContent).toBe(
        "Cleared. The model is shown no examples until Monday's pass.",
      ),
    );
    expect(screen.queryByTestId('learning-reset-classification')).toBeNull();
    // The readings cannot change before Monday, so nothing is asked of the server again.
    expect(accuracyMock).toHaveBeenCalledTimes(1);
    expect(resetMock).toHaveBeenCalledTimes(1);
    // Past readings stay on screen.
    expect(screen.getByTestId('learning-headline-classification-category').textContent).toContain('3 of 4');
  });

  it('one cleared example reads as a singular', async () => {
    resetMock.mockResolvedValue({ ok: true, cleared: 1 });
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    resetBtn().click();
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        'Cleared 1 learned example. It is rebuilt from your corrections on Monday.',
        'success',
      ),
    );
  });

  it('cleared 0 says there was nothing to clear, and does not claim a clear happened', async () => {
    resetMock.mockResolvedValue({ ok: true, cleared: 0 });
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    resetBtn().click();
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('Nothing to clear. No learned examples are stored.', 'default'),
    );
    expect(toastMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('learning-reset-classification')).toBeNull());
    expect(screen.getByTestId('learning-nothing-to-clear-classification').textContent).toBe(
      'No learned examples are stored, so there is nothing to clear.',
    );
    expect(screen.queryByTestId('learning-status-classification')?.textContent ?? '').not.toContain('Cleared.');
    expect(accuracyMock).toHaveBeenCalledTimes(1);
  });

  it('a failure toasts one fixed sentence (never the server text), says it beside the button, and leaves the button to try again', async () => {
    resetMock.mockRejectedValue(apiError(500, 'database is locked'));
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    resetBtn().click();
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalledWith('database is locked', expect.anything());
    expect(screen.getByTestId('learning-reset-classification-error').textContent).toBe(COMMON.clearFailed);
    await waitFor(() => expect(resetBtn().disabled).toBe(false));
    expect(screen.queryByTestId('learning-status-classification')?.textContent ?? '').not.toContain('Cleared.');
  });

  it('a 403 tells the panel, toasts the fixed message, and never echoes the server body', async () => {
    resetMock.mockRejectedValue(apiError(403, 'forbidden'));
    accuracyMock.mockResolvedValue(MEASURED);
    const onResetForbidden = vi.fn();
    mount({ onResetForbidden });
    await screen.findByTestId('learning-reset-classification');
    resetBtn().click();
    await waitFor(() => expect(onResetForbidden).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith(COMMON.forbiddenToast, 'error');
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalledWith('forbidden', expect.anything());
  });

  it('ignores a second click while the first request is still open', async () => {
    const d = deferred<LearningResetResult>();
    resetMock.mockReturnValue(d.promise);
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    const btn = resetBtn();
    btn.click();
    await waitFor(() => expect(btn.disabled).toBe(true));
    btn.click();
    expect(resetMock).toHaveBeenCalledTimes(1);
    d.resolve({ ok: true, cleared: 2 });
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
  });

  it('canReset false hides the button and says the account is read-only', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount({ canReset: false });
    await screen.findByTestId('learning-headline-classification-category');
    expect(screen.queryByTestId('learning-reset-classification')).toBeNull();
    expect(screen.getByTestId('learning-readonly-classification').textContent).toBe(COMMON.readOnlyNote);
  });

  it('canReset null (not known yet) shows neither the button nor the note', async () => {
    accuracyMock.mockResolvedValue(MEASURED);
    mount({ canReset: null });
    await screen.findByTestId('learning-headline-classification-category');
    expect(screen.queryByTestId('learning-reset-classification')).toBeNull();
    expect(screen.queryByTestId('learning-readonly-classification')).toBeNull();
    expect(screen.queryByTestId('learning-nothing-to-clear-classification')).toBeNull();
  });

  it('everything it says about clearing passes the copy sweep', async () => {
    resetMock.mockResolvedValue({ ok: true, cleared: 7 });
    accuracyMock.mockResolvedValue(MEASURED);
    mount();
    await screen.findByTestId('learning-reset-classification');
    resetBtn().click();
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const said = [
      cardText(),
      ...confirmSpy.mock.calls.map((c) => String(c[0])),
      ...toastMock.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    expect(copyProblems(said)).toEqual([]);
  });
});
