/**
 * Recurrence engine (Phase E, PR-1).
 *
 * Hard rule, repeated everywhere: **rrule.js computes the recurrence pattern;
 * `lib/tz.ts` computes every wall-clock→UTC instant.** rrule.js pins occurrences
 * to the DTSTART clock and is easy to misuse across DST — the codebase's DST
 * contract lives in `tz.ts`, so we never hand an IANA zone to rrule.js and expect
 * it to honour the transition. Instead we:
 *   - anchor the rule's DTSTART at local *noon* (in UTC) so the ±1h DST wobble
 *     around midnight can never flip a hit onto the wrong local calendar day,
 *   - re-derive each hit's LOCAL calendar date with the same Intl formatter
 *     pattern `tz.ts` uses,
 *   - resolve the concrete start instant of an instance through
 *     `zonedWallTimeToUTC`.
 *
 * No DB writes, no generation job here — PR-1 ships the deterministic expander
 * only. The generation job (PR-2) consumes `occurrencesBetween` / `instanceStartUTC`.
 */
import { RRule, rrulestr } from 'rrule';
import { zonedWallTimeToUTC, utcDayBounds } from '../lib/tz.js';

export interface Template {
  recurrenceRule: string; // e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR'
  recurrenceDtstart: string; // UTC ISO anchor of the series
  taskTime: string | null; // 'HH:MM' wall-clock start, or null (all-day-ish)
  recurrenceExdates: string[]; // local YYYY-MM-DD already excluded / skipped
  timezone: string; // IANA zone the occurrences live in
}

export interface RuleError {
  ok: false;
  error: string;
}
export interface RuleOk {
  ok: true;
  /** Normalized RRULE line (no DTSTART), round-tripped through rrule.js. */
  rule: string;
}
export type ParseResult = RuleOk | RuleError;

/** Frequencies we explicitly refuse — sub-daily recurrence is out of scope. */
const FORBIDDEN_FREQ = new Set(['HOURLY', 'MINUTELY', 'SECONDLY']);

/**
 * Horizon ceiling (days). A COUNT/UNTIL that would span more than this is capped
 * at validation time so a stored rule can't ask the generator for an unbounded
 * sweep. Generous — the generation job's own HORIZON_DAYS (PR-2) is the real cap;
 * this is defense in depth at the parse boundary.
 */
export const MAX_SPAN_DAYS = 366 * 5; // ~5 years

const _fmt = new Map<string, Intl.DateTimeFormat>();
/** Same formatter pattern as lib/tz.ts, scoped to date parts. */
function dateFormatter(tz: string): Intl.DateTimeFormat {
  let f = _fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    _fmt.set(tz, f);
  }
  return f;
}

/** The LOCAL calendar date (YYYY-MM-DD) of a UTC instant in `tz`. Intl-based. */
function localDateOf(d: Date, tz: string): string {
  // en-CA renders ISO-ish YYYY-MM-DD; normalize defensively regardless of engine.
  const parts = dateFormatter(tz).formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * RRule wants DTSTART as a floating `YYYYMMDDTHHMMSSZ` token. We anchor it at the
 * series' *local* date at noon, expressed in UTC — noon keeps every hit a safe
 * ~12h away from the local midnight boundary, so a DST flip never moves a hit's
 * derived local date. The wall-clock start time of an instance is applied later
 * via `instanceStartUTC` (the sanctioned tz path), not here.
 */
function dtstartToken(dtstartUTC: string, tz: string): string {
  const localDay = localDateOf(new Date(dtstartUTC), tz); // YYYY-MM-DD
  const noonUTC = zonedWallTimeToUTC(localDay, '12:00', tz); // UTC ISO
  return noonUTC.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // YYYYMMDDTHHMMSSZ
}

/**
 * Local YYYY-MM-DD occurrences in the inclusive local-day window
 * [fromDate, toDate], honouring EXDATE. Deterministic: the only clock inputs are
 * the explicit window bounds. Throws on a malformed rule (callers that take
 * untrusted input should `parseRule` first; the generation job try/skips).
 */
export function occurrencesBetween(t: Template, fromDate: string, toDate: string): string[] {
  const token = dtstartToken(t.recurrenceDtstart, t.timezone);
  const rule = rrulestr(`DTSTART:${token}\nRRULE:${t.recurrenceRule}`);

  // Widen the UTC scan window by a day on each side: the noon anchor sits inside
  // the local day, so the local-day bounds (local midnights, in UTC) can clip a
  // legitimate hit at the edges. We re-filter by derived local date below, so the
  // pad never admits an out-of-window day.
  const lo = new Date(new Date(utcDayBounds(fromDate, t.timezone).start).getTime() - 86_400_000);
  const hi = new Date(new Date(utcDayBounds(toDate, t.timezone).end).getTime() + 86_400_000);

  const ex = new Set(t.recurrenceExdates ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of rule.between(lo, hi, true)) {
    const day = localDateOf(d, t.timezone);
    if (day < fromDate || day > toDate) continue; // exact local-window clamp
    if (ex.has(day)) continue;
    if (seen.has(day)) continue; // de-dupe (e.g. BYDAY overlaps)
    seen.add(day);
    out.push(day);
  }
  out.sort(); // ISO dates sort chronologically; guarantees order independent of rrule iteration
  return out;
}

/** The concrete UTC start instant for an instance on `localDay`, via the sanctioned tz path. */
export function instanceStartUTC(localDay: string, taskTime: string | null, tz: string): string {
  return zonedWallTimeToUTC(localDay, (taskTime ?? '00:00').slice(0, 5), tz);
}

/**
 * Validate + normalize an RRULE string. Round-trips through rrule.js, requires a
 * FREQ, rejects sub-daily frequencies, and caps any bounded span (COUNT/UNTIL)
 * at MAX_SPAN_DAYS. Returns a structured result — never throws (callers map a
 * failure to HTTP 422, never a 500).
 */
export function parseRule(s: string): ParseResult {
  const raw = (s ?? '').trim();
  if (!raw) return { ok: false, error: 'Empty recurrence rule' };

  // Accept a bare RRULE or a full block; strip a leading "RRULE:" if present.
  const ruleLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.toUpperCase().startsWith('DTSTART'));
  const body = (ruleLine ?? raw).replace(/^RRULE:/i, '').trim();

  if (!/(^|;)\s*FREQ\s*=/i.test(body)) return { ok: false, error: 'Recurrence rule must specify a FREQ' };

  const freqMatch = body.match(/(?:^|;)\s*FREQ\s*=\s*([A-Z]+)/i);
  const freq = (freqMatch?.[1] ?? '').toUpperCase();
  if (FORBIDDEN_FREQ.has(freq)) {
    return { ok: false, error: `Sub-daily recurrence (FREQ=${freq}) is not supported` };
  }

  let rule: RRule;
  try {
    // Anchor at an arbitrary fixed DTSTART so rrule.js can parse + we can re-emit.
    const parsed = rrulestr(`DTSTART:20000101T000000Z\nRRULE:${body}`);
    if (parsed instanceof RRule) {
      rule = parsed;
    } else {
      // rrulestr returns an RRuleSet for multi-rule / EXDATE blocks — out of scope:
      // a single RRULE is all we materialize (EXDATE is tracked separately in DB).
      return { ok: false, error: 'Only a single RRULE is supported (no rule sets)' };
    }
  } catch (e) {
    return { ok: false, error: `Invalid recurrence rule: ${(e as Error).message}` };
  }

  const opts = rule.options;
  // Defensive re-check after parse (rrule.js normalizes FREQ to an enum).
  if (opts.freq === RRule.HOURLY || opts.freq === RRule.MINUTELY || opts.freq === RRule.SECONDLY) {
    return { ok: false, error: 'Sub-daily recurrence is not supported' };
  }

  // Cap bounded spans. UNTIL beyond the ceiling, or a COUNT large enough to run
  // past it, is rejected rather than silently truncated.
  const ceiling = Date.UTC(2000, 0, 1) + MAX_SPAN_DAYS * 86_400_000;
  if (opts.until && opts.until.getTime() > ceiling) {
    return { ok: false, error: `UNTIL exceeds the ${MAX_SPAN_DAYS}-day horizon ceiling` };
  }
  if (opts.count != null) {
    // Cheapest safe upper bound: daily produces one hit/day, so COUNT can't exceed
    // the ceiling in days for any FREQ >= DAILY (weekly/monthly span more per count).
    if (opts.count > MAX_SPAN_DAYS) {
      return { ok: false, error: `COUNT exceeds the ${MAX_SPAN_DAYS}-day horizon ceiling` };
    }
  }

  // Re-emit the normalized RRULE line (drops the synthetic DTSTART).
  const normalized = rule.toString().replace(/^DTSTART:[^\n]*\n?/i, '').replace(/^RRULE:/i, '').trim();
  return { ok: true, rule: normalized };
}
