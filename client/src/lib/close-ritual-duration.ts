import type { Block, Task } from './api.js';

/**
 * The close ritual's pre-filled duration (0161).
 *
 * The owner's rule, verbatim: the default end time is when the sheet opens if that is
 * BEFORE the allocated end, and the allocated end once the sheet opens after it. In other
 * words `end = min(now, block.end_at)` — finishing early credits only the time you used,
 * and finishing late credits only the time you were given. Neither direction inflates the
 * number, which is the point: this figure feeds estimate-bias calibration, so a default
 * that drifts high would teach the scheduler to over-allocate.
 *
 * Pure and block-agnostic about where `now` comes from so it can be tested without a clock.
 */

export type DurationBasis =
  /** Ran to (or past) the allocated end — credited the full block span. */
  | 'block-full'
  /** Finished inside the block — credited start → now. */
  | 'block-partial'
  /** No usable block, but a timer actually ran. Measured beats inferred. */
  | 'timer'
  /** Nothing measured — fall back to what was planned. */
  | 'estimate'
  /** No block, no timer, no estimate. */
  | 'none';

export interface DurationDefault {
  minutes: number;
  basis: DurationBasis;
  /** One short line shown under the field, so an auto-filled number is never mysterious. */
  explain: string;
}

const MINUTES = 60_000;
const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The block whose span this task was allocated.
 *
 * A task can carry several session blocks. Preference order:
 *  1. the block the completion came from, when it came from one (the Planner chip / Focus
 *     ritual know exactly which span the user just finished);
 *  2. the block containing `now` — the one being worked;
 *  3. the latest block that has already started — you finished after it;
 *  4. the earliest placement, matching `scheduledByTaskId`'s "earliest owns the task".
 *
 * All-day blocks are skipped throughout: they have no clock span to measure against.
 */
export function pickBlock(
  blocks: readonly Block[],
  taskId: string,
  nowMs: number,
  preferBlockId?: string | null,
): Block | null {
  const mine = blocks.filter(
    (b) => b.task_id === taskId && b.block_kind === 'task' && !b.all_day && b.start_at && b.end_at,
  );
  if (mine.length === 0) return null;

  if (preferBlockId) {
    const exact = mine.find((b) => b.id === preferBlockId);
    if (exact) return exact;
  }

  const byStart = [...mine].sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const containing = byStart.find(
    (b) => Date.parse(b.start_at) <= nowMs && nowMs <= Date.parse(b.end_at),
  );
  if (containing) return containing;

  const started = byStart.filter((b) => Date.parse(b.start_at) <= nowMs);
  return started.length ? started[started.length - 1] : byStart[0];
}

/** Round to whole minutes, never below zero. */
const toMinutes = (ms: number): number => Math.max(0, Math.round(ms / MINUTES));

export function defaultDuration(
  task: Pick<Task, 'estimated_minutes' | 'actual_minutes'>,
  block: Block | null,
  nowMs: number,
): DurationDefault {
  const estimate = task.estimated_minutes ?? 0;
  const timed = task.actual_minutes ?? 0;

  if (block) {
    const start = Date.parse(block.start_at);
    const end = Date.parse(block.end_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      // Completed BEFORE the block was due to start. Not in the owner's spec — and
      // min(now, end) − start would be negative here. The allocated time demonstrably was
      // not used, so there is nothing to credit from the block and we fall through to the
      // estimate rather than inventing a 0 that would read as "this took no time".
      if (nowMs >= start) {
        const cappedEnd = Math.min(nowMs, end);
        const minutes = toMinutes(cappedEnd - start);
        const full = cappedEnd >= end;
        return {
          minutes,
          basis: full ? 'block-full' : 'block-partial',
          explain: full
            ? `${hhmm(start)}–${hhmm(end)} · capped at the block end`
            : `${hhmm(start)}–${hhmm(cappedEnd)} · finished early`,
        };
      }
    }
  }

  if (timed > 0) return { minutes: timed, basis: 'timer', explain: 'from the timer' };
  if (estimate > 0) return { minutes: estimate, basis: 'estimate', explain: 'your estimate — nothing was timed' };
  return { minutes: 0, basis: 'none', explain: 'not scheduled or timed' };
}
