import { createMemo } from 'solid-js';
import { api, type ClassificationAccuracyResponse } from '../../lib/api.js';
import { shortDate } from '../../lib/dates.js';
import { clearedSince } from '../../lib/learning-cleared.js';
import type { ChartPoint } from '../../lib/learning-chart.js';
import { COMMON, LEARNING_FACTS, describeRate, pointLabel, shareCell } from '../../lib/learning-copy.js';
import { ageInDays, classificationSeries, describeAge, isStale, type FieldSeries } from '../../lib/learning-series.js';
import {
  CADENCE_DAYS,
  LEARNING_LIMITS,
  MIN_N,
  daysBetween,
  formatRange,
  readingValue,
  wilsonRange,
  type Reading,
} from '../../lib/learning-stats.js';
import { LearningCard, type LearningContext, type ResetSpec, type SeriesView, type TileView } from './LearningCard.js';
import { useReadout } from './useReadout.js';

/**
 * Settings → Learning: the "Category and motivation guesses" card.
 *
 * Reads GET /api/classification/accuracy (newest first, ROWS across both fields).
 * hits = correct, n = held_out, and held_out counts the answers that were actually scored,
 * not the corrections held back: a call that failed or returned nothing is skipped
 * (services/classification-learning.ts scoreHeldOut).
 *
 * What this card never does:
 *   - combine or average the two fields. Each gets its own block, driven by `fields`.
 *   - pool readings, compare weeks or give a verdict. The held-out set is every 4th
 *     correction of a rolling 90-day window, so it shifts between weeks and repeats across
 *     them; two weeks are not independent samples. compareRecent is deliberately not called.
 *   - show a percent below MIN_N scored cases, or a percent without its range (describeRate).
 *   - show a reading that scored nothing as 0%. accuracy null or held_out 0 is "not
 *     measured" and a dashed tick; the old number is never promoted to the headline.
 *   - show the empty-week gap as a bad week. A field under the 2-correction floor writes NO
 *     row, which is a break in the line and a different thing from a null row.
 *   - leave an old score standing as if it were current. When a field's newest reading is
 *     older than STALE_AFTER_DAYS the card says so, says why when the other field proves the
 *     weekly pass ran, and calls the number the "last reading".
 *   - print an example count it does not have. The wire reports none, so the status line
 *     exists only after a clear made this session (ctx.clearedOn), which overrides the
 *     Monday readings until a newer one arrives.
 *
 * All classification copy lives in this file. The numbers behind the sentences come from
 * LEARNING_FACTS (lib/learning-copy.ts), which names the server constant for each.
 */

const F = LEARNING_FACTS.classification;

// ── Copy ─────────────────────────────────────────────────────────────────────

const TITLE = 'Task label guesses';

const MEANING =
  'Tracks how often guesses match your corrections. ' +
  `It checks guesses from the past ${F.windowDays} days. ` +
  'Each week, it tests some corrected guesses. ' +
  'Only hard guesses get tested. ' +
  'Small samples can mislead.';

// The examples reach a prompt in THREE places, and the copy keeps them apart because they
// differ in what picks the examples and in what they need:
//   - the Describe-it line in the Add dialog (routes/tasks.ts enrichEntry; POST /api/tasks/quick,
//     which no screen calls, gets the same prompt): the owner's most frequent corrections, never
//     picked by similarity (embedFn: null), at the end of the prompt (agents/quickadd.ts). No
//     Companion Memory. It only does anything for categories when the model names one of the
//     owner's categories, as a list or as one word: quick-add's merge reads a bare string as one
//     name (since 2026-11-02; before that a small model that answers one word, qwen2.5:0.5b,
//     yielded no pick and nothing to learn from). And only for the models it was measured on
//     (agents/quickadd-hint-models.ts: gemma3n:e4b, qwen2.5:3b, gemma3:4b, plus QUICK_ADD_HINT_MODELS):
//     three other models answered worse with the examples, so any other model gets the usual prompt.
//   - the fill-in from memory (services/task-enrich.ts): similarity when an embedder answers,
//     else frequency. It returns early when memory is off ("Memory is off") and again when the
//     search finds nothing ("No related memory found"), both BEFORE it reads the examples.
//   - Monday's test (services/classification-score.ts): a narrow one-field question with the
//     examples retrieved by similarity. It is not quick-add's prompt, so the score is not a
//     score of the Describe-it line, and the copy says so.
// Learning is batch for all three: a correction changes no prompt until the next Monday run,
// and a field needs CORRECTION_FLOOR learnable corrections (a cleared category is logged but not
// learned from). "Exactly one place" or "never shown to the model" would claim less than the
// code does; "when the model guesses" would claim more.
const MEMORY_FILL_IN = 'Memory suggestions need Companion Memory.';

const CHANGES =
  'Your corrections teach the model over time. ' +
  `After ${F.correctionFloor} similar corrections, examples can guide guesses. ` +
  'New examples appear after Monday’s update. ' +
  'The model never replaces your entries. ' +
  `${MEMORY_FILL_IN}`;

// Deliberately NOT "the stock model got it wrong the first time". The model that made the
// first guess is not always a stock one: services/task-enrich.ts puts the current examples
// in the prompt BEFORE the guess that is logged, so once an index exists a later correction
// is a miss by the model WITH examples. What is true for every held-back case is that the
// first guess was not what the owner chose.
const PRIMARY_CAVEAT =
  'These are guesses you corrected. ' +
  'A high score means more matches. ' +
  'It cannot prove the model is right.';

// Built from wilsonRange, never typed, so the example cannot drift from the maths.
const SMALL_NUMBERS_RANGE = formatRange(wilsonRange(3, 4) ?? { lo: 0, hi: 1 });

const MORE_CAVEATS: readonly string[] = [
  'The test skips guesses already right. ' +
    'Failed model calls do not count. ' +
    'Answers must match your full choice.',
  'This score does not rate other features. ' +
    'Memory suggestions use different examples. ' +
    'The app may answer differently each time.',
  'Only corrected guesses are tested. ' +
    'Other tasks may work differently. ' +
    'Small samples can change quickly.',
  `Each week checks guesses from ${F.windowDays} days. ` +
    'Some guesses appear in several readings. ' +
    'Weekly results are not separate tests.',
  `The app scores up to ${F.maxScored} guesses weekly. ` +
    `It shows rates only with ${MIN_N} cases. ` +
    `With four, rates may range ${SMALL_NUMBERS_RANGE}.`,
  'Not measured does not mean bad. ' +
    'It means nothing could be scored.',
];

const HOW_TO_START =
  'Correct a guess when it is wrong. ' +
  `${F.correctionFloor} recent, similar corrections start learning. ` +
  'The app checks again each Monday. ' +
  'Your local model must be ready. ' +
  'Memory suggestions need Companion Memory.';

const NO_VERDICT =
  'Too few readings to compare fairly.';

// "Not ready", not "not reachable": the flag behind this is false both when Ollama is down and
// when it is running without the models this needs (lib/ollama-health.ts), and the second
// case is not "unreachable".
const AI_OFF =
  'Your local model is not ready. New guesses are paused. Monday’s check cannot run.';

const NO_ROWS_AT_ALL =
  'No readings yet. ' +
  `It needs ${F.correctionFloor} similar corrections. ` +
  'The app checks early each Monday.';

const TABLE_COLUMNS = ['Date', 'Matched', 'Scored', 'Rate'];

// ── Reset ────────────────────────────────────────────────────────────────────

const RESET: ResetSpec = {
  label: 'Clear learned examples',
  hint:
    'Removes examples shown to the model. ' +
    'Your corrections stay saved. ' +
    'Monday’s update can rebuild the examples. ' +
    'Past readings stay unchanged.',
  confirmText: 'Clear the model’s learned examples? Your corrections stay saved.',
  run: () => api.learning.resetClassification(),
  clearedMessage: (n) =>
    n === 1
      ? 'Cleared one example. Monday’s update can rebuild it.'
      : `Cleared ${n} examples. Monday’s update can rebuild them.`,
  emptyMessage: 'Nothing to clear. No examples are saved.',
  doneStatus: 'Your examples were cleared. Monday’s update can rebuild them.',
  nothingToClear: 'No examples are saved to clear.',
};

// ── The pure builder ─────────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = { category: 'Task type', motivation: "Who it's for (me, us, them)" };
const FIELD_SHORT: Record<string, string> = { category: 'Task type', motivation: "Who it's for" };
const labelOf = (field: string): string => FIELD_LABEL[field] ?? field;

/** What a guess was about, as the line under the card names it. Order is the order printed. */
const KIND_ORDER = ['task', 'time_block'] as const;
const KIND_LABEL: Readonly<Record<string, string>> = { task: 'tasks', time_block: 'Time Blocks' };
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The corrections the weekly pass can learn from, split by what each guess was about. Null when
 * the response carries none (an older server, a quiet account, or nothing counted), so the card
 * says nothing rather than "0". Fields print in the response's order, kinds in KIND_ORDER, and a
 * kind with no corrections is left out of its field's sentence. The days count from when the
 * guess was made, as the rest of the card says; a count that is not a whole non-negative number
 * is ignored.
 */
export function evidenceLine(res: ClassificationAccuracyResponse): string | null {
  const parts: string[] = [];
  for (const field of res.fields) {
    const byKind = KIND_ORDER.flatMap((kind) => {
      const n = (res.evidence ?? [])
        .filter((e) => e.field === field && e.entity_kind === kind)
        .reduce((sum, e) => sum + (isCount(e.corrections) ? Math.floor(e.corrections) : 0), 0);
      return n > 0 ? [`${n} ${KIND_LABEL[kind]}`] : [];
    });
    if (byKind.length > 0) parts.push(`${shortOf(field)}: ${byKind.join(', ')}`);
  }
  if (parts.length === 0) return null;
  return `Recent corrections: ${parts.join('; ')}.`;
}
const shortOf = (field: string): string => FIELD_SHORT[field] ?? field;

/** Only readingValue decides "measured": it re-checks the counts, so a corrupt row is never a number. */
const isMeasured = (r: Reading): boolean => readingValue(r) !== null;

function noReadingYet(field: string): string {
  return `${shortOf(field)}: no reading yet. It needs ${F.correctionFloor} similar corrections.`;
}

/** Fraction first. A percent only at MIN_N scored cases, and then always with its range.
 *  A stale reading is called the "last reading", so it is not taken for this week's. */
function measuredHeadline(field: string, r: Reading, stale: boolean): string {
  const d = describeRate(r.hits, r.n);
  const when = shortDate(r.date);
  const reading = stale ? 'Last reading' : 'Latest reading';
  if (d.percent === null || d.range === null) {
    return `${d.fraction} guesses matched your choice. ${reading}: ${when}.`;
  }
  return (
    `${d.percent} matched (${d.fraction}). ` +
    `Possible rates range from ${d.range}. ${reading}: ${when}.`
  );
}

function notMeasuredHeadline(r: Reading): string {
  return `Not measured on ${shortDate(r.date)}. No score was ready.`;
}

function tableRow(r: Reading): { key: string; cells: string[] } {
  // An unmeasured reading never shows a count that could be read as a zero score.
  const cells = isMeasured(r)
    ? [shortDate(r.date), String(r.hits), String(r.n), shareCell(r)]
    : [shortDate(r.date), COMMON.notMeasured, COMMON.notMeasured, COMMON.notMeasured];
  return { key: r.date, cells };
}

/**
 * Why a field has no reading for over a week. A field under the correction floor writes NO
 * row and has its examples removed, so a missing row is the usual reason. But a pass that
 * never ran looks the same, so the cause is named only when the OTHER field has a newer
 * reading, which proves the pass ran since.
 */
function staleNote(newest: Reading): string {
  return `No reading since ${shortDate(newest.date)}. The reason is unknown.`;
}

function fieldView(fs: FieldSeries, ctx: LearningContext, emptyText: string): SeriesView {
  const readings = fs.readings; // ascending: the normaliser orders by date, never the wire
  const key = fs.field;
  const label = labelOf(fs.field);

  if (readings.length === 0) {
    return {
      key,
      label,
      state: 'none',
      headline: null,
      detail: null,
      notes: [],
      comparison: NO_VERDICT,
      empty: emptyText,
      chart: null,
      readings: null,
    };
  }

  const newest = readings[readings.length - 1];
  const measured = isMeasured(newest);
  const latest = `Latest reading: ${shortDate(newest.date)}, ${describeAge(ageInDays(newest.date, ctx.now))}.`;

  const stale = isStale(newest.date, ctx.now);
  const notes: string[] = stale ? [staleNote(newest)] : [];
  if (!measured) {
    // The old number is a note, never the headline.
    const lastMeasured = [...readings].reverse().find(isMeasured);
    if (lastMeasured) {
      // Names what is counted: '3 of 4' on its own could be the right answers or the wrong ones.
      const fraction = describeRate(lastMeasured.hits, lastMeasured.n).fraction;
      notes.push(`Last score: ${fraction} matched.`);
    }
  }

  const points: ChartPoint[] = readings.map((r) => ({
    date: r.date,
    value: readingValue(r),
    n: r.n,
    label: pointLabel(r),
  }));

  return {
    key,
    label,
    state: measured ? 'measured' : 'not-measured',
    headline: measured ? measuredHeadline(fs.field, newest, stale) : notMeasuredHeadline(newest),
    detail: measured ? `Higher scores mean more matches. ${latest}` : latest,
    notes,
    comparison: NO_VERDICT,
    empty: null,
    chart: { points, cadenceDays: CADENCE_DAYS, marker: null, caption: COMMON.chartCaption },
    readings: { columns: TABLE_COLUMNS, rows: [...readings].reverse().map(tableRow) },
  };
}

/**
 * The whole card from one response. PURE: only `res` and `ctx` (ctx.now, ctx.aiAvailable).
 *
 * One series per field in `res.fields` order, so both fields always get a block even when
 * only one has rows. The headline of each is its NEWEST reading.
 */
export function classificationView(res: ClassificationAccuracyResponse, ctx: LearningContext): TileView {
  const fields = classificationSeries(res);
  const anyReading = fields.some((f) => f.readings.length > 0);
  // The newest date over both fields: the last time the weekly pass is known to have run.
  const dates = fields.flatMap((f) => f.readings.map((r) => r.date));
  const latestAnywhere = dates.reduce((a, b) => (daysBetween(a, b) > 0 ? b : a), dates[0] ?? '');
  const clearedOn = ctx.clearedOn?.classification;
  const cleared = anyReading && clearedSince(clearedOn, latestAnywhere);
  const evidence = evidenceLine(res);

  const series = fields.map((fs, i) =>
    // With no rows at all the long explanation is said once, on the first block, instead of
    // twice in a row; every other empty block keeps its own per-field sentence.
    fieldView(fs, ctx, !anyReading && i === 0 ? NO_ROWS_AT_ALL : noReadingYet(fs.field)),
  );

  return {
    series,
    // Only an exact false: null means "not known yet" and must show nothing.
    contextLines: [...(ctx.aiAvailable === false ? [AI_OFF] : []), ...(evidence ? [evidence] : [])],
    // The wire does not say how many examples are stored, so there is no status line, except
    // after a clear made this session, which it can state as a fact of its own.
    status: cleared
      ? `Cleared on ${shortDate(clearedOn as string)}. Monday’s update can rebuild examples.`
      : null,
    startOpen: !series.some((s) => s.state === 'measured'),
    // The wire does not report the example count either, so a reading is the best sign
    // that an index was built. A click can legitimately clear 0. Not after a clear since.
    resetAvailable: anyReading && !cleared,
  };
}

// ── The component ────────────────────────────────────────────────────────────

export function ClassificationTile(props: { context: LearningContext }) {
  const r = useReadout(() => api.learning.classificationAccuracy(LEARNING_LIMITS.classification));
  const view = createMemo(() => {
    const d = r.data();
    return d ? classificationView(d, props.context) : null;
  });
  return (
    <LearningCard
      loopKey="classification"
      title={TITLE}
      meaning={MEANING}
      changes={CHANGES}
      primaryCaveat={PRIMARY_CAVEAT}
      moreCaveats={MORE_CAVEATS}
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
