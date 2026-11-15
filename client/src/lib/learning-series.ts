/**
 * Settings → Learning: the four wire shapes, normalised to one `Reading[]`.
 *
 * Pure: no Solid, no DOM. Type-only imports from lib/api.ts.
 *
 * Every normaliser returns readings ASCENDING by date, whatever order the wire used. The
 * four endpoints do not agree (dismissal is OLDEST first, the other three NEWEST first),
 * and a tile that trusted the wire order would show an old week as the latest. So order is
 * decided here, once, by the date itself.
 *
 * The "measured" rule is applied here too, once: a reading is measured only when the wire
 * rate is a finite number in 0..1 AND n > 0 AND 0 <= hits <= n. A null rate, an n of 0, a
 * rate outside 0..1 or more hits than cases all become "not measured", with the counts
 * kept as counts. A real zero (rate 0 with n 12) stays measured.
 *
 * Rows with an unparseable date are dropped. Rows that repeat a date for the same field or
 * stage are not expected (the tables are unique on them); if one shows up, the last wins.
 */

import type {
  ClassificationAccuracyResponse,
  DismissalTrendResponse,
  PlacementSurvivalResponse,
  PlanLoopTrendResponse,
} from './api.js';
import { localISODate } from './dates.js';
import { dayNumber, daysBetween, STALE_AFTER_DAYS, type Reading } from './learning-stats.js';

// The date helpers are implemented once, in the leaf module, and shared from here.
export { dayNumber, daysBetween };

export interface FieldSeries {
  field: string;
  readings: Reading[];
}

export interface StageSeries {
  stage: string;
  readings: Reading[];
}

/** Classification looks back 90 days of corrections each week. It is the evidence window,
 *  not a period that readings could be pooled over (they never are). */
const CLASSIFICATION_EVIDENCE_DAYS = 90;
/** Used only when a wire row has no usable period_days. */
const FALLBACK_PERIOD = { dismissal: 7, placement: 28, planLoop: 7 } as const;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A count off the wire: a finite number, else 0. */
const count = (v: unknown): number => (finite(v) ? v : 0);
const periodOf = (v: unknown, fallback: number): number => (finite(v) && v > 0 ? v : fallback);

interface RowInput {
  date: unknown;
  periodDays: number;
  n: unknown;
  hits: unknown;
  rate: unknown;
  influence?: unknown;
  extra: Record<string, number | null>;
}

/** One wire row to one Reading, or null when its date cannot be read. */
function toReading(row: RowInput): Reading | null {
  if (typeof row.date !== 'string') return null;
  const date = row.date.slice(0, 10);
  if (dayNumber(date) === null) return null;
  const n = count(row.n);
  const hits = count(row.hits);
  const rate = row.rate;
  const measured =
    finite(rate) && rate >= 0 && rate <= 1 && n > 0 && hits >= 0 && hits <= n;
  const reading: Reading = { date, periodDays: row.periodDays, n, hits, measured, extra: row.extra };
  if (row.influence !== undefined) reading.influence = row.influence ? 1 : 0;
  return reading;
}

/** Ascending by date; the last row wins when two share a date. */
function ascending(readings: Array<Reading | null>): Reading[] {
  const byDate = new Map<string, Reading>();
  for (const r of readings) if (r) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => (dayNumber(a.date) as number) - (dayNumber(b.date) as number));
}

const alphabetical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One series per field, in `res.fields` order, then any other field found in the rows
 * (alphabetical). A field with no rows has `readings: []`; that is not the same as a row
 * with a null accuracy (a field under the 2-correction floor writes NO row). Fields are
 * never merged.
 *
 * n = held_out (answers actually scored), hits = correct. extra = {}.
 */
export function classificationSeries(res: ClassificationAccuracyResponse): FieldSeries[] {
  const runs = Array.isArray(res?.runs) ? res.runs : [];
  const fields: string[] = Array.isArray(res?.fields) ? res.fields.map(String) : [];
  const extras = [...new Set(runs.map((r) => String(r.field)))].filter((f) => !fields.includes(f)).sort(alphabetical);
  return [...fields, ...extras].map((field) => ({
    field,
    readings: ascending(
      runs
        .filter((r) => String(r.field) === field)
        .map((r) =>
          toReading({
            date: r.computed_date,
            periodDays: CLASSIFICATION_EVIDENCE_DAYS,
            n: r.held_out,
            hits: r.correct,
            rate: r.accuracy,
            extra: {},
          }),
        ),
    ),
  }));
}

/**
 * n = decided, hits = dismissed, influence = hinted, extra = { exemplars }.
 *
 * `created` is dropped on purpose: it counts every suggestion from every source,
 * including the ones that are added automatically and can never be decided, so it is not
 * the denominator of this rate and nothing here may print it.
 */
export function dismissalSeries(res: DismissalTrendResponse): Reading[] {
  const rows = Array.isArray(res?.trend) ? res.trend : [];
  return ascending(
    rows.map((r) =>
      toReading({
        date: r.computed_date,
        periodDays: periodOf(r.period_days, FALLBACK_PERIOD.dismissal),
        n: r.decided,
        hits: r.dismissed,
        rate: r.rate,
        influence: r.hinted,
        extra: { exemplars: count(r.exemplars) },
      }),
    ),
  );
}

/** n = decided, hits = accepted, influence = biased, extra = { corrected, keys_learned }. */
export function placementSeries(res: PlacementSurvivalResponse): Reading[] {
  const rows = Array.isArray(res?.runs) ? res.runs : [];
  return ascending(
    rows.map((r) =>
      toReading({
        date: r.computed_date,
        periodDays: periodOf(r.period_days, FALLBACK_PERIOD.placement),
        n: r.decided,
        hits: r.accepted,
        rate: r.survival_rate,
        influence: r.biased,
        extra: { corrected: count(r.corrected), keys_learned: count(r.keys_learned) },
      }),
    ),
  );
}

/**
 * Grouped by stage (alphabetical; an unknown stage keeps its raw name). n = runs,
 * hits = passed, extra = { escaped, first_try_pass, avg_iterations }. avg_iterations stays
 * null when the wire has none; it is never turned into 0.
 */
export function planLoopSeries(res: PlanLoopTrendResponse): StageSeries[] {
  const rows = Array.isArray(res?.runs) ? res.runs : [];
  const stages = [...new Set(rows.map((r) => String(r.stage)))].sort(alphabetical);
  return stages.map((stage) => ({
    stage,
    readings: ascending(
      rows
        .filter((r) => String(r.stage) === stage)
        .map((r) =>
          toReading({
            date: r.computed_date,
            periodDays: periodOf(r.period_days, FALLBACK_PERIOD.planLoop),
            n: r.runs,
            hits: r.passed,
            rate: r.pass_rate,
            extra: {
              escaped: count(r.escaped),
              first_try_pass: count(r.first_try_pass),
              avg_iterations: finite(r.avg_iterations) ? r.avg_iterations : null,
            },
          }),
        ),
    ),
  }));
}

// ── Age ──────────────────────────────────────────────────────────────────────

/**
 * Whole calendar days from a reading date to the browser's local today. Both sides are
 * compared as calendar dates, so a reading dated today is 0 at any hour. A future-dated
 * reading is negative; describeAge reads that as 'today'.
 */
export function ageInDays(date: string, now: Date): number {
  return daysBetween(date, localISODate(now));
}

/** 'today' (also for 0 or negative) | 'yesterday' | 'N days ago'. */
export function describeAge(days: number): string {
  if (!Number.isFinite(days)) return 'date unknown';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** True once the newest reading is older than STALE_AFTER_DAYS (flips at 10 days, not 9).
 *  An unreadable date is not called stale. */
export function isStale(date: string, now: Date): boolean {
  return ageInDays(date, now) > STALE_AFTER_DAYS;
}
