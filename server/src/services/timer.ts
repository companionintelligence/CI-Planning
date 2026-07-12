import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { httpError } from '../lib/http-error.js';

/** A time_entries row as stored (snake_case columns). */
export interface TimeEntryRow {
  id: string;
  task_id: string;
  owner_id: string;
  block_id: string | null;
  started_at: string;
  ended_at: string | null;
  source: string | null;
  created_at: string | null;
}

export interface StoppedEntry {
  entry: TimeEntryRow;
  taskId: string;
  actualMinutes: number;
  overran?: boolean;
}

export interface StartedTimer {
  entry: TimeEntryRow;
  /** The superseded entry that was closed to make room for this one, if any. */
  stopped: StoppedEntry | null;
}

/** Fetch a single entry by id (or undefined). */
export function getEntry(id: string): TimeEntryRow | undefined {
  return sqlite.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(id) as
    | TimeEntryRow
    | undefined;
}

/** The owner's currently running entry (ended_at IS NULL), or null. */
export function getRunning(owner: string): TimeEntryRow | null {
  return (
    (sqlite
      .prepare(`SELECT * FROM time_entries WHERE owner_id = ? AND ended_at IS NULL`)
      .get(owner) as TimeEntryRow | undefined) ?? null
  );
}

/**
 * Close the owner's running entry (if any), then recompute the affected task's
 * actual_minutes from the source of truth — the SUM of all finished entries for
 * that task — rather than `+=`, so the aggregate stays exact across many
 * sessions, restarts, and entry deletion (FK cascade). Returns the closed entry
 * plus the new total, or null when nothing was running.
 *
 * julianday math is exact to the second; rounding to whole minutes happens once.
 */
export function stopRunning(owner: string): StoppedEntry | null {
  const running = getRunning(owner);
  if (!running) return null;

  const endedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE time_entries SET ended_at = ? WHERE id = ?`).run(endedAt, running.id);

  // Owner-scope BOTH the aggregate and the write (defense in depth): the task-wide
  // total counts only this owner's finished entries, and actual_minutes is written
  // only onto this owner's task — a stray entry pointing at another owner's task can
  // never fold into their total or overwrite their row.
  const { total } = sqlite
    .prepare(
      `SELECT COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 24 * 60), 0) AS total
         FROM time_entries
        WHERE task_id = ? AND owner_id = ? AND ended_at IS NOT NULL`
    )
    .get(running.task_id, owner) as { total: number };
  const actual = Math.round(total);
  sqlite.prepare(`UPDATE tasks SET actual_minutes = ? WHERE id = ? AND owner_id = ?`).run(actual, running.task_id, owner);

  // §C1: overrun detection — compare *this session's* elapsed against the linked
  // block's planned span. actualMinutes is task-wide SUM; we must use started_at/ended_at.
  let overran = false;
  if (running.block_id) {
    const block = sqlite
      .prepare(`SELECT start_at, end_at FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get(running.block_id, owner) as { start_at: string; end_at: string } | undefined;
    if (block) {
      const sessionElapsedMs =
        new Date(endedAt).getTime() - new Date(running.started_at).getTime();
      const blockSpanMs =
        new Date(block.end_at).getTime() - new Date(block.start_at).getTime();
      const TOLERANCE_MS = 120_000; // 2 minutes
      if (sessionElapsedMs > blockSpanMs + TOLERANCE_MS) {
        sqlite
          .prepare(`UPDATE time_blocks SET status = 'overrun' WHERE id = ? AND owner_id = ?`)
          .run(running.block_id, owner);
        overran = true;
      }
    }
  }

  return {
    entry: { ...running, ended_at: endedAt },
    taskId: running.task_id,
    actualMinutes: actual,
    ...(overran ? { overran: true } : {}),
  };
}

/**
 * Start a timer on `taskId` (optionally linked to `blockId`). Atomically stops
 * any running timer for the owner first, then inserts the new one — so the
 * partial unique index (one running entry per owner) can never trip and the
 * second start observably supersedes the first.
 */
export function startTimer(taskId: string, blockId?: number): StartedTimer {
  const owner = currentOwnerId();
  // Validate the task is the caller's own BEFORE inserting an entry against it — the FK
  // only guarantees the task exists, not that it belongs to this owner. Without this a
  // caller could open a timer on another owner's task id (IDOR). 404 (indistinguishable
  // from a truly-missing task) so ownership can't be probed.
  if (!sqlite.prepare(`SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?`).get(taskId, owner)) {
    throw httpError(404, 'task not found');
  }
  // A linked block must also be the caller's own (else the overrun check silently no-ops
  // and the entry references a foreign block).
  if (blockId != null && !sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(blockId, owner)) {
    throw httpError(404, 'block not found');
  }
  const tx = sqlite.transaction(() => {
    const stopped = stopRunning(owner);
    const now = new Date().toISOString();
    const { id } = sqlite
      .prepare(
        `INSERT INTO time_entries (id, task_id, owner_id, block_id, started_at, source)
         VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(taskId, owner, blockId ?? null, now, blockId ? 'block' : 'timer') as { id: string };
    return { entry: getEntry(id)!, stopped };
  });
  return tx();
}

/** Stop the current owner's running timer. Returns the closed entry, or null. */
export function stopTimer(): StoppedEntry | null {
  return stopRunning(currentOwnerId());
}
