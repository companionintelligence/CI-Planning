import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';

/** A time_entries row as stored (snake_case columns). */
export interface TimeEntryRow {
  id: number;
  task_id: number;
  owner_id: number;
  block_id: number | null;
  started_at: string;
  ended_at: string | null;
  source: string | null;
  created_at: string | null;
}

export interface StoppedEntry {
  entry: TimeEntryRow;
  taskId: number;
  actualMinutes: number;
}

export interface StartedTimer {
  entry: TimeEntryRow;
  /** The superseded entry that was closed to make room for this one, if any. */
  stopped: StoppedEntry | null;
}

/** Fetch a single entry by id (or undefined). */
export function getEntry(id: number): TimeEntryRow | undefined {
  return sqlite.prepare(`SELECT * FROM time_entries WHERE id = ?`).get(id) as
    | TimeEntryRow
    | undefined;
}

/** The owner's currently running entry (ended_at IS NULL), or null. */
export function getRunning(owner: number): TimeEntryRow | null {
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
export function stopRunning(owner: number): StoppedEntry | null {
  const running = getRunning(owner);
  if (!running) return null;

  const endedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE time_entries SET ended_at = ? WHERE id = ?`).run(endedAt, running.id);

  const { total } = sqlite
    .prepare(
      `SELECT COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 24 * 60), 0) AS total
         FROM time_entries
        WHERE task_id = ? AND ended_at IS NOT NULL`
    )
    .get(running.task_id) as { total: number };
  const actual = Math.round(total);
  sqlite.prepare(`UPDATE tasks SET actual_minutes = ? WHERE id = ?`).run(actual, running.task_id);

  return {
    entry: { ...running, ended_at: endedAt },
    taskId: running.task_id,
    actualMinutes: actual,
  };
}

/**
 * Start a timer on `taskId` (optionally linked to `blockId`). Atomically stops
 * any running timer for the owner first, then inserts the new one — so the
 * partial unique index (one running entry per owner) can never trip and the
 * second start observably supersedes the first.
 */
export function startTimer(taskId: number, blockId?: number): StartedTimer {
  const owner = currentOwnerId();
  const tx = sqlite.transaction(() => {
    const stopped = stopRunning(owner);
    const now = new Date().toISOString();
    const { lastInsertRowid } = sqlite
      .prepare(
        `INSERT INTO time_entries (task_id, owner_id, block_id, started_at, source)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(taskId, owner, blockId ?? null, now, blockId ? 'block' : 'timer');
    return { entry: getEntry(Number(lastInsertRowid))!, stopped };
  });
  return tx();
}

/** Stop the current owner's running timer. Returns the closed entry, or null. */
export function stopTimer(): StoppedEntry | null {
  return stopRunning(currentOwnerId());
}
