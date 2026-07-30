import * as chrono from 'chrono-node';

export interface ParsedQuick {
  title: string;
  dueAt?: string; // UTC ISO — set only when a time-of-day is present (a deadline)
  scheduledFor?: string; // local YYYY-MM-DD — set for ANY date mention (AD1: a timed
  // mention now sets it too, so task_time is authoritative and the task is placed on
  // that day; a bare-date mention sets it alone, as before).
  taskTime?: string; // HH:MM when a time was given
  tags: string[];
  estimatedMinutes?: number;
  priority?: number; // only ever filled by optional enrichment, never the parser
  // Phase B: 1–3 of the owner's category names (Balance dimensions) — only ever
  // filled by optional enrichment (a constrained classifier), never the parser.
  categories?: string[];
  // Motivation axis (0141, design §3b): who the work is for — only ever filled by
  // optional enrichment (the LLM classifier; unsure ⇒ absent), never the parser.
  motivation?: 'me' | 'us' | 'them';
  /**
   * D3 — the BAND the task is best done in, from optional enrichment. Deliberately not
   * a clock time: `taskTime` stays the parser's, set only when the entry's own words
   * gave one. The wizard turns a band into a concrete proposed slot via propose-slot.ts
   * (which flows around real busy spans); writing `task_time` from a band instead would
   * hard-pin the task through the AD1 pin pass and defeat conflict-aware placement.
   */
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'any';
  /** Why that band — one short clause, shown to the user, never persisted. */
  timeOfDayReason?: string;
  /** Enrichment's judgement that the task needs breaking down; gates the (separate,
   *  suggest-only) subtask brainstorm. Never persisted on the task. */
  isComplex?: boolean;
}

const TAG_RE = /#[\w-]+/g;
const EST_RE = /~\s*(\d+)\s*m(?:in)?\b/i;

/**
 * Deterministic quick-add parse. `#tags` and the `~Nm` estimate are stripped
 * BEFORE chrono runs, so "~20m" isn't mistaken for a time. chrono (the only date
 * parser — reproducible against a fixed `refNow`) then reads the remainder: a
 * bare date becomes `scheduledFor` (intent); a date WITH a time becomes `dueAt`
 * + `taskTime` AND `scheduledFor` (AD1 — task_time is authoritative, so the timed
 * task is scheduled onto that day and placed at its time). Whatever's left is the
 * title, which is never empty.
 */
export function parseQuick(input: string, refNow: Date = new Date()): ParsedQuick {
  const tags = [...input.matchAll(TAG_RE)].map((m) => m[0].slice(1).toLowerCase());
  const est = input.match(EST_RE);

  const cleaned = input
    .replace(TAG_RE, '')
    .replace(EST_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const r = chrono.parse(cleaned, refNow, { forwardDate: true })[0];
  let dueAt: string | undefined;
  let scheduledFor: string | undefined;
  let taskTime: string | undefined;
  if (r) {
    const d = r.start.date();
    // The intended wall-clock DAY, from chrono's parsed components (NOT the UTC slice of
    // the instant) — matches how task_time reads the wall-clock hour, so scheduled_for
    // stays on the intended day regardless of the server's UTC offset. Used by both branches.
    const yr = r.start.get('year') ?? d.getFullYear();
    const mo = r.start.get('month') ?? d.getMonth() + 1;
    const dy = r.start.get('day') ?? d.getDate();
    const localDate = `${String(yr).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
    if (r.start.isCertain('hour')) {
      dueAt = d.toISOString();
      // task_time is a LOCAL wall-clock HH:MM (as used by the scheduler's pins).
      const hh = r.start.get('hour') ?? 0;
      const mm = r.start.get('minute') ?? 0;
      taskTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      // AD1: also set scheduled_for so task_time is authoritative — the task is scheduled
      // onto that day and placed at its time (not left invisible / packed elsewhere).
      scheduledFor = localDate;
    } else {
      scheduledFor = localDate; // date-only => intent, not a deadline
    }
  }

  const title =
    (r ? cleaned.replace(r.text, '') : cleaned).replace(/\s{2,}/g, ' ').trim() || input.trim();

  return {
    title,
    dueAt,
    scheduledFor,
    taskTime,
    tags,
    estimatedMinutes: est ? Number(est[1]) : undefined,
  };
}
