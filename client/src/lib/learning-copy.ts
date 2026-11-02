/**
 * Settings → Learning: the copy that two or more tiles (or the shared card frame) need.
 *
 * Per-loop copy does NOT live here; it lives in each tile file, so the four tiles never
 * edit one file. What does live here:
 *   - the server facts the copy quotes, in one place with a source per entry;
 *   - the shared strings;
 *   - the sentence builders for a rate and for a comparison;
 *   - the point and table-cell labels;
 *   - `copyProblems`, the sweep every test runs over what a card renders.
 *
 * Voice (uncloud-voice): sentence case, short declaratives, no em or en dashes, and the
 * words "examples", "reading", "kept" and "moved". Nothing here states a cause, says which
 * direction is good, or uses a colour word.
 */

import { shortDate } from './dates.js';
import {
  BLOCK_DAYS,
  MIN_N,
  formatPct,
  formatRange,
  wilsonRange,
  type Comparison,
  type Pooled,
  type Reading,
} from './learning-stats.js';

/**
 * Every server fact the copy quotes, with its source, so a server change has one grep
 * target on the client. Nothing computed depends on these; they only appear in sentences.
 * If one of them changes on the server and not here, the sentence is wrong, not the maths.
 */
export const LEARNING_FACTS = {
  // server/src/services/classification-learning.ts:
  //   CORRECTION_FLOOR, HELD_OUT_STRIDE, MAX_SCORED, LEARNING_WINDOW_DAYS, RETRIEVE_K
  classification: { correctionFloor: 2, heldOutStride: 4, maxScored: 20, windowDays: 90, retrieveK: 3 },
  // server/src/services/dismissal-learning.ts:
  //   DISMISSAL_FLOOR, RATE_PERIOD_DAYS, LEARNING_WINDOW_DAYS, RETRIEVE_K
  dismissal: { settledFloor: 5, periodDays: 7, windowDays: 90, retrieveK: 3 },
  // server/src/services/placement-learning.ts:
  //   CORRECTION_FLOOR, SURVIVAL_PERIOD_DAYS, PLACEMENT_WINDOW_DAYS, MAX_BAND_HOURS
  // and server/src/engine/scheduler.ts MAX_FRAGMENT_COST_MS (maxExtraFragmentMinutes)
  placement: { correctionFloor: 5, periodDays: 28, windowDays: 90, maxBandHours: 6, maxExtraFragmentMinutes: 60 },
  // server/src/agents/loop.ts DEFAULTS (passThreshold, maxIterations, judgeSamples),
  // server/src/services/plan-loop-learning.ts STATS_WINDOW_DAYS,
  // server/src/agents/plan.ts (fewer than 2 staged tasks stays deterministic)
  planLoop: { passMark: 0.8, maxTries: 3, judgeSamples: 3, periodDays: 7, minTasksToOrder: 2 },
} as const;

export const COMMON = {
  loading: 'Loading...',
  tryAgain: 'Try again',
  errorFailed: 'Could not load these readings. Try again in a moment.',
  errorOffline: 'Could not reach the server. Check your connection and try again.',
  errorUnsupported: 'This server does not report this yet. Update the server to see it.',
  // Said to a screen reader (not drawn) once a Try again has finished loading.
  loaded: 'Readings loaded.',
  showReadings: 'Show the readings',
  whatItCounts: 'What this counts and changes',
  moreAbout: 'More about this number',
  howItStarts: 'How it starts',
  notMeasured: 'not measured',
  readOnlyNote: 'Your account is read-only, so you can see this but not clear it.',
  forbiddenToast: 'This account can read learning but not clear it.',
  // A clear that failed. Fixed sentences, like the read errors: the server's own text and the
  // browser's transport text are never shown.
  clearFailed: 'Could not clear this. Try again in a moment.',
  clearOffline: 'Could not reach the server, so nothing was cleared. Check your connection and try again.',
  // Built from MIN_N, never a typed 10, so the caption and the dot rule cannot disagree.
  chartCaption: `Each dot is one weekly reading. A hollow dot has fewer than ${MIN_N} cases behind it. A dashed tick means the week was checked but nothing could be measured. A break means no reading was recorded.`,
} as const;

/**
 * A rate in words: the counts always, the percent and its range only at MIN_N cases or
 * more. fraction '3 of 4'; percent '75%'; range '46% to 92%'.
 *
 * Callers must not call this for a not-measured reading: there is no count to lead with.
 */
export function describeRate(hits: number, n: number): { fraction: string; percent: string | null; range: string | null } {
  const fraction = `${hits} of ${n}`;
  const range = n >= MIN_N ? wilsonRange(hits, n) : null;
  // No range means the counts were impossible (or too few), so no percent either.
  if (!range) return { fraction, percent: null, range: null };
  return { fraction, percent: formatPct(hits, n), range: formatRange(range) };
}

const TOO_FEW = (noun: string) =>
  `Not enough cases to compare yet. Each ${BLOCK_DAYS}-day period needs at least ${MIN_N} ${noun}.`;

/**
 * What went into one side of a comparison, so "the 28 days" is never claimed for fewer
 * readings than that: how many readings were pooled and the dates of the first and last.
 * A side built from three weekly readings, or from a reading 35 days back, says so.
 */
function sideNote(p: Pooled): string {
  const count = `${p.readings} ${p.readings === 1 ? 'reading' : 'readings'}`;
  if (p.readings === 1 || p.from === p.to) return `${count}, ${shortDate(p.to)}`;
  return `${count}, ${shortDate(p.from)} to ${shortDate(p.to)}`;
}

/**
 * The comparison sentence. It states a change, never a cause, never which direction is
 * good, and never uses colour. Built from the Comparison's own counts, so the sentence
 * cannot disagree with the maths that chose the verdict. Each side gives its counts, the
 * Wilson range those counts allow, and the readings it pools; a percent alone would
 * overstate what a few weeks of small numbers can show.
 *
 * unit: 'dismissed' | 'kept'. noun: 'decisions' | 'settled blocks'.
 */
export function describeComparison(c: Comparison, labels: { unit: string; noun: string }): string {
  const { latest, earlier, anchor } = c;
  if (c.verdict === 'too-few' || !latest || !earlier || !anchor) return TOO_FEW(labels.noun);
  const first =
    `The ${BLOCK_DAYS} days to ${shortDate(anchor)} (${sideNote(latest)}): ` +
    `${formatPct(latest.hits, latest.n)} ${labels.unit} (${latest.hits} of ${latest.n}, could be ${formatRange(latest.range)}).`;
  const second =
    `The ${BLOCK_DAYS} days before (${sideNote(earlier)}): ` +
    `${formatPct(earlier.hits, earlier.n)} (${earlier.hits} of ${earlier.n}, could be ${formatRange(earlier.range)}).`;
  const tail =
    c.verdict === 'no-clear-change'
      ? 'The ranges overlap, so this is no clear change. A gap this size could be chance.'
      : `That is ${c.verdict} by more than chance would explain. It shows a change, not the reason for it.`;
  return `${first} ${second} ${tail}`;
}

/**
 * The hover text for one chart point: 'Oct 19: 3 of 4', 'Oct 19: not measured'. A percent
 * appears only at MIN_N cases or more, and then with its range, like every other figure.
 */
export function pointLabel(r: Reading): string {
  const when = shortDate(r.date) || r.date;
  if (!r.measured || !(r.n > 0) || r.hits < 0 || r.hits > r.n) return `${when}: ${COMMON.notMeasured}`;
  const d = describeRate(r.hits, r.n);
  if (d.percent === null || d.range === null) return `${when}: ${d.fraction}`;
  return `${when}: ${d.fraction} (${d.percent}, could be ${d.range})`;
}

/** The Share cell of a readings table: a percent at MIN_N cases or more, 'under 10 cases'
 *  for a measured reading below that, 'not measured' otherwise. */
export function shareCell(r: Reading): string {
  if (!r.measured || !(r.n > 0) || r.hits < 0 || r.hits > r.n) return COMMON.notMeasured;
  if (r.n < MIN_N) return `under ${MIN_N} cases`;
  return formatPct(r.hits, r.n);
}

/** Wording the panel must never use: it claims more than a reading can show. */
const BANNED: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\u2014/, what: 'em dash' },
  { re: /\u2013/, what: 'en dash' },
  { re: /improv/i, what: 'improv...' },
  { re: /smarter/i, what: 'smarter' },
  { re: /getting better/i, what: 'getting better' },
  { re: /is working/i, what: 'is working' },
  { re: /the direction you want/i, what: 'the direction you want' },
  { re: /\bproves\b/i, what: 'proves' },
];

/**
 * Test helper: the violations found in a piece of rendered or built copy, empty when it is
 * clean. Flags em and en dashes and the banned stems above (case-insensitive). 'does not
 * prove' is allowed.
 */
export function copyProblems(text: string): string[] {
  return BANNED.filter((b) => b.re.test(text)).map((b) => b.what);
}
