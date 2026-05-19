/**
 * Indexer integration tests — real disk I/O, real SQLite.
 * Verifies that indexFile and fullScan produce correct DB state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb } from '../../src/db.js';
import { indexFile, fullScan } from '../../src/indexer.js';
import { queryTodos, listFiles, getStats } from '../../src/db.js';

const ROOT = mkdtempSync(join(tmpdir(), 'cp-indexer-test-'));
const DB_PATH = join(ROOT, 'idx.db');

let db: ReturnType<typeof openDb>;

beforeAll(() => {
  db = openDb(DB_PATH);
});

afterAll(() => {
  db.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('fullScan', () => {
  it('indexes files in a directory', () => {
    writeFileSync(join(ROOT, 'a.md'), '# Work\n\n- [ ] Task one\n- [x] Done thing\n');
    writeFileSync(join(ROOT, 'b.md'), '# Personal\n\n- [ ] Call dentist\n');

    const stats = fullScan(db, [ROOT], new Set());
    expect(stats.files).toBe(2);
    expect(stats.todos).toBe(3);
  });

  it('reflects all open todos in queryTodos', () => {
    const todos = queryTodos(db, { checked: 0 });
    expect(todos.length).toBe(2);
    expect(todos.every(t => !t.checked)).toBe(true);
  });

  it('reflects done todos', () => {
    const done = queryTodos(db, { checked: 1 });
    expect(done.length).toBe(1);
    expect(done[0]?.plain_text).toBe('Done thing');
  });

  it('lists files with todo counts', () => {
    const files = listFiles(db);
    expect(files.length).toBe(2);
    const aFile = files.find(f => f.path.endsWith('a.md'));
    expect(aFile).toBeDefined();
    expect(aFile!.open).toBe(1);
    expect(aFile!.done).toBe(1);
  });
});

describe('indexFile — incremental update', () => {
  it('updates existing todos when file changes', () => {
    const path = join(ROOT, 'a.md');
    writeFileSync(path, '# Work\n\n- [ ] Task one\n- [ ] New task two\n- [x] Done thing\n');
    indexFile(db, path, ROOT);

    const todos = queryTodos(db, { file: path });
    expect(todos.length).toBe(3);
    expect(todos.some(t => t.plain_text === 'New task two')).toBe(true);
  });

  it('skips re-indexing when content unchanged (content-hash cache)', () => {
    const path = join(ROOT, 'b.md');
    const statsBefore = getStats(db);

    // Re-index same content
    indexFile(db, path, ROOT);

    // Stats should be identical — no new rows
    const statsAfter = getStats(db);
    expect(statsAfter.total_todos).toBe(statsBefore.total_todos);
  });
});

describe('fullScan — GC stale entries', () => {
  it('removes DB entries for deleted files', () => {
    const path = join(ROOT, 'b.md');
    unlinkSync(path);
    const stats = fullScan(db, [ROOT], new Set());
    expect(stats.files).toBe(1);
    const remaining = listFiles(db);
    expect(remaining.every(f => !f.path.endsWith('b.md'))).toBe(true);
  });
});

describe('fullScan — excludeDirs', () => {
  it('skips directories in the exclude set', () => {
    const sub = join(ROOT, 'node_modules');
    rmSync(sub, { recursive: true, force: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'excluded.md'), '- [ ] Should not index\n');

    fullScan(db, [ROOT], new Set(['node_modules']));
    const todos = queryTodos(db, {});
    expect(todos.every(t => !t.file_path.includes('node_modules'))).toBe(true);
  });
});

describe('queryTodos — filters', () => {
  beforeAll(() => {
    writeFileSync(
      join(ROOT, 'dated.md'),
      '# Dated\n\n- [ ] Overdue item (due: 2020-01-01)\n- [ ] Future item (due: 2099-12-31)\n',
    );
    fullScan(db, [ROOT], new Set());
  });

  it('filters by tag', () => {
    const path = join(ROOT, 'tagged.md');
    writeFileSync(path, '# Tags\n\n- [ ] Go shopping #errand\n- [ ] Write tests #dev\n');
    indexFile(db, path, ROOT);

    const errand = queryTodos(db, { tag: 'errand' });
    expect(errand.length).toBe(1);
    expect(errand[0]?.plain_text).toContain('shopping');
  });

  it('filters by due=overdue', () => {
    const overdue = queryTodos(db, { due: 'overdue' });
    expect(overdue.length).toBeGreaterThanOrEqual(1);
    expect(overdue.every(t => t.due_date !== null && t.due_date < new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it('respects limit', () => {
    const limited = queryTodos(db, { limit: 1 });
    expect(limited.length).toBe(1);
  });
});
