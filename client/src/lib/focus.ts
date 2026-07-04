/**
 * Phase Z · Z3b (Time-Sense) — Focus Ritual pure logic.
 *
 * The visual component is a thin render layer over these deterministic functions
 * (phase, elapsed/depletion fractions, cue instants). Keeping the math here makes
 * it unit-testable without a DOM, and keeps the component free of off-by-one clock
 * bugs. "Now" is always passed in (the client's wall clock), never read here.
 */

/** Minutes before a block's end that the "land the plane" warning begins (T3). */
export const WARN_LEAD_MIN = 3;
export const WARN_LEAD_MS = WARN_LEAD_MIN * 60_000;

export type FocusPhase = 'before' | 'running' | 'warning' | 'ended';

export interface FocusState {
  phase: FocusPhase;
  /** 0 at start → 1 at end (clamped). Drives the countdown readout. */
  elapsedFrac: number;
  /** 0 at start → 1 at the warning threshold (end − 3 min), then held at 1. Drives the ambient depletion. */
  depletionFrac: number;
  /** Milliseconds until the block's end (0 once ended). */
  remainingMs: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The ritual's state at `nowMs` for a block spanning [startMs, endMs].
 * A zero/negative-length block degrades to fully-ended rather than dividing by zero.
 */
export function focusState(nowMs: number, startMs: number, endMs: number): FocusState {
  const span = endMs - startMs;
  const remainingMs = Math.max(0, endMs - nowMs);
  if (span <= 0) {
    return { phase: nowMs >= endMs ? 'ended' : 'running', elapsedFrac: 1, depletionFrac: 1, remainingMs };
  }
  const elapsedFrac = clamp01((nowMs - startMs) / span);
  // Depletion completes at the warning threshold, so the ambient color has fully
  // faded by the time the breathing cue takes over the final 3 minutes.
  const depletionSpan = Math.max(1, endMs - WARN_LEAD_MS - startMs);
  const depletionFrac = clamp01((nowMs - startMs) / depletionSpan);

  let phase: FocusPhase;
  if (nowMs < startMs) phase = 'before';
  else if (nowMs >= endMs) phase = 'ended';
  else if (nowMs >= endMs - WARN_LEAD_MS) phase = 'warning';
  else phase = 'running';

  return { phase, elapsedFrac, depletionFrac, remainingMs };
}

export type CueKind = 'start' | 'mid' | 'warn' | 'end';
export interface Cue { at: number; kind: CueKind }

/**
 * The four ritual cue instants for [startMs, endMs], in time order. The mid cue is
 * dropped when it would collide with the warning (very short blocks) so cues never
 * double-fire. The in-tab scheduler arms a timeout per cue still in the future.
 */
export function focusCues(startMs: number, endMs: number): Cue[] {
  const mid = startMs + (endMs - startMs) / 2;
  const warn = endMs - WARN_LEAD_MS;
  const cues: Cue[] = [
    { at: startMs, kind: 'start' },
    { at: mid, kind: 'mid' },
    { at: warn, kind: 'warn' },
    { at: endMs, kind: 'end' },
  ];
  // Keep strictly-increasing, in-window cues (drop mid/warn that fall at/before start
  // or out of order on a tiny block).
  return cues
    .filter((c) => c.at >= startMs && c.at <= endMs)
    .filter((c, i, arr) => i === 0 || c.at > arr[i - 1].at);
}

/** The cues strictly after `nowMs` (what the scheduler still needs to arm). */
export function pendingCues(nowMs: number, startMs: number, endMs: number): Cue[] {
  return focusCues(startMs, endMs).filter((c) => c.at > nowMs);
}

/** mm:ss for a positive duration; clamps negatives to 0:00. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The consequence line for running over: if extending to `proposedEndMs` would eat
 * into the next entity's start, describe it; else null (no consequence to surface).
 */
export function overrunNote(proposedEndMs: number, nextStartMs: number | null, nextLabel: string | null): string | null {
  if (nextStartMs == null || nextLabel == null) return null;
  if (proposedEndMs <= nextStartMs) return null;
  const over = Math.round((proposedEndMs - nextStartMs) / 60_000);
  return `Runs ${over}m into ${nextLabel}.`;
}
