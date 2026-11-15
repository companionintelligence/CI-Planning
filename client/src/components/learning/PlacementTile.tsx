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

const TITLE = 'Auto schedule times';

const MEANING =
  'Tracks blocks Auto puts on calendars. ' +
  'Moved means you changed the hour. ' +
  'Untouched blocks count after they start. ' +
  `Each reading checks the last ${F.periodDays} days. ` +
  'Small samples can mislead.';

const CHANGES =
  'Auto groups tasks by tags. ' +
  'Five moves can teach Auto your hours. ' +
  'Those times must fit six hours. ' +
  'Auto may favor those hours. ' +
  'Auto still respects pins and deadlines. ' +
  'No model is needed.';

/** The first entry is always visible above the data; the rest sit in the details block. */
const CAVEATS: readonly string[] = [
  'Kept does not always mean liked. ' +
    'Moves count right away.',
  'Only Auto-placed blocks count here. Other blocks are left out.',
  'Auto checks the hour, not minutes. Same-hour changes count as kept.',
  `Readings cover ${F.periodDays} overlapping days. Nearby results share many blocks.`,
  'Other reasons may cause moves. Meetings can change your plans.',
  'Comparisons do not prove why blocks moved. A reset changes future learning.',
  'No finished blocks means no score. ' +
    'It does not mean a bad week.',
];

const HOW_TO_START =
  'Let Auto place some tasks. ' +
  'Move Auto blocks at poor hours. ' +
  `${F.correctionFloor} moves in one group may teach Auto. ` +
  'Those times must fit six hours. ' +
  'Auto checks again each Monday. ' +
  'No model is needed.';

const EMPTY_TEXT =
  'No readings yet. New readings arrive each Monday. No finished blocks means no score.';

const OVERLAP_CAPTION = `Each dot covers ${F.periodDays} overlapping days. Nearby dots share many blocks.`;

const MARKER_LEGEND =
  'The dashed line marks saved preferences. It does not prove Auto used them.';

/** Added when the first reading in the window already has preferences in place: the start is older than the window. */
const MARKER_BEFORE_WINDOW =
  'Auto had saved preferences before these readings.';

const STATUS_NO_PREFERENCES =
  `Auto needs ${F.correctionFloor} moves before learning your hours.`;

const RESET: ResetSpec = {
  label: 'Clear learned hours',
  hint:
    'Auto stops using learned hours. Your move history stays saved. Monday’s update can learn again. Past readings stay unchanged.',
  confirmText: 'Clear Auto’s learned hours? Your move history stays saved.',
  run: () => api.learning.resetPlacement(),
  clearedMessage: (n) =>
    n === 1
      ? 'Cleared one hour preference. Monday’s update can learn again.'
      : `Cleared ${n} hour preferences. Monday’s update can learn again.`,
  emptyMessage: 'Nothing to clear. No hours are saved.',
  doneStatus: 'Your saved hours were cleared. Monday’s update can learn again.',
  nothingToClear: 'No saved hours are ready to clear.',
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
  return moved === 1 ? ' One block moved to another hour.' : ` ${moved} blocks moved to another hour.`;
}

function measuredHeadline(r: Reading): string {
  const d = describeRate(r.hits, r.n);
  const moved = movedSentence(r);
  if (d.percent === null || d.range === null) {
    const kept = r.n === 1 ? 'One block stayed in its hour.' : `${d.fraction} blocks stayed in their hours.`;
    return `${kept}${moved}`;
  }
  return `${d.percent} stayed in their hour (${d.fraction}). Possible rates range from ${d.range}.${moved}`;
}

function notMeasuredHeadline(r: Reading): string {
  // The server writes a null rate only when nothing settled. If a row has cases but no
  // usable rate, say that instead, so the sentence is never false.
  if (r.n > 0) return 'Not measured: this reading could not be used.';
  return 'Not measured: no Auto blocks settled.';
}

/** The newest earlier reading that WAS measured, as a counts-only note. It names what is
 *  counted, because '3 of 4' on its own could be the kept blocks or the moved ones. */
function lastMeasuredNote(readings: readonly Reading[]): string | null {
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = readings[i];
    if (r.measured) {
      return `Last score: ${describeRate(r.hits, r.n).fraction} blocks stayed put.`;
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
  const latestLine = `Latest reading: ${when}, ${age}.`;
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
    detail: newest.measured ? `Higher scores mean more blocks stayed put. ${latestLine}` : latestLine,
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
    ? [`No new reading for ${ageInDays(newest.date, ctx.now)} days. The server may need to run Monday.`]
    : [];

  return {
    series: [series],
    contextLines,
    status: cleared
      ? `Cleared on ${shortDate(clearedOn as string)}. Monday’s update can learn again.`
      : keys > 0
        ? `Auto saved hours for ${keys} groups.`
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
