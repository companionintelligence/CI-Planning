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
    if (r.start.isCertain('hour')) {
      dueAt = d.toISOString();
      // task_time is a LOCAL wall-clock HH:MM (as used by the scheduler's pins),
      // so take chrono's parsed components, not the UTC slice of the instant.
      const hh = r.start.get('hour') ?? 0;
      const mm = r.start.get('minute') ?? 0;
      taskTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      // AD1: also set scheduled_for to the parsed instant's LOCAL date, so task_time is
      // authoritative — the task is scheduled onto that day and placed at its time (not
      // left invisible / packed elsewhere). Built from chrono's parsed date components
      // (the intended wall-clock day), matching how task_time reads the wall-clock hour,
      // so it stays consistent regardless of the server's UTC offset.
      const yr = r.start.get('year') ?? d.getFullYear();
      const mo = r.start.get('month') ?? d.getMonth() + 1;
      const dy = r.start.get('day') ?? d.getDate();
      scheduledFor = `${String(yr).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
    } else {
      scheduledFor = d.toISOString().slice(0, 10); // date-only => intent, not a deadline
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
