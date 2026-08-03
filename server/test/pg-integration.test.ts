import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initPg, prepare, transaction, closePg, execRaw } from '../src/db/pg.js';

/**
 * The adapter against a REAL Postgres carrying the ported `planning` schema.
 *
 * Skips (rather than fails) when no database is reachable, so the suite stays green on
 * a machine that has not started one — but it does NOT silently pass: PG_TEST_URL being
 * unset is the only skip condition, and CI sets it.
 *
 *   docker run -d --name cip-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=planning \
 *     -p 55432:5432 pgvector/pgvector:pg17
 *   PG_TEST_URL=postgres://postgres:pw@localhost:55432/planning pnpm --filter server test
 */
const URL_ = process.env.PG_TEST_URL;
const MIGRATIONS = join(import.meta.dirname, '..', 'db', 'postgres', 'migrations');

/** Apply only the `-- migrate:up` half, which is what dbmate runs. */
function upSection(file: string): string {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');
  return sql.slice(start + '-- migrate:up'.length, end === -1 ? undefined : end);
}

describe.skipIf(!URL_)('pg adapter against the ported planning schema', () => {
  const OWNER = '11111111-1111-7111-8111-111111111111';

  beforeAll(async () => {
    initPg({ connectionString: URL_!, schema: 'planning' });
    await execRaw('DROP SCHEMA IF EXISTS planning CASCADE');
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await execRaw(upSection(f));
    }
    await prepare(`INSERT INTO owners (id, name) VALUES (?, ?)`).run(OWNER, 'Test Owner');
  });

  afterAll(async () => {
    await execRaw('DROP SCHEMA IF EXISTS planning CASCADE').catch(() => {});
    await closePg();
  });

  it('applies all four migrations and lands the full schema', async () => {
    const r = await prepare(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = ?`,
    ).get<{ n: number }>('planning');
    expect(r?.n).toBe(56);
  });

  it('get/all/run keep better-sqlite3 semantics', async () => {
    const ins = await prepare(
      `INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, ?, 'open')`,
    ).run(OWNER, 'Adapter task');
    expect(ins.changes).toBe(1); // `changes`, as better-sqlite3 reports it

    const one = await prepare(`SELECT title FROM tasks WHERE owner_id = ?`).get<{ title: string }>(OWNER);
    expect(one?.title).toBe('Adapter task');

    const many = await prepare(`SELECT title FROM tasks WHERE owner_id = ?`).all<{ title: string }>(OWNER);
    expect(many).toHaveLength(1);

    // A miss is `undefined`, not null and not a throw — what `.get()` does in SQLite.
    const miss = await prepare(`SELECT title FROM tasks WHERE id = ?`).get('nope-not-a-uuid7');
    expect(miss).toBeUndefined();
  });

  it('uuid7() is callable from ported raw SQL and is time-ordered', async () => {
    await prepare(`DELETE FROM tasks WHERE owner_id = ?`).run(OWNER);
    for (let i = 0; i < 25; i++) {
      await prepare(
        `INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, ?, 'open')`,
      ).run(OWNER, `t${i}`);
    }
    // ORDER BY id must equal insertion order — dedupe and the flight plan rely on it.
    const rows = await prepare(
      `SELECT title FROM tasks WHERE owner_id = ? ORDER BY id`,
    ).all<{ title: string }>(OWNER);
    expect(rows.map((r) => r.title)).toEqual(Array.from({ length: 25 }, (_, i) => `t${i}`));
  });

  it('CURRENT_TIMESTAMP defaults keep SQLite\'s zone-less byte format', async () => {
    await prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)`).run('k', 'v');
    const row = await prepare(`SELECT updated_at FROM app_config WHERE key = ?`).get<{ updated_at: string }>('k');
    // 'YYYY-MM-DD HH:MM:SS' — no T, no Z, no offset. lib/tz.ts parses exactly this.
    expect(row?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('commits a transaction', async () => {
    await prepare(`DELETE FROM tasks WHERE owner_id = ?`).run(OWNER);
    await transaction(async () => {
      await prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'a', 'open')`).run(OWNER);
      await prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'b', 'open')`).run(OWNER);
    });
    const n = await prepare(`SELECT count(*)::int AS n FROM tasks WHERE owner_id = ?`).get<{ n: number }>(OWNER);
    expect(n?.n).toBe(2);
  });

  it('rolls the whole transaction back on a throw', async () => {
    await prepare(`DELETE FROM tasks WHERE owner_id = ?`).run(OWNER);
    await expect(
      transaction(async () => {
        await prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'keep?', 'open')`).run(OWNER);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const n = await prepare(`SELECT count(*)::int AS n FROM tasks WHERE owner_id = ?`).get<{ n: number }>(OWNER);
    expect(n?.n).toBe(0); // the insert did not survive
  });

  it('nests via SAVEPOINT: an inner rollback leaves the outer work intact', async () => {
    await prepare(`DELETE FROM tasks WHERE owner_id = ?`).run(OWNER);
    await transaction(async () => {
      await prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'outer', 'open')`).run(OWNER);
      await expect(
        transaction(async () => {
          await prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'inner', 'open')`).run(OWNER);
          throw new Error('inner fails');
        }),
      ).rejects.toThrow('inner fails');
      // Without SAVEPOINT handling the outer transaction would now be aborted and this
      // next statement would fail with "current transaction is aborted".
      await prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'after', 'open')`).run(OWNER);
    });

    const rows = await prepare(
      `SELECT title FROM tasks WHERE owner_id = ? ORDER BY title`,
    ).all<{ title: string }>(OWNER);
    expect(rows.map((r) => r.title)).toEqual(['after', 'outer']);
  });

  it('enforces the ported foreign keys and CHECK constraints', async () => {
    await expect(
      prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'orphan', 'open')`)
        .run('99999999-9999-7999-8999-999999999999'),
    ).rejects.toThrow(/foreign key/i);

    // task_dependencies CHECK (task_id <> depends_on_id) — ported from the SQLite DDL.
    const t = await prepare(
      `INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'self', 'open') RETURNING id`,
    ).get<{ id: string }>(OWNER);
    await expect(
      prepare(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)`).run(t!.id, t!.id),
    ).rejects.toThrow(/check constraint/i);
  });

  it('honours a partial unique index (owners.external_subject WHERE NOT NULL)', async () => {
    await prepare(`INSERT INTO owners (id, name, external_subject) VALUES (uuid7(), 'a', ?)`).run('sub-x');
    await expect(
      prepare(`INSERT INTO owners (id, name, external_subject) VALUES (uuid7(), 'b', ?)`).run('sub-x'),
    ).rejects.toThrow(/duplicate key/i);
    // …but many NULLs still coexist, which is the whole point of the partial predicate.
    await prepare(`INSERT INTO owners (id, name) VALUES (uuid7(), 'n1')`).run();
    await prepare(`INSERT INTO owners (id, name) VALUES (uuid7(), 'n2')`).run();
  });
});
