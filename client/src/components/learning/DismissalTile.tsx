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

const TITLE = 'Suggestions you dismiss';

const MEANING =
  `Email suggestions that you approved or dismissed by hand, counted over the last ${FACTS.periodDays} days. ` +
  'One reading is added early on Monday (server time). The share dismissed is dismissals divided by decisions. ' +
  'Suggestions the app added by itself are not counted, and neither are ones you left waiting. ' +
  'It counts decisions, not distinct suggestions.';

const CHANGES =
  'It changes what is proposed, never what is hidden. ' +
  `After ${FACTS.settledFloor} dismissals from the last ${FACTS.windowDays} days that have settled (over a day old, and not reversed by approving), ` +
  `up to ${FACTS.retrieveK} past dismissals that look like a new item are shown to the model as history whenever the app reads email, calendar events or text notes for suggestions. ` +
  'Only decisions on email suggestions are counted in the share below. ' +
  'It never hides or filters a suggestion.';

/** The first entry is always visible, above the data. The rest sit under "More about this number". */
const CAVEATS: readonly string[] = [
  'A lower rate does not mean the model got better. It can also mean different mail arrived, or that you reviewed fewer suggestions.',
  'It counts decisions (clicks), not suggestions. Dismissing the same suggestion twice, or dismissing and then approving it, adds to the count each time.',
  'Only suggestions you decided on are in the rate. Ones you leave waiting are not, so reviewing less can move it.',
  'Only email suggestions wait for your decision. Calendar, text and memory suggestions are added to Tasks automatically, so they are not counted.',
  'Past email dismissals are also shown to the model when it reads calendar events and text notes. Those suggestions are added to Tasks with no review step, so they can be shaped by your past dismissals and are still never counted here.',
  'Suggestions you decide on this week may have been created weeks ago, before any past dismissals were shown to the model, so a change in the rate can lag the examples by more than one reading.',
  "'Examples stored' means the stored set was not empty before that reading's weekly pass. It does not show that any email was read with an example in front of the model, and the model is not run when your local model is off.",
  'A comparison is between two stretches of time, not a controlled test. Season, who emails you and how much all change.',
  "A week with nothing decided is 'not measured', not a good week.",
];

// Checked against the app: the Settings → Connections tab is where a Google account is
// connected (there is no separate on/off switch for email suggestions; the card there only
// sets how far back to read), and the review list is headed 'Suggested from email' in the
// Tasks tab. So the first steps say "connect", not "turn on".
const HOW_TO_START =
  'Connect a Google account under Settings → Connections so your email can be read for suggestions. ' +
  "Email suggestions are the ones you decide on: approve or dismiss them under 'Suggested from email' in the Tasks tab. " +
  `After ${FACTS.settledFloor} dismissals from the last ${FACTS.windowDays} days that are over a day old and that you did not reverse by approving, the weekly pass builds the examples. ` +
  `Dismissals older than ${FACTS.windowDays} days drop out, so the examples go again if fewer than ${FACTS.settledFloor} are left. ` +
  'Your local model (Ollama) must be running while new email, calendar events or text notes are read for the examples to be shown to it. ' +
  "Readings start on the first Monday after install whether or not you have decided anything. The rate stays 'not measured' until you do.";

const EMPTY_NO_ROWS =
  'No readings yet. A reading is added every Monday, even when you decided nothing. If this stays empty after a Monday, the weekly pass has not run.';

const MARKER_LEGEND =
  'The dashed line marks the first reading taken after a set of past dismissals was stored. It does not show that any email was read with one.';

/** Added when the first reading in the window already has a set in place: the start is older than the window. */
const MARKER_BEFORE_WINDOW =
  'Past dismissals were already stored at the earliest reading shown, so no marker is drawn.';

const STATUS_NONE_STORED =
  `The model is shown no past dismissals right now. That needs ${FACTS.settledFloor} dismissals from the last ${FACTS.windowDays} days that are over a day old and that you did not reverse by approving. Older ones drop out.`;

const COMPARISON_LABELS = { unit: 'dismissed', noun: 'decisions' } as const;

const READINGS_COLUMNS = ['Date', 'Decided', 'Dismissed', 'Share', 'Examples stored at this pass'];

const when = (ymd: string): string => shortDate(ymd) || ymd;

const RESET: ResetSpec = {
  label: 'Clear learned dismissals',
  hint:
    "Stops the model being shown your past dismissals. Your approve and dismiss history is kept, so Monday's pass builds them again. " +
    'Past readings stay, and they describe the old examples. There is no setting that turns this off.',
  confirmText: "Stop showing the model your past dismissals? Your history is kept and Monday's pass will rebuild them.",
  run: () => api.learning.resetDismissal(),
  clearedMessage: (n) =>
    n === 1
      ? 'Cleared 1 past dismissal. It is rebuilt from your history on Monday.'
      : `Cleared ${n} past dismissals. They are rebuilt from your history on Monday.`,
  emptyMessage: 'Nothing to clear. No past dismissals are stored.',
  doneStatus: "Cleared. The model is shown no past dismissals until Monday's pass.",
  nothingToClear: 'No past dismissals are stored, so there is nothing to clear.',
};

// ── The builder ──────────────────────────────────────────────────────────────

/** The sentence a reading leads with. Counts first; a percent only at MIN_N decisions or
 *  more, and then with the range those counts allow. */
function headlineFor(r: Reading): string {
  const span = `in the ${r.periodDays} days to ${when(r.date)}`;

  if (!r.measured) {
    // The server writes a null rate exactly when nothing was decided. A row that has
    // decisions but still is not usable (corrupt) must not be explained as "you decided
    // nothing", so it gets its own sentence.
    return r.n === 0
      ? `Not measured: you did not approve or dismiss any suggestion ${span}.`
      : `Not measured: the reading ${span} could not be used.`;
  }

  const d = describeRate(r.hits, r.n);
  if (d.percent === null || d.range === null) {
    return r.n === 1
      ? `${d.fraction} decision on suggestions was a dismissal, ${span}.`
      : `${d.fraction} decisions on suggestions were dismissals, ${span}.`;
  }
  return `${d.percent} dismissed (${d.fraction} decisions) ${span}. With this many cases the true figure could be anywhere from ${d.range}.`;
}

/** The newest earlier reading that WAS measured, as counts with their unit: '3 of 4' on its own
 *  could be the dismissals or the approvals. */
function lastMeasuredNote(r: Reading): string {
  const d = describeRate(r.hits, r.n);
  const what = r.n === 1 ? 'decision was a dismissal' : 'decisions were dismissals';
  return `Last measured: ${d.fraction} ${what}, on ${when(r.date)}.`;
}

/** What the newest reading says is stored, worded as a dated reading and not as the present:
 *  a clear made since then writes no row, so the live count may be lower. */
function statusFor(newest: Reading, clearedOn: string | undefined): string {
  if (clearedSince(clearedOn, newest.date)) {
    return `Cleared on ${when(clearedOn as string)}. The model is shown no past dismissals until Monday's pass.`;
  }
  const stored = newest.extra.exemplars ?? 0;
  if (stored > 0) {
    return (
      `At the ${when(newest.date)} reading, ${stored} past ${stored === 1 ? 'dismissal was' : 'dismissals were'} stored. ` +
      `Up to ${FACTS.retrieveK} are shown to the model at a time while it reads email, calendar events or text notes for suggestions.`
    );
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
  const latest = `Latest reading: ${when(newest.date)} (${describeAge(age)}).`;

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
    detail: newest.measured ? `Lower is better. ${latest}` : latest,
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
      `No new reading for ${age} days. The weekly pass may not have run; it needs the server to be on early on Monday.`,
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
