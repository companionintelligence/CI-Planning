/**
 * Settings → Learning: the "AI day ordering checks" card.
 *
 * What it reads: GET /api/plan-loop/trend. Each Monday the server rolls the plan loop's
 * finished runs of the last 7 days into one row per stage (today only 'order'). A week with
 * no runs gets NO row, so the only gap shape in practice is a break in the line. The server
 * never writes a row with a null rate; a null row is still drawn as a dashed tick, because
 * a card that trusts the server is a card that shows 0% the day the server changes.
 *
 * What this card deliberately does NOT have, and why:
 *   - no "higher is better" or any other direction word, and no colour: the pass rate is a
 *     model grading a model, not something the owner did or chose;
 *   - no comparison and no marker: nothing in this loop changes behaviour, so there is no
 *     before and after to compare;
 *   - no reset: the server has no route for it, by design (docs/factory/revision-loop-wave,
 *     "Decisions of record"), and the client must not invent one;
 *   - no stale line: a quiet week legitimately writes nothing.
 *
 * Rows arrive newest first, then by stage, and `limit` counts rows across stages. The
 * normaliser (lib/learning-series.ts) sorts and groups, so this file never trusts the wire
 * order. The headline is always the NEWEST reading of its stage.
 *
 * Everything the card says lives in this file, so the four tiles never edit one file. The
 * builder `planLoopView` is pure: only the response and the context go in, nothing is read
 * from a signal or fetched.
 */

import { createMemo } from 'solid-js';
import { api } from '../../lib/api.js';
import type { PlanLoopTrendResponse } from '../../lib/api.js';
import { shortDate } from '../../lib/dates.js';
import { COMMON, LEARNING_FACTS, describeRate, pointLabel } from '../../lib/learning-copy.js';
import { ageInDays, describeAge, planLoopSeries, type StageSeries } from '../../lib/learning-series.js';
import { CADENCE_DAYS, LEARNING_LIMITS, MIN_N, readingValue, type Reading } from '../../lib/learning-stats.js';
import { LearningCard, type LearningContext, type SeriesView, type TileView } from './LearningCard.js';
import { useReadout } from './useReadout.js';

const FACTS = LEARNING_FACTS.planLoop;

/** The name each stage goes by in the UI. An unknown stage prints its raw name. */
export const STAGE_LABEL: Readonly<Record<string, string>> = {
  order: 'Day order',
};

/** Own-property lookup, so a stage called 'constructor' cannot pick up Object.prototype. */
function stageLabel(stage: string): string {
  return Object.prototype.hasOwnProperty.call(STAGE_LABEL, stage) ? STAGE_LABEL[stage] : stage;
}

// ── Copy ─────────────────────────────────────────────────────────────────────

const TITLE = 'AI day ordering checks';

const MEANING =
  `Each time AI day ordering orders your day, one model call writes the order and a second call scores it ${FACTS.judgeSamples} times, ` +
  `and the middle score counts. The plan passes when it breaks none of the fixed rules and that score is at least ${FACTS.passMark} out of 1. ` +
  `If it has not passed after ${FACTS.maxTries} tries, or the score barely moves between tries, or the call budget runs out, ` +
  'the app gives up and uses the plain rule-based order. ' +
  `A reading is added early on Monday (server time) and counts the plans finished in the ${FACTS.periodDays} days before it: ` +
  'plans checked, passed, passed on the first try, gave up, and average tries.';

const CHANGES =
  'This changes nothing about how plans are made. It is a readout for a person to read, and no part of it adjusts the next plan.';

/** The first entry is the one that is always visible; the rest sit under "More about this number". */
const CAVEATS: readonly string[] = [
  `A model is checking another model's work. The writer and the checker are separate calls, and they can be the same model. ` +
    'Nothing here records whether you kept or changed the plan, so this cannot say whether plans are good for you.',
  `Passing means the checker was satisfied. A stricter or looser scoring prompt would give a different rate for the same plans, ` +
    `so the rate is comparable only with itself, and only while the prompt and the ${FACTS.passMark} pass mark stay the same.`,
  'Only finished runs are counted. A run that stopped with an error before it finished may not appear here at all.',
  'Days planned with the plain rule-based order (AI day ordering off, or no model available) are not counted.',
  `A week with fewer than ${MIN_N} plans is a small sample, and is drawn as a hollow dot. One week's share can swing a lot on so few plans.`,
  'Only the day-order step is measured today.',
  'A week with no reading is a week with no plans checked, not a bad week.',
];

const HOW_TO_START =
  'Turn on AI day ordering (Settings → Preferences; the switch only shows when your local model, Ollama, is reachable, so start Ollama first), ' +
  `then plan your day as usual. A day needs at least ${FACTS.minTasksToOrder} tasks waiting to be placed before a model order is written. ` +
  'A reading appears on the next Monday for any week in which at least one plan was written that way. ' +
  'Nothing else is needed and there is nothing to configure.';

const NO_RESET_NOTE =
  'Nothing to clear. This readout does not change how plans are made, so there is nothing learned to remove.';

const EMPTY =
  'No readings yet. A week gets a reading only if AI day ordering produced at least one plan that week. ' +
  'Nothing here means nothing was checked; it does not mean plans were bad.';

const SMART_OFF_LINE = 'AI day ordering is off, so no new plans are being checked.';
// "Not ready", not "not reachable": the flag behind this is false when Ollama is down and also when
// it is running without the models this needs, and the second case is not "unreachable".
const MODEL_OFF_LINE = 'Your local model is not ready right now, so no new plans are being checked.';

const TABLE_COLUMNS = ['Date', 'Plans checked', 'Passed', 'First try', 'Gave up', 'Average tries'];
const NOT_RECORDED = 'not recorded';

// ── Building blocks ──────────────────────────────────────────────────────────

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const plansWord = (n: number) => (n === 1 ? 'plan' : 'plans');

interface Extras {
  /** null = not reported, or it contradicts the headline count, so it is left out. */
  firstTry: number | null;
  gaveUp: number | null;
  /** null = not recorded. Never turned into 0. A real average of tries cannot be 0 or less. */
  avgTries: number | null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The columns beyond passed and runs. Each is dropped (null) when it cannot be right:
 * more first-try passes than passes, or a "gave up" count that does not bring passed plus
 * gave up back to the number of plans. A sentence that contradicts the headline beside it
 * is worse than a missing sentence. The server guarantees passed + escaped = runs, so for
 * real data nothing is dropped.
 */
function extrasOf(r: Reading): Extras {
  const firstTry = r.extra.first_try_pass;
  const gaveUp = r.extra.escaped;
  const avg = r.extra.avg_iterations;
  return {
    firstTry: isCount(firstTry) && firstTry <= r.hits ? firstTry : null,
    gaveUp: isCount(gaveUp) && r.hits + gaveUp === r.n ? gaveUp : null,
    avgTries: typeof avg === 'number' && Number.isFinite(avg) && avg > 0 ? avg : null,
  };
}

const oneDecimal = (v: number) => v.toFixed(1);

function measuredHeadline(label: string, r: Reading): string {
  const rate = describeRate(r.hits, r.n);
  const span = days(r.periodDays);
  const when = shortDate(r.date);
  const parts: string[] = [];
  if (rate.percent !== null && rate.range !== null) {
    parts.push(
      `${label}: ${rate.percent} passed (${rate.fraction} ${plansWord(r.n)}) in the ${span} to ${when}.`,
      `With this many cases the true figure could be anywhere from ${rate.range}.`,
    );
  } else {
    parts.push(`${label}: ${rate.fraction} ${plansWord(r.n)} passed the checker in the ${span} to ${when}.`);
  }
  const x = extrasOf(r);
  if (x.firstTry !== null) parts.push(`${x.firstTry} passed on the first try.`);
  if (x.gaveUp !== null) parts.push(`${x.gaveUp} gave up and used the plain order.`);
  parts.push(x.avgTries !== null ? `Average tries per plan: ${oneDecimal(x.avgTries)}.` : 'Average tries: not recorded.');
  return parts.join(' ');
}

function notMeasuredHeadline(r: Reading): string {
  const span = days(r.periodDays);
  const when = shortDate(r.date);
  // n of 0 is the real "nothing was checked". A row that counts plans but has no usable
  // rate is a different thing, and saying "no plans were checked" about it would be false.
  return r.n === 0
    ? `Not measured: no plans were checked in the ${span} to ${when}.`
    : `Not measured: the figures for the ${span} to ${when} could not be read.`;
}

/** The newest measured reading before the newest one, as a note. Null when there is none. */
function lastMeasuredNote(readings: Reading[]): string | null {
  for (let i = readings.length - 2; i >= 0; i--) {
    const r = readings[i];
    if (!r.measured) continue;
    return `Last measured: ${describeRate(r.hits, r.n).fraction} ${plansWord(r.n)} passed on ${shortDate(r.date)}.`;
  }
  return null;
}

function chartCaption(readings: Reading[], periodDays: number): string {
  const parts = [
    `Each dot is one weekly reading of the plans checked in the ${days(periodDays)} before it.`,
    `A hollow dot has fewer than ${MIN_N} plans behind it.`,
    'Blank stretches are weeks with no plans checked.',
  ];
  // Only when one is actually drawn: the server does not write such a row today.
  if (readings.some((r) => !r.measured)) parts.push('A dashed tick marks a reading with nothing measured in it.');
  return parts.join(' ');
}

/** Newest first. Counts stay counts; a reading that was not measured says so in every cell
 *  that could be mistaken for a measurement. */
function tableRows(readings: Reading[]): { key: string; cells: string[] }[] {
  return [...readings].reverse().map((r) => {
    const when = shortDate(r.date) || r.date;
    if (!r.measured) {
      return {
        key: r.date,
        cells: [when, String(r.n), COMMON.notMeasured, COMMON.notMeasured, COMMON.notMeasured, COMMON.notMeasured],
      };
    }
    const x = extrasOf(r);
    return {
      key: r.date,
      cells: [
        when,
        String(r.n),
        String(r.hits),
        x.firstTry === null ? NOT_RECORDED : String(x.firstTry),
        x.gaveUp === null ? NOT_RECORDED : String(x.gaveUp),
        x.avgTries === null ? NOT_RECORDED : oneDecimal(x.avgTries),
      ],
    };
  });
}

function seriesView(s: StageSeries, labelled: boolean, ctx: LearningContext): SeriesView {
  const newest = s.readings[s.readings.length - 1];
  const label = stageLabel(s.stage);
  const measured = newest.measured;
  return {
    key: s.stage,
    // The stage name leads the headline. A separate sub-heading is only needed to tell
    // several stages apart.
    label: labelled ? label : null,
    state: measured ? 'measured' : 'not-measured',
    headline: measured ? measuredHeadline(label, newest) : notMeasuredHeadline(newest),
    // No "higher is better" here, on purpose: a model is grading a model.
    detail: `Latest reading: ${shortDate(newest.date)} (${describeAge(ageInDays(newest.date, ctx.now))}).`,
    notes: measured ? [] : [lastMeasuredNote(s.readings)].filter((n): n is string => n !== null),
    comparison: null,
    empty: null,
    chart: {
      points: s.readings.map((r) => ({ date: r.date, value: readingValue(r), n: r.n, label: pointLabel(r) })),
      cadenceDays: CADENCE_DAYS,
      marker: null,
      caption: chartCaption(s.readings, newest.periodDays),
    },
    readings: { columns: TABLE_COLUMNS, rows: tableRows(s.readings) },
  };
}

/** The one block shown when the server has sent no usable row at all. */
function emptySeries(): SeriesView {
  return {
    key: 'order',
    label: null,
    state: 'none',
    headline: null,
    detail: null,
    notes: [],
    comparison: null,
    empty: EMPTY,
    chart: null,
    readings: null,
  };
}

/**
 * The whole card as data. Pure: only `res` and `ctx` go in. A stage is a block of its own
 * and is never merged with another. A stage whose rows all had unreadable dates is treated
 * as absent, and no stage at all gives the empty state.
 */
export function planLoopView(res: PlanLoopTrendResponse, ctx: LearningContext): TileView {
  const stages = planLoopSeries(res).filter((s) => s.readings.length > 0);
  const series = stages.length > 0 ? stages.map((s) => seriesView(s, stages.length > 1, ctx)) : [emptySeries()];

  // Each line only when it is known. null (still loading, or unknown) shows nothing.
  const contextLines: string[] = [];
  if (ctx.smartMode === false) contextLines.push(SMART_OFF_LINE);
  if (ctx.aiAvailable === false) contextLines.push(MODEL_OFF_LINE);

  return {
    series,
    contextLines,
    status: null,
    startOpen: !series.some((s) => s.state === 'measured'),
    // There is nothing to clear in this loop, by design.
    resetAvailable: false,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function PlanLoopTile(props: { context: LearningContext }) {
  const r = useReadout(() => api.learning.planLoopTrend(LEARNING_LIMITS.planLoop));
  const view = createMemo(() => {
    const d = r.data();
    return d ? planLoopView(d, props.context) : null;
  });
  return (
    <LearningCard
      loopKey="planloop"
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
      noResetNote={NO_RESET_NOTE}
    />
  );
}
