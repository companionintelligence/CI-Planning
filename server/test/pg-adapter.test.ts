import { describe, it, expect } from 'vitest';
import { toPgPlaceholders } from '../src/db/pg.js';

/**
 * Placeholder rewriting is the load-bearing half of the SQLite→Postgres port: it is what
 * lets 386 call sites keep their `?` SQL verbatim. Getting it wrong is not a loud
 * failure — a `?` mistaken for a parameter inside a string literal both corrupts that
 * value AND shifts the numbering of every parameter after it, so the query still runs
 * and quietly binds the wrong arguments. Hence the literal/comment cases below.
 *
 * The connection-level behaviour (get/all/run/transaction/SAVEPOINT) is exercised
 * against a real Postgres in test/pg-integration.test.ts, which skips when none is
 * reachable — this file is pure and always runs.
 */
describe('toPgPlaceholders', () => {
  it('numbers parameters left to right', () => {
    expect(toPgPlaceholders('SELECT * FROM tasks WHERE owner_id = ? AND status = ?'))
      .toBe('SELECT * FROM tasks WHERE owner_id = $1 AND status = $2');
  });

  it('leaves SQL with no parameters untouched', () => {
    expect(toPgPlaceholders('SELECT 1')).toBe('SELECT 1');
  });

  it('does NOT renumber a ? inside a single-quoted literal', () => {
    // The literal keeps its '?', and the real parameter is still $1 — not $2.
    expect(toPgPlaceholders(`SELECT * FROM t WHERE label = 'what?' AND id = ?`))
      .toBe(`SELECT * FROM t WHERE label = 'what?' AND id = $1`);
  });

  it("handles SQL's doubled-quote escape inside a literal", () => {
    expect(toPgPlaceholders(`SELECT * FROM t WHERE s = 'it''s a ? really' AND id = ?`))
      .toBe(`SELECT * FROM t WHERE s = 'it''s a ? really' AND id = $1`);
  });

  it('does not renumber a ? inside a double-quoted identifier', () => {
    expect(toPgPlaceholders('SELECT "weird?col" FROM t WHERE id = ?'))
      .toBe('SELECT "weird?col" FROM t WHERE id = $1');
  });

  it('does not renumber a ? inside a line comment', () => {
    expect(toPgPlaceholders('SELECT 1 -- is this ok?\nWHERE id = ?'))
      .toBe('SELECT 1 -- is this ok?\nWHERE id = $1');
  });

  it('does not renumber a ? inside a block comment', () => {
    expect(toPgPlaceholders('SELECT 1 /* really? yes */ WHERE id = ?'))
      .toBe('SELECT 1 /* really? yes */ WHERE id = $1');
  });

  it('does not renumber inside a dollar-quoted body', () => {
    const sql = 'DO $$ BEGIN RAISE NOTICE ?; END $$';
    expect(toPgPlaceholders(sql)).toBe(sql);
  });

  it('numbers correctly when literals are interleaved with parameters', () => {
    expect(toPgPlaceholders(`INSERT INTO t (a,b,c) VALUES (?, 'q?', ?)`))
      .toBe(`INSERT INTO t (a,b,c) VALUES ($1, 'q?', $2)`);
  });

  it('rewrites a realistic multi-line statement from the codebase', () => {
    const src = `SELECT fp.task_id, t.title
         FROM flight_plan fp JOIN tasks t ON t.id = fp.task_id
        WHERE fp.owner_id = ? AND fp.selected = 1
        ORDER BY fp.position, t.priority, fp.task_id`;
    const out = toPgPlaceholders(src);
    expect(out).toContain('fp.owner_id = $1');
    expect(out.match(/\$\d/g)).toEqual(['$1']);
  });

  it('handles the maximum realistic parameter count without gaps', () => {
    const sql = 'INSERT INTO t VALUES (' + Array(30).fill('?').join(',') + ')';
    const out = toPgPlaceholders(sql);
    expect(out.match(/\$\d+/g)).toEqual(Array.from({ length: 30 }, (_, i) => `$${i + 1}`));
  });
});
