import { createMemo } from 'solid-js';
import { api, type PlacementSurvivalResponse } from '../../lib/api.js';
import { shortDate } from '../../lib/dates.js';
import { clearedSince } from '../../lib/learning-cleared.js';
import { COMMON, LEARNING_FACTS, describeComparison, describeRate, pointLabel, shareCell } from '../../lib/learning-copy.js';
import { ageInDays, describeAge, isStale, placementSeries } from '../../lib/learning-series.js';
import { CADENCE_DAYS, LEARNING_LIMITS, compareRecent, readingValue, type Reading } from '../../lib/learning-stats.js';
import { LearningCard, type LearningContext, type ResetSpec, type SeriesView, type TileView } from './LearningCard.js';
import { useReadout } from './useReadout.js';

/**
 * Settings → Learning: "Where Auto places your blocks".
 *
 * The placement loop (services/placement-learning.ts): the Auto scheduler logs where it
 * put each block, a weekly pass grades the blocks that settled, and once enough of one
 * direction were moved to a different hour it stores an hour preference. This tile shows
 * the weekly kept share and what is stored, and offers one clear button.
 *
 * Everything the owner reads here follows the panel's honesty rules (see the frame in
 * LearningCard.tsx and the pure helpers in lib/learning-*.ts):
 *   - counts first ('5 of 7'); a percent only at MIN_N cases or more, and then with its
 *     Wilson range;
 *   - the rate is derived from hits and n, never copied from the wire;
 *   - a null rate, or a reading with nothing settled, is "not measured": a dashed tick,
 *     never a dot at 0 and never "0%";
 *   - the headline is always the NEWEST reading, whatever order the wire used;
 *   - the comparison pools counts over readings that do not overlap (28-day readings, so
 *     the newest and the one 28 days older), and says "no clear change" unless the Wilson
 *     ranges fully separate.
 *
 * This loop needs no model, so there is no model-off line (aiAvailable is ignored).
 *
 * One thing the card says that is easy to get wrong: what "settled" means (services/
 * placement-learning.ts placementOutcome). A block you MOVED counts at once, even when its slot is
 * days away. A block you left alone counts as kept only after its start time passes. So the
 * newest reading leans toward moved blocks, and the MEANING and the second caveat say so.
 *
 * Two things this tile will not claim:
 *   - when the preferences were stored. `biased` is sampled before that week's rebuild, so the
 *     first flagged reading is the first one taken with preferences already in place, which
 *     can be a week after they were written. The marker says "stored by", and when the first
 *     reading in the window is already flagged there is nothing to mark, so none is drawn.
 *   - that the stored count is current. It comes from the last Monday pass; a clear changes
 *     the live preferences but writes no row, so the status is worded as a dated reading and
 *     a clear made this session (ctx.clearedOn) overrides it until a newer reading arrives.
 *
 * All the copy below was checked against server/src/services/placement-learning.ts and
 * server/src/engine/scheduler.ts. Server facts it quotes live in LEARNING_FACTS.placement.
 */

const F = LEARNING_FACTS.placement;

/** 'one hour' for the 60 minute budget, else minutes, so the sentence follows the constant. */
const FRAGMENT_BUDGET = F.maxExtraFragmentMinutes === 60 ? 'one hour' : `${F.maxExtraFragmentMinutes} minutes`;

const TITLE = 'Where Auto places your blocks';

const MEANING =
  'What it counts: blocks the Auto scheduler placed that have settled. A block is moved when you put it at a different hour. ' +
  'It is kept when its start time has passed and it is still there, or when you only nudged it within the same hour or resized it. ' +
  'Not counted: blocks Auto had to shorten to fit, auto blocks that are gone when the weekly pass runs (re-planning deletes and re-places them all the time) unless you had already moved them, ' +
  'untouched blocks whose time has not come yet, and anything placed by routines or patterns. ' +
  `Window: blocks Auto placed in the ${F.periodDays} days before each reading, one reading every Monday (early on Monday, server time), so readings overlap. ` +
  'Cases behind it: the number of settled blocks, printed in every line. Direction: higher is better.';

const CHANGES =
  `What it changes: once at least ${F.correctionFloor} of your moves of one direction to a different hour fall in the last ${F.windowDays} days, ` +
  `and the middle half of the hours that direction's settled blocks sit at (kept or moved) spans no more than ${F.maxBandHours} hours, ` +
  `Auto leans toward that band when several gaps fit, by at most ${FRAGMENT_BUDGET} of extra fragmentation. ` +
  "A direction is the task's top-level direction tag (for example Work, Home or Community); untagged tasks share one group. " +
  'It never moves a block you placed and never overrides a lock, a pin or a deadline. No model is needed.';

/** The first entry is always visible above the data; the rest sit in the details block. */
const CAVEATS: readonly string[] = [
  'Kept does not mean liked. A block you never looked at counts as kept, so this goes up if you stop opening your calendar.',
  'A move counts as soon as you make it, even for a block days away. A block you leave alone counts as kept only after its start time passes. ' +
    'So each reading leans toward moved blocks, and it can read lower than it will once those blocks have passed.',
  'Only blocks that survived long enough to be judged are counted. An auto block that is gone when the weekly pass runs is counted neither way unless you had already moved it, so this describes survivors.',
  'Only the hour of day is compared. A nudge inside the same hour, a resize, or a move to another day at the same hour counts as kept.',
  `Each reading covers ${F.periodDays} days but one is added every week, so neighbouring readings share about three quarters of their blocks. A smooth line is partly the overlap, and comparisons use readings at least ${F.periodDays} days apart.`,
  'People move blocks for reasons that have nothing to do with where Auto put them: a meeting came up, the phone rang.',
  "Only Auto's choices are logged. Blocks placed by routines and patterns are not, and shortened fits are left out.",
  'A comparison is between two stretches of time. A preference built from your moves cannot be separated from you simply moving fewer blocks, and a reset changes the baseline.',
  "A week with nothing settled is 'not measured', not a bad week.",
];

const HOW_TO_START =
  'Use Auto to place tasks on your calendar (it is the only thing logged), and let the day arrive. Move the blocks that land at the wrong hour. ' +
  `After ${F.correctionFloor} moves of one direction (for example Work, Home or Community, or untagged) to a different hour within ${F.windowDays} days, ` +
  `and if the middle half of the hours that direction's settled blocks sit at spans no more than ${F.maxBandHours} hours, ` +
  'the next Monday pass writes an hour preference for that direction. ' +
  "Readings begin on the first Monday after install and stay 'not measured' until some block settles. " +
  'No model is needed and there is no setting that turns this off.';

const EMPTY_TEXT =
  'No readings yet. A reading is added every Monday, even when no blocks were settled. If this stays empty after a Monday, the weekly pass has not run.';

const OVERLAP_CAPTION = `Each dot covers the ${F.periodDays} days before its date, and one is added every week, so neighbouring dots share most of their blocks. The line is smoother than the evidence.`;

const MARKER_LEGEND =
  'The dashed line marks the first reading taken after Auto had stored hour preferences. It does not show that any block was placed using one.';

/** Added when the first reading in the window already has preferences in place: the start is older than the window. */
const MARKER_BEFORE_WINDOW =
  'Auto already had hour preferences at the earliest reading shown, so no marker is drawn.';

const STATUS_NO_PREFERENCES =
  `Auto has no hour preferences yet. They start after you move at least ${F.correctionFloor} blocks of one direction to a different hour.`;

const RESET: ResetSpec = {
  label: 'Clear learned hours',
  hint:
    "Auto goes back to choosing gaps with no hour preference. Your move history is kept, so Monday's pass can learn the hours again. " +
    'Past readings stay, and they describe the old preferences. There is no setting that turns this off.',
  confirmText: "Clear the hours Auto has learned? Your move history is kept and Monday's pass can learn them again.",
  run: () => api.learning.resetPlacement(),
  clearedMessage: (n) =>
    n === 1
      ? 'Cleared 1 hour preference. It is learned again from your moves on Monday.'
      : `Cleared ${n} hour preferences. They are learned again from your moves on Monday.`,
  emptyMessage: 'Nothing to clear. No hour preferences are stored.',
  doneStatus: 'Cleared. Auto chooses with no hour preference until Monday.',
  nothingToClear: 'No hour preferences are stored, so there is nothing to clear.',
};

// ── Builders ─────────────────────────────────────────────────────────────────

const countOf = (r: Reading, key: string): number => {
  const v = r.extra[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** ' 2 were moved to a different hour.' Left out when the counts do not add up, so a
 *  row that contradicts itself never prints a sentence that contradicts the headline. */
function movedSentence(r: Reading): string {
  const moved = countOf(r, 'corrected');
  if (r.hits + moved !== r.n) return '';
  return ` ${moved} ${moved === 1 ? 'was' : 'were'} moved to a different hour.`;
}

function measuredHeadline(r: Reading): string {
  const d = describeRate(r.hits, r.n);
  const span = `in the ${r.periodDays} days to ${shortDate(r.date)}`;
  const moved = movedSentence(r);
  if (d.percent === null || d.range === null) {
    const one = r.n === 1;
    // "Not moved to a different hour", not "kept where Auto put it": a nudge inside the same
    // hour, a resize, or a move to another day at the same hour counts here too.
    return `${d.fraction} settled ${one ? 'block was' : 'blocks were'} not moved to a different hour, ${span}.${moved}`;
  }
  return `${d.percent} kept (${d.fraction}) ${span}.${moved} With this many cases the true figure could be anywhere from ${d.range}.`;
}

function notMeasuredHeadline(r: Reading): string {
  const span = `in the ${r.periodDays} days to ${shortDate(r.date)}`;
  // The server writes a null rate only when nothing settled. If a row has cases but no
  // usable rate, say that instead, so the sentence is never false.
  if (r.n > 0) return `Not measured: the reading for the ${r.periodDays} days to ${shortDate(r.date)} could not be used.`;
  return `Not measured: no auto-placed block was settled ${span}.`;
}

/** The newest earlier reading that WAS measured, as a counts-only note. It names what is
 *  counted, because '3 of 4' on its own could be the kept blocks or the moved ones. */
function lastMeasuredNote(readings: readonly Reading[]): string | null {
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = readings[i];
    if (r.measured) {
      const what = r.n === 1 ? 'settled block was' : 'settled blocks were';
      return `Last measured: ${describeRate(r.hits, r.n).fraction} ${what} not moved to a different hour, on ${shortDate(r.date)}.`;
    }
  }
  return null;
}

function emptySeries(): SeriesView {
  return {
    key: 'survival',
    label: null,
    state: 'none',
    headline: null,
    detail: null,
    notes: [],
    comparison: null,
    empty: EMPTY_TEXT,
    chart: null,
    readings: null,
  };
}

/**
 * Pure: the whole tile as a view-model, from the response and the context. The wire is
 * newest first; this sorts ascending itself (placementSeries) and reads the newest.
 */
export function placementView(res: PlacementSurvivalResponse, ctx: LearningContext): TileView {
  const readings = placementSeries(res);
  const newest = readings[readings.length - 1];
  if (!newest) {
    return { series: [emptySeries()], contextLines: [], status: null, startOpen: true, resetAvailable: false };
  }

  const when = shortDate(newest.date);
  const age = describeAge(ageInDays(newest.date, ctx.now));
  const latestLine = `Latest reading: ${when} (${age}).`;
  const keys = countOf(newest, 'keys_learned');

  // The first reading taken with preferences already in place. "by", not "from": they were
  // written at or before the previous pass. If that is the first reading shown, the real
  // start is outside the window, so nothing is marked.
  const marker = readings.find((r) => r.influence === 1);
  const beforeWindow = marker !== undefined && marker === readings[0];
  const markerView =
    marker && !beforeWindow ? { date: marker.date, text: `Preferences stored by ${shortDate(marker.date)}` } : null;
  const clearedOn = ctx.clearedOn?.placement;
  const cleared = clearedSince(clearedOn, newest.date);

  const series: SeriesView = {
    key: 'survival',
    label: null,
    state: newest.measured ? 'measured' : 'not-measured',
    headline: newest.measured ? measuredHeadline(newest) : notMeasuredHeadline(newest),
    detail: newest.measured ? `Higher is better. ${latestLine}` : latestLine,
    notes: newest.measured ? [] : [lastMeasuredNote(readings)].filter((n): n is string => n !== null),
    comparison: describeComparison(compareRecent(readings, F.periodDays), { unit: 'kept', noun: 'settled blocks' }),
    empty: null,
    chart: {
      points: readings.map((r) => ({ date: r.date, value: readingValue(r), n: r.n, label: pointLabel(r) })),
      cadenceDays: CADENCE_DAYS,
      marker: markerView,
      caption: [COMMON.chartCaption, OVERLAP_CAPTION, markerView ? MARKER_LEGEND : '', beforeWindow ? MARKER_BEFORE_WINDOW : '']
        .filter(Boolean)
        .join(' '),
    },
    readings: {
      columns: ['Date', 'Settled', 'Kept', 'Moved', 'Share', 'Hour preferences'],
      rows: [...readings].reverse().map((r) => ({
        key: r.date,
        cells: [shortDate(r.date), String(r.n), String(r.hits), String(countOf(r, 'corrected')), shareCell(r), String(countOf(r, 'keys_learned'))],
      })),
    },
  };

  // Placement writes a row every Monday, so a long quiet stretch is a real signal.
  const contextLines = isStale(newest.date, ctx.now)
    ? [`No new reading for ${ageInDays(newest.date, ctx.now)} days. The weekly pass may not have run; it needs the server to be on early on Monday.`]
    : [];

  return {
    series: [series],
    contextLines,
    status: cleared
      ? `Cleared on ${shortDate(clearedOn as string)}. Auto chooses with no hour preference until Monday's pass.`
      : keys > 0
        ? `At the ${when} reading, Auto had hour preferences for ${keys} ${keys === 1 ? 'direction' : 'directions'}.`
        : STATUS_NO_PREFERENCES,
    startOpen: !newest.measured,
    // As of the last Monday run, unless this session has cleared since.
    resetAvailable: keys > 0 && !cleared,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function PlacementTile(props: { context: LearningContext }) {
  const r = useReadout(() => api.learning.placementSurvival(LEARNING_LIMITS.placement));
  const view = createMemo(() => {
    const d = r.data();
    return d ? placementView(d, props.context) : null;
  });
  return (
    <LearningCard
      loopKey="placement"
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
