import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Lifecycle for the throwaway SQLite file every `vitest run` writes to.
 *
 * The path stays keyed by pid — that is what keeps concurrent runs (parallel
 * worktrees, two agents at once) off each other's database, and it is also what
 * makes the sweep below safe: a pid is the one suffix whose owner you can still
 * *ask about* after the fact. A random suffix would leave abandoned files
 * indistinguishable from a live 5-minute run's file, forcing an age heuristic
 * that can delete a database out from under a suite that is still running.
 *
 * What pid keying does NOT give you is freshness. The OS recycles pids, nothing
 * ever deleted these files (34 of them had accumulated over four days, the
 * oldest 4MB), so a run could draw a pid whose file already existed and open a
 * days-old database instead of an empty one. `setup()` therefore deletes the
 * file before anything opens it — that, not the teardown, is what makes
 * inheritance impossible. Teardown and the sweep are hygiene: they stop the
 * files piling up in $TMPDIR again.
 *
 * Ordinary leftovers are mild — most test files call `resetDb()` in
 * `beforeEach`, so a completed run leaves only a handful of rows, and the tables
 * `resetDb()` never touches (`app_config`, `day_types`, `tag_directions`,
 * `pattern_blocks`, `connection_prefs`). The sharp edge is cross-branch: forward
 * migrations mean a file written by a branch ahead of yours arrives with columns
 * and tables your branch's migrations never created, and `runMigrations` records
 * them as applied rather than reconciling them.
 */

const PREFIX = 'companion-planning-test-';

/** The database, plus the two sidecar files SQLite's WAL mode keeps beside it. */
const SUFFIXES = ['', '-wal', '-shm'] as const;

/** Matches this file's own naming, so the sweep never touches an unrelated tmp file. */
const OURS = new RegExp(`^${PREFIX}(\\d+)\\.db(-wal|-shm)?$`);

export const testDbPath = join(tmpdir(), `${PREFIX}${process.pid}.db`);

function removeDb(path: string): void {
  for (const suffix of SUFFIXES) rmSync(path + suffix, { force: true });
}

/**
 * Does a process still hold this pid? `signal 0` runs the permission and
 * existence checks without delivering anything. EPERM means it exists but
 * belongs to another user — still alive, still hands off.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Delete test databases whose owning run is gone. Liveness is the entire safety
 * argument: a file whose pid still resolves may belong to a suite mid-run in
 * another worktree, so it is left alone — including the case where the pid has
 * been recycled by something unrelated, which only costs us one more file until
 * that process exits.
 */
function sweepAbandoned(): void {
  const dir = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an unreadable $TMPDIR is not a reason to fail the suite
  }
  for (const name of entries) {
    const match = OURS.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue; // ours — removed unconditionally below
    if (isAlive(pid)) continue;
    rmSync(join(dir, name), { force: true });
  }
}

export function setup(): void {
  sweepAbandoned();
  removeDb(testDbPath); // the run starts from no file at all, never a stale one
}

export function teardown(): void {
  // Escape hatch for post-mortems: the failing run's database is often the
  // fastest way to see what a test actually wrote.
  if (process.env.KEEP_TEST_DB) return;
  removeDb(testDbPath);
}
