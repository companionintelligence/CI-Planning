import { createMemo } from 'solid-js';
import { api, type DismissalTrendResponse } from '../../lib/api.js';
import { shortDate } from '../../lib/dates.js';
import type { ChartPoint } from '../../lib/learning-chart.js';
import { clearedSince } from '../../lib/learning-cleared.js';
import {
  COMMON,
  LEARNING_FACTS,
  describeComparison,
  describeRate,
  pointLabel,
  shareCell,
} from '../../lib/learning-copy.js';
import { ageInDays, describeAge, dismissalSeries, isStale } from '../../lib/learning-series.js';
import {
  CADENCE_DAYS,
  LEARNING_LIMITS,
  compareRecent,
  readingValue,
  type Reading,
} from '../../lib/learning-stats.js';
import { LearningCard, type LearningContext, type ResetSpec, type SeriesView, type TileView } from './LearningCard.js';
import { useReadout } from './useReadout.js';

/**
 * Settings → Learning: the "Suggestions you dismiss" card.
 *
 * Reads GET /api/dismissal-learning/trend (OLDEST first, the only one of the four that is;
 * dismissalSeries sorts anyway). hits = dismissed, n = decided, so the share is
 * dismissed / decided. A lower share is the aim, but only read as a change over time and
 * with the caveats below.
 *
 * What this card never does:
 *   - print `created`. It counts every suggestion made in the period from every source,
 *     including the ones the app promotes by itself and nobody can decide on, so it is not
 *     the denominator of this rate. dismissalSeries drops it, so it cannot reach this file.
 *   - show a percent below MIN_N decisions, or a percent without its range.
 *   - show a week with nothing decided as 0%. It is "not measured" and a tick on the chart.
 *   - say that the examples caused a change. `hinted` only means a stored set existed
 *     before that run, not that any email was read with one.
 *   - say WHEN the examples were stored. `hinted` is sampled before that week's rebuild, so
 *     the first flagged reading is the first one taken with a set already in place, which can
 *     be a week after the set was built. The marker says "stored by", and when the first
 *     reading in the window is already flagged there is nothing to mark, so none is drawn.
 *   - print a stored count as if it were current. The count comes from the last Monday pass;
 *     a clear changes the live set but writes no row, so a clear made this session
 *     (ctx.clearedOn) overrides it until a newer reading arrives.
 *
 * All dismissal copy lives in this file. The numbers behind the sentences come from
 * LEARNING_FACTS (lib/learning-copy.ts), which names the server constant for each.
 */

const FACTS = LEARNING_FACTS.dismissal;

// ── Copy ─────────────────────────────────────────────────────────────────────

const TITLE = 'Email choices';

const MEANING =
  'Tracks email suggestions you accept or skip. ' +
  `It checks choices from the last ${FACTS.periodDays} days. ` +
  'Only your decisions count here. ' +
  'Waiting suggestions do not count.';

const CHANGES =
  'Past choices guide new suggestions. ' +
  `After ${FACTS.settledFloor} older skipped emails, examples appear. ` +
  'Only email choices affect this score. ' +
  'The app never hides suggestions.';

/** The first entry is always visible, above the data. The rest sit under "More about this number". */
const CAVEATS: readonly string[] = [
  'Lower rates do not prove change. Different mail can change the rate. Reviewing fewer emails can change it.',
  'Each choice counts once. Repeated choices count again. Accepting later can undo a skip.',
  'Waiting suggestions do not count. Reviewing less can change the rate.',
  'Calendar and note suggestions skip review. They do not affect this score.',
  'Past dismissals may guide other suggestions. Those suggestions still do not count.',
  'Changes can take time to appear. New choices may use older examples.',
  'Stored examples do not prove use. Your local model must be ready.',
  'Comparisons do not prove why rates changed. Mail changes over time.',
  'No choices means not measured. It does not mean a good week.',
];

// Checked against the app: the Settings → Connections tab is where a Google account is
// connected (there is no separate on/off switch for email suggestions; the card there only
// sets how far back to read), and the review list is headed 'Suggested from email' in the
// Tasks tab. So the first steps say "connect", not "turn on".
const HOW_TO_START =
  'Connect Google under Settings → Connections. ' +
  'Accept or skip email suggestions. Find them under Tasks. ' +
  `${FACTS.settledFloor} skips, older than one day, start examples. ` +
  'Accepting later can undo a skip. ' +
  `Skips older than ${FACTS.windowDays} days no longer count. ` +
  'New examples appear each Monday. ' +
  'Your local model must be running.';

const EMPTY_NO_ROWS =
  'No readings yet. New readings arrive each Monday. No choices means no score.';

const MARKER_LEGEND =
  'The dashed line marks stored examples. It does not prove they were used.';

/** Added when the first reading in the window already has a set in place: the start is older than the window. */
const MARKER_BEFORE_WINDOW =
  'Examples were stored before these readings.';

const STATUS_NONE_STORED =
  `This reading found no saved skips. The model needs ${FACTS.settledFloor} older skips.`;

const COMPARISON_LABELS = { unit: 'skipped', noun: 'choices' } as const;

const READINGS_COLUMNS = ['Date', 'Choices', 'Skipped', 'Rate', 'Saved examples'];

const when = (ymd: string): string => shortDate(ymd) || ymd;

const RESET: ResetSpec = {
  label: 'Clear learned skips',
  hint:
    'Stops showing past skips to the model. Your choices stay saved. Monday’s update can rebuild examples. Past readings stay unchanged.',
  confirmText: 'Clear past skips from the model? Your choices stay saved.',
  run: () => api.learning.resetDismissal(),
  clearedMessage: (n) =>
    n === 1
      ? 'Cleared one skip. Monday’s update can rebuild it.'
      : `Cleared ${n} skips. Monday’s update can rebuild them.`,
  emptyMessage: 'Nothing to clear. No skips are saved.',
  doneStatus: 'Your skips were cleared. Monday’s update can rebuild examples.',
  nothingToClear: 'No saved skips are ready to clear.',
};

// ── The builder ──────────────────────────────────────────────────────────────

/** The sentence a reading leads with. Counts first; a percent only at MIN_N decisions or
 *  more, and then with the range those counts allow. */
function headlineFor(r: Reading): string {
  if (!r.measured) {
    // The server writes a null rate exactly when nothing was decided. A row that has
    // decisions but still is not usable (corrupt) must not be explained as "you decided
    // nothing", so it gets its own sentence.
    return r.n === 0
      ? 'Not measured: no choices were made recently.'
      : 'Not measured: this reading could not be used.';
  }

  const d = describeRate(r.hits, r.n);
  if (d.percent === null || d.range === null) {
    return `${d.fraction} skipped by ${when(r.date)}.`;
  }
  return `${d.percent} skipped (${d.fraction}) by ${when(r.date)}. Possible rates range from ${d.range}.`;
}

/** The newest earlier reading that WAS measured, as counts with their unit: '3 of 4' on its own
 *  could be the dismissals or the approvals. */
function lastMeasuredNote(r: Reading): string {
  const d = describeRate(r.hits, r.n);
  return `Last score: ${d.fraction} skips.`;
}

/** What the newest reading says is stored, worded as a dated reading and not as the present:
 *  a clear made since then writes no row, so the live count may be lower. */
function statusFor(newest: Reading, clearedOn: string | undefined): string {
  if (clearedSince(clearedOn, newest.date)) {
    return `Cleared on ${when(clearedOn as string)}. Monday’s update can rebuild examples.`;
  }
  const stored = newest.extra.exemplars ?? 0;
  if (stored > 0) {
    return `The ${when(newest.date)} reading stored ${stored} past skips.`;
  }
  return STATUS_NONE_STORED;
}

/**
 * PURE: only the response and the context (ctx.now is the only field read). No signals, no
 * fetch. The headline is always the NEWEST reading, whatever order the wire used.
 */
export function dismissalView(res: DismissalTrendResponse, ctx: LearningContext): TileView {
  const readings = dismissalSeries(res);
  const newest = readings[readings.length - 1];

  if (!newest) {
    const none: SeriesView = {
      key: 'rate',
      label: null,
      state: 'none',
      headline: null,
      detail: null,
      notes: [],
      comparison: null,
      empty: EMPTY_NO_ROWS,
      chart: null,
      readings: null,
    };
    return { series: [none], contextLines: [], status: null, startOpen: true, resetAvailable: false };
  }

  const age = ageInDays(newest.date, ctx.now);
  const clearedOn = ctx.clearedOn?.dismissal;
  const latest = `Latest reading: ${when(newest.date)}, ${describeAge(age)}.`;

  const notes: string[] = [];
  if (!newest.measured) {
    const lastMeasured = [...readings].reverse().find((r) => r.measured);
    if (lastMeasured) notes.push(lastMeasuredNote(lastMeasured));
  }

  const points: ChartPoint[] = readings.map((r) => ({
    date: r.date,
    value: readingValue(r),
    n: r.n,
    label: pointLabel(r),
  }));
  // The FIRST reading whose stored set existed before its rebuild. A later flip back to 0
  // (after a clear, or when evidence aged out) does not move or add a marker. When that is
  // the first reading shown, the set is older than the window and its start is unknown, so
  // nothing is marked and the caption says why. "by", not "from": the set was built at or
  // before the previous pass.
  const firstHinted = readings.find((r) => r.influence === 1);
  const beforeWindow = firstHinted !== undefined && firstHinted === readings[0];
  const marker =
    firstHinted && !beforeWindow ? { date: firstHinted.date, text: `Examples stored by ${when(firstHinted.date)}` } : null;

  const state: SeriesView['state'] = newest.measured ? 'measured' : 'not-measured';
  const series: SeriesView = {
    key: 'rate',
    label: null,
    state,
    headline: headlineFor(newest),
    // "Lower is better" says nothing about a week that measured nothing.
    detail: newest.measured ? `Lower scores mean fewer skips. ${latest}` : latest,
    notes,
    comparison: describeComparison(compareRecent(readings, FACTS.periodDays), COMPARISON_LABELS),
    empty: null,
    chart: {
      points,
      cadenceDays: CADENCE_DAYS,
      marker,
      caption: marker
        ? `${COMMON.chartCaption} ${MARKER_LEGEND}`
        : beforeWindow
          ? `${COMMON.chartCaption} ${MARKER_BEFORE_WINDOW}`
          : COMMON.chartCaption,
    },
    readings: {
    columns: READINGS_COLUMNS,
      rows: [...readings].reverse().map((r) => ({
        key: r.date,
        cells: [when(r.date), String(r.n), String(r.hits), shareCell(r), String(r.extra.exemplars ?? 0)],
      })),
    },
  };

  // This loop writes a row every Monday, so a quiet gap here is a real signal.
  const contextLines: string[] = [];
  if (isStale(newest.date, ctx.now)) {
    contextLines.push(
      `No new reading for ${age} days. The server may need to run Monday.`,
    );
  }

  return {
    series: [series],
    contextLines,
    status: statusFor(newest, clearedOn),
    startOpen: state !== 'measured',
    // As of the last Monday run, unless this session has cleared since. The frame turns a
    // cleared-0 answer into "nothing to clear".
    resetAvailable: (newest.extra.exemplars ?? 0) > 0 && !clearedSince(clearedOn, newest.date),
  };
}

// ── The component ────────────────────────────────────────────────────────────

export function DismissalTile(props: { context: LearningContext }) {
  const r = useReadout(() => api.learning.dismissalTrend(LEARNING_LIMITS.dismissal));
  const view = createMemo(() => {
    const d = r.data();
    return d ? dismissalView(d, props.context) : null;
  });
  return (
    <LearningCard
      loopKey="dismissal"
      title={TITLE}
      meaning={MEANING}
      changes={CHANGES}
      primaryCaveat={CAVEATS[0]}
      moreCaveats={CAVEATS.slice(1)}
      howToStart={HOW_TO_START}
      status={r.status()}
      error={r.error()}
      onRetry={r.retry}
      view={view()}
      canReset={props.context.canReset}
      onResetForbidden={props.context.onResetForbidden}
      reset={RESET}
    />
  );
}
