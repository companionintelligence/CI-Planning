import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { snapshot, pruneOldSnapshots } from '../src/lib/backup.js';
import { sqlite } from '../src/db/index.js';
import { resetDb } from './helpers.js';

const testDir = join(tmpdir(), `cp-backup-test-${process.pid}`);

describe('snapshot', () => {
  beforeEach(() => {
    resetDb();
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a readable SQLite file containing live data', async () => {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id) SELECT uuid7(), 'backup-test-task', id FROM owners LIMIT 1`
      )
      .run();

    const dest = join(testDir, 'snap.db');
    await snapshot(dest);

    expect(existsSync(dest)).toBe(true);
    const copy = new BetterSqlite3(dest, { readonly: true });
    try {
      const rows = copy
        .prepare('SELECT title FROM tasks WHERE title = ?')
        .all('backup-test-task') as { title: string }[];
      expect(rows).toHaveLength(1);
    } finally {
      copy.close();
    }
  });

  it('creates nested destination directories if they do not exist', async () => {
    const nested = join(testDir, 'deep', 'dir', 'snap.db');
    await snapshot(nested);
    expect(existsSync(nested)).toBe(true);
  });
});

describe('pruneOldSnapshots', () => {
  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('deletes oldest files, retaining the N newest', () => {
    const names = [
      'companion-2026-06-20T02-00-00-000Z.db',
      'companion-2026-06-21T02-00-00-000Z.db',
      'companion-2026-06-22T02-00-00-000Z.db',
    ];
    for (const n of names) writeFileSync(join(testDir, n), '');

    pruneOldSnapshots(testDir, 2);

    expect(existsSync(join(testDir, names[0]))).toBe(false);
    expect(existsSync(join(testDir, names[1]))).toBe(true);
    expect(existsSync(join(testDir, names[2]))).toBe(true);
  });

  it('is a no-op when file count is at or below the retain limit', () => {
    const name = 'companion-2026-06-22T02-00-00-000Z.db';
    writeFileSync(join(testDir, name), '');
    pruneOldSnapshots(testDir, 7);
    expect(existsSync(join(testDir, name))).toBe(true);
  });

  it('only considers companion-*.db files', () => {
    writeFileSync(join(testDir, 'other-file.txt'), '');
    writeFileSync(join(testDir, 'companion-2026-06-22T02-00-00-000Z.db'), '');
    pruneOldSnapshots(testDir, 0); // retain=0 would delete all companion-*.db
    expect(existsSync(join(testDir, 'other-file.txt'))).toBe(true);
  });
});
