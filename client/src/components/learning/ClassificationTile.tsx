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
  formatPct,
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

const TITLE = 'Category and motivation guesses';

const ordinal = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

const MEANING =
  "What it counts: when your local model fills in a task's category, or who it is for (me, us, them), " +
  'the app logs the guess, and a change you make is a correction. ' +
  `Once a week (early on Monday, server time) it builds a set of examples from your corrections in the last ${F.windowDays} days, ` +
  `holds back every ${ordinal(F.heldOutStride)} correction, ` +
  `asks the model about up to ${F.maxScored} of the held-back ones per field using the examples it just built, ` +
  'and counts how many answers match what you chose. ' +
  'Cases behind it: the held-back count printed in every line, often 1 to 5 early on. ' +
  'Direction: higher is better.';

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
const MEMORY_FILL_IN = 'It runs only when Companion Memory is connected and finds something related to the task.';

const CHANGES =
  'What it changes: your past corrections reach the model in three places. ' +
  `The Describe-it line in the Add dialog (and quick add through the API) shows up to ${F.retrieveK} of the corrections you make most often, ` +
  'for each field, at the end of its prompt, whatever you typed. ' +
  'This needs no Companion Memory, and it is sent only when the model answering is one that was tested with it ' +
  '(gemma3n:e4b, qwen2.5:3b and gemma3:4b; the others tried answered worse), so on any other model the prompt is the usual one. ' +
  'The category part needs the model to name one of your categories, as a list or as one word; ' +
  'an answer that names none of them gives nothing to learn from. ' +
  `The fill-in from memory (the "Fill in details from memory" button and the nightly fill-in) shows up to ${F.retrieveK} corrections that look like the task, ` +
  'or your most frequent ones with no embedding model. ' +
  `${MEMORY_FILL_IN} ` +
  "The third is Monday's test, described above. " +
  `Nothing changes before the next Monday run, and a field starts after ${F.correctionFloor} corrections it can learn from; ` +
  'a category you clear is kept but not learned from. ' +
  'The model never overwrites a value you already filled in.';

// Deliberately NOT "the stock model got it wrong the first time". The model that made the
// first guess is not always a stock one: services/task-enrich.ts puts the current examples
// in the prompt BEFORE the guess that is logged, so once an index exists a later correction
// is a miss by the model WITH examples. What is true for every held-back case is that the
// first guess was not what the owner chose.
const PRIMARY_CAVEAT =
  "Every held-back case is a task where the model's first guess was not what you chose, so these are the hard ones. " +
  'A high score means the model now answers the way you corrected it. ' +
  'It cannot show that the examples helped, because nothing was measured without them, ' +
  'and it does not show the model is right in general. ' +
  'It is also not a score of the Describe-it line, which asks the model a longer question.';

// Built from wilsonRange, never typed, so the example cannot drift from the maths.
const SMALL_NUMBERS_RANGE = formatRange(wilsonRange(3, 4) ?? { lo: 0, hi: 1 });

const MORE_CAVEATS: readonly string[] = [
  'The score is over the answers the model actually gave. ' +
    'A call that failed or returned nothing is skipped, not counted as wrong, ' +
    'so the count behind a reading can be lower than the number of corrections held back. ' +
    'A category answer counts only when it matches your whole choice, in the same order.',
  'The test asks one narrow question for each held-back correction, the category or me/us/them, in the same words every time, ' +
    'with examples picked by how closely they match the task (your most frequent ones with no embedding model). ' +
    'The Describe-it line asks a longer question with your most frequent corrections at the end, and the memory fill-in adds what Companion Memory found. ' +
    'So this number is not a score of either, and it is not a recording of what the app did on your tasks.',
  'Answers it already gets right are not tested, so this cannot show whether the examples made any of those worse. ' +
    'The same question asked twice can also come out differently, so one weekly score has some noise of its own.',
  `The test questions change. Each week's test is every ${ordinal(F.heldOutStride)} correction from the last ${F.windowDays} days; ` +
    'many repeat from one week to the next and the set shifts as corrections arrive or age out. ' +
    'Readings from different weeks are not independent, so they are never added together or compared.',
  `Small numbers. At most ${F.maxScored} corrections are scored per field per week, and early on it is 1 to 5. ` +
    `3 right out of 4 looks like ${formatPct(3, 4)}, but the true figure could be anywhere from about ${SMALL_NUMBERS_RANGE}. ` +
    `That is why a percent appears only at ${MIN_N} or more cases.`,
  'It is about tasks like the ones you corrected. It says nothing about tasks unlike them.',
  "A 'not measured' week, or a week with no reading, is not a bad week. It means nothing could be scored.",
];

const HOW_TO_START =
  'Change a category the Describe-it line picked (before you press Add, or later on the task), ' +
  'or a category or me/us/them label the app filled in from memory. ' +
  'A value you typed yourself on a task the app did not guess is not a correction, and the Add dialog does not record who a task is for. ' +
  `Within ${F.windowDays} days, ${F.correctionFloor} corrections of one kind start the examples. ` +
  `With ${F.heldOutStride}, the weekly test can hold one back and score it. ` +
  "Nothing reaches a prompt until Monday's run has built the examples. " +
  'The score also needs your local model (Ollama) running early on Monday; the examples themselves do not. ' +
  'The Describe-it line needs no Companion Memory. The fill-in from memory does, and Companion Memory is connected under Settings → Connections. ' +
  'There is no switch to start it earlier and no setting that turns it off.';

const NO_VERDICT =
  'No week-to-week verdict is given here. ' +
  'The test questions change between weeks, so a verdict would not mean what it says.';

// "Not ready", not "not reachable": the flag behind this is false both when Ollama is down and
// when it is running without the models this needs (lib/ollama-health.ts), and the second
// case is not "unreachable".
const AI_OFF =
  "Your local model is not ready right now. New guesses are not being made and Monday's test cannot be scored.";

const NO_ROWS_AT_ALL =
  'No readings yet. ' +
  `A reading appears after the weekly pass (early on Monday, server time) finds at least ${F.correctionFloor} of your corrections in the last ${F.windowDays} days. ` +
  'Until then the model is shown no examples of your choices and nothing is measured.';

const TABLE_COLUMNS = ['Date', 'Right', 'Scored', 'Share'];

// ── Reset ────────────────────────────────────────────────────────────────────

const RESET: ResetSpec = {
  label: 'Clear learned examples',
  hint:
    'Removes the examples shown to the model, for category and motivation. ' +
    "Your corrections are kept, so Monday's pass builds the examples again from them. " +
    'Past readings stay, and they describe the old examples. ' +
    'There is no setting that turns this learning off.',
  confirmText:
    'Clear the learned examples for category and motivation guesses? ' +
    'Your corrections are kept and will be used again on Monday.',
  run: () => api.learning.resetClassification(),
  clearedMessage: (n) =>
    n === 1
      ? 'Cleared 1 learned example. It is rebuilt from your corrections on Monday.'
      : `Cleared ${n} learned examples. They are rebuilt from your corrections on Monday.`,
  emptyMessage: 'Nothing to clear. No learned examples are stored.',
  doneStatus: "Cleared. The model is shown no examples until Monday's pass.",
  nothingToClear: 'No learned examples are stored, so there is nothing to clear.',
};

// ── The pure builder ─────────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = { category: 'Category', motivation: 'Motivation (me, us, them)' };
const FIELD_SHORT: Record<string, string> = { category: 'Category', motivation: 'Motivation' };
const labelOf = (field: string): string => FIELD_LABEL[field] ?? field;
const shortOf = (field: string): string => FIELD_SHORT[field] ?? field;

/** Only readingValue decides "measured": it re-checks the counts, so a corrupt row is never a number. */
const isMeasured = (r: Reading): boolean => readingValue(r) !== null;

function noReadingYet(field: string): string {
  return `${shortOf(field)}: no reading yet. It needs at least ${F.correctionFloor} corrections of this kind in the last ${F.windowDays} days.`;
}

/** Fraction first. A percent only at MIN_N scored cases, and then always with its range.
 *  A stale reading is called the "last reading", so it is not taken for this week's. */
function measuredHeadline(field: string, r: Reading, stale: boolean): string {
  const d = describeRate(r.hits, r.n);
  const when = shortDate(r.date);
  const reading = stale ? `last reading, ${when}` : `reading of ${when}`;
  if (d.percent === null || d.range === null) {
    const noun = r.n === 1 ? 'correction' : 'corrections';
    return `${shortOf(field)}: ${d.fraction} held-back ${noun} answered the way you chose (${reading}).`;
  }
  return (
    `${shortOf(field)}: ${d.percent} (${d.fraction}) of held-back corrections answered the way you chose (${reading}). ` +
    `With this many cases the true figure could be anywhere from ${d.range}.`
  );
}

function notMeasuredHeadline(r: Reading): string {
  return (
    `Not measured on ${shortDate(r.date)}. The weekly test could not score anything. ` +
    'That happens when your local model was off or did not answer, or when there were too few corrections to hold one back. ' +
    'The app does not record which.'
  );
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
function staleNote(newest: Reading, latestAnywhere: string): string {
  const since = `No reading since ${shortDate(newest.date)}.`;
  const floor = `${F.correctionFloor} corrections in the last ${F.windowDays} days`;
  if (daysBetween(newest.date, latestAnywhere) > 0) {
    return `${since} The weekly pass has run since, and this field had fewer than ${floor}, so its examples were removed.`;
  }
  return `${since} Either the weekly pass has not run, or this field has fewer than ${floor} and its examples were removed.`;
}

function fieldView(fs: FieldSeries, ctx: LearningContext, emptyText: string, latestAnywhere: string): SeriesView {
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
  const latest = `Latest reading: ${shortDate(newest.date)} (${describeAge(ageInDays(newest.date, ctx.now))}).`;

  const stale = isStale(newest.date, ctx.now);
  const notes: string[] = stale ? [staleNote(newest, latestAnywhere)] : [];
  if (!measured) {
    // The old number is a note, never the headline.
    const lastMeasured = [...readings].reverse().find(isMeasured);
    if (lastMeasured) {
      // Names what is counted: '3 of 4' on its own could be the right answers or the wrong ones.
      const noun = lastMeasured.n === 1 ? 'correction' : 'corrections';
      const fraction = describeRate(lastMeasured.hits, lastMeasured.n).fraction;
      notes.push(`Last measured: ${fraction} held-back ${noun} answered the way you chose, on ${shortDate(lastMeasured.date)}.`);
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
    detail: measured ? `Higher is better. ${latest}` : latest,
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

  const series = fields.map((fs, i) =>
    // With no rows at all the long explanation is said once, on the first block, instead of
    // twice in a row; every other empty block keeps its own per-field sentence.
    fieldView(fs, ctx, !anyReading && i === 0 ? NO_ROWS_AT_ALL : noReadingYet(fs.field), latestAnywhere),
  );

  return {
    series,
    // Only an exact false: null means "not known yet" and must show nothing.
    contextLines: ctx.aiAvailable === false ? [AI_OFF] : [],
    // The wire does not say how many examples are stored, so there is no status line, except
    // after a clear made this session, which it can state as a fact of its own.
    status: cleared
      ? `Cleared on ${shortDate(clearedOn as string)}. The model is shown no examples until Monday's pass.`
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
