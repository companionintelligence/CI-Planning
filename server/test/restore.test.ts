import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import BetterSqlite3 from 'better-sqlite3';
import { pidFilePath } from '../src/lib/pidfile.js';

/**
 * Restore is the one tool whose failure has no second chance, so it is exercised as a real
 * subprocess against real files rather than by importing its internals — the bugs being
 * pinned here (a lock probe that never fired, a stale WAL replaying onto a fresh snapshot)
 * were both invisible to any test that did not touch the filesystem.
 *
 * The corruption case is the important one. It is silent: the resulting file is a
 * page-level mixture of two databases that `PRAGMA integrity_check` reports as `ok`, so
 * the assertion has to be on the CONTENT, never on integrity_check.
 */

const testDir = join(tmpdir(), `cp-restore-test-${process.pid}`);
const RESTORE = join(dirname(new URL(import.meta.url).pathname), '..', 'src', 'scripts', 'restore.ts');
const TSX = join(dirname(new URL(import.meta.url).pathname), '..', 'node_modules', '.bin', 'tsx');

function runRestore(dbPath: string, snapshotPath: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(TSX, [RESTORE, snapshotPath], {
      env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'test', AUTH_MODE: 'test', LOG_LEVEL: 'error' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A minimal standalone SQLite db carrying one identifying marker row. */
function makeDb(path: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.exec('CREATE TABLE IF NOT EXISTS marker (v TEXT)');
  db.prepare('INSERT INTO marker (v) VALUES (?)').run(marker);
  db.close();
}

function markersIn(path: string): string[] {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    return (db.prepare('SELECT v FROM marker ORDER BY v').all() as { v: string }[]).map((r) => r.v);
  } finally {
    db.close();
  }
}

describe('restore', () => {
  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('does not replay a stale -wal from the old database onto the restored snapshot', () => {
    const dbPath = join(testDir, 'live', 'companion.db');
    const snapPath = join(testDir, 'snap.db');

    // The snapshot we want back.
    makeDb(snapPath, 'FROM-SNAPSHOT');

    // The live database, left exactly as a killed server leaves it: WAL mode, a committed
    // write still sitting in the -wal, and the handle never closed. Done in a CHILD that
    // exits via process.exit() — the same thing boot.ts used to do — because closing the
    // handle in-process would checkpoint and delete the -wal, i.e. destroy the very state
    // under test.
    makeDb(dbPath, 'FROM-LIVE');
    execFileSync(
      process.execPath,
      [
        '-e',
        `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});` +
          `const d=new D(${JSON.stringify(dbPath)});` +
          `d.pragma('journal_mode = WAL');` +
          `d.prepare('INSERT INTO marker (v) VALUES (?)').run('ONLY-IN-STALE-WAL');` +
          `process.exit(0);`,
      ],
      { stdio: 'pipe' },
    );
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const res = runRestore(dbPath, snapPath);

    expect(res.ok).toBe(true);

    // The restored database must be EXACTLY the snapshot. If the stale WAL replayed, the
    // old database's pages bleed in and this contains live/WAL markers too.
    expect(markersIn(dbPath)).toEqual(['FROM-SNAPSHOT']);

    // The WAL's contents must have gone WITH the old database, not onto the new one.
    // (Asserting the -wal file itself survives would be wrong: restore's BEGIN IMMEDIATE
    // probe is the last connection to close, so SQLite legitimately checkpoints the WAL
    // into the old main file and removes the sidecar before the move. Provenance is the
    // invariant, not the file — so assert the row only reachable via that WAL landed in
    // the preserved copy.)
    const aside = readdirSync(join(dirname(dbPath), 'pre-restore')).filter(
      (f) => !f.endsWith('-wal') && !f.endsWith('-shm'),
    );
    expect(aside).toHaveLength(1);
    expect(markersIn(join(dirname(dbPath), 'pre-restore', aside[0]))).toEqual([
      'FROM-LIVE',
      'ONLY-IN-STALE-WAL',
    ]);
  });

  it('preserves the pre-restore database instead of overwriting the only other copy', () => {
    const dbPath = join(testDir, 'live', 'companion.db');
    const snapPath = join(testDir, 'snap.db');
    makeDb(snapPath, 'FROM-SNAPSHOT');
    makeDb(dbPath, 'FROM-LIVE');

    expect(runRestore(dbPath, snapPath).ok).toBe(true);

    // Restoring the wrong snapshot must be recoverable — the previous file is kept.
    const asideDir = join(dirname(dbPath), 'pre-restore');
    expect(existsSync(asideDir)).toBe(true);
    const kept = readdirSync(asideDir).filter((f) => !f.endsWith('-wal') && !f.endsWith('-shm'));
    expect(kept).toHaveLength(1);
    expect(markersIn(join(asideDir, kept[0]))).toEqual(['FROM-LIVE']);
  });

  it('refuses to run while a live pidfile claims the database', () => {
    const dbPath = join(testDir, 'live', 'companion.db');
    const snapPath = join(testDir, 'snap.db');
    makeDb(snapPath, 'FROM-SNAPSHOT');
    makeDb(dbPath, 'FROM-LIVE');

    // Our own pid is by definition alive; the old probe (merely opening the db) could
    // never detect this, which is why the guard silently passed for every operator.
    writeFileSync(pidFilePath(dbPath), `${process.pid}\n`);

    const res = runRestore(dbPath, snapPath);

    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/appears to be running/i);
    // And critically: it stopped BEFORE touching anything.
    expect(markersIn(dbPath)).toEqual(['FROM-LIVE']);
  });

  it('ignores a stale pidfile whose process is gone', () => {
    const dbPath = join(testDir, 'live', 'companion.db');
    const snapPath = join(testDir, 'snap.db');
    makeDb(snapPath, 'FROM-SNAPSHOT');
    makeDb(dbPath, 'FROM-LIVE');

    // A crashed server leaves its pidfile behind; that must not brick recovery.
    writeFileSync(pidFilePath(dbPath), '2147483646\n');

    expect(runRestore(dbPath, snapPath).ok).toBe(true);
    expect(markersIn(dbPath)).toEqual(['FROM-SNAPSHOT']);
  });

  it('refuses when a sidecar -wal exists with no database beside it', () => {
    const dbPath = join(testDir, 'live', 'companion.db');
    const snapPath = join(testDir, 'snap.db');
    makeDb(snapPath, 'FROM-SNAPSHOT');
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}-wal`, 'not-a-real-wal');

    const res = runRestore(dbPath, snapPath);

    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/-wal/);
    expect(existsSync(dbPath)).toBe(false);
  });
});
