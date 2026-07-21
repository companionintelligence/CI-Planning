/**
 * Preview-only slot proposal for the wizard's NL quick line (owner request
 * 2026-07-20): when a parse has no explicit time, propose the first open gap on
 * the target day so the TIME field + mini timeline arrive pre-filled — the user
 * approves (or drags it elsewhere) before Add creates anything. Deterministic
 * and framework-free so it unit-tests in node.
 *
 * Semantics mirror the server's start-anchored placement loosely: scan the
 * workday window for the first gap that fits the duration, flowing around the
 * day's known busy spans; on today, never propose a start in the past (rounded
 * up to the next quarter-hour). Returns null when the window can't fit the
 * duration — the caller leaves "No time" and the server-side engine (or the
 * user) decides later. The busy list may be INCOMPLETE (the client only loads
 * the viewed day's blocks) — fine for a preview: Add → task_time → the server
 * places at the stated time or its own nearest open gap.
 */

export interface BusySpan {
  /** Minutes-of-day, [start, end). */
  startMin: number;
  endMin: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const minToHHMM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

export function proposeSlot(opts: {
  busy: BusySpan[];
  durationMin: number;
  /** Workday window, minutes-of-day. */
  workStartMin: number;
  workEndMin: number;
  /** Minutes-of-day "now" when the target day is today; null for other days. */
  nowMin?: number | null;
}): string | null {
  const dur = Math.max(1, opts.durationMin);
  let cursor = opts.workStartMin;
  if (opts.nowMin != null) cursor = Math.max(cursor, Math.ceil(opts.nowMin / 15) * 15);

  const spans = [...opts.busy].sort((a, b) => a.startMin - b.startMin);
  for (const s of spans) {
    if (s.endMin <= cursor) continue;          // already behind us
    if (s.startMin >= cursor + dur) break;     // the gap before this span fits
    cursor = Math.max(cursor, s.endMin);       // flow past the busy span
  }
  if (cursor + dur > opts.workEndMin) return null; // day full within the window
  return minToHHMM(cursor);
}
