import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSqliteStore, createPostgresStore, type Store } from '../src/db/store.js';
import { initPg, closePg } from '../src/db/pg.js';

/**
 * ONE suite, run against BOTH backends.
 *
 * This is what makes the cutover safe. The migration plan is: move ~1,536 call sites to
 * the async facade with SQLite underneath (suite stays green), then flip the backend.
 * That flip is only trustworthy if the two implementations agree on the semantics call
 * sites actually depend on — `.get()` returning undefined rather than null on a miss,
 * `{ changes }` on a write, rollback discarding work, a nested failure not poisoning the
 * outer transaction. Every one of those is a place the two could silently differ and
 * turn a green suite into a production bug.
 *
 * The Postgres half skips without PG_TEST_URL; the SQLite half always runs, so a
 * regression in the facade is caught even on a machine with no database.
 */

const PG_URL = process.env.PG_TEST_URL;

/** Same DDL on both — TEXT/INTEGER mean the same thing in each, which is exactly why
 *  the schema port kept those types (see db/postgres/README.md). */
const DDL = `CREATE TABLE conf (id TEXT PRIMARY KEY, n INTEGER, label TEXT)`;

interface Backend {
  name: string;
  store: Store;
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
}

const sqlitePath = join(tmpdir(), `store-conformance-${process.pid}.db`);
let sqliteDb: Database.Database;

const backends: Backend[] = [
  {
    name: 'sqlite',
    get store() { return createSqliteStore(sqliteDb); },
    setup: async () => {
      rmSync(sqlitePath, { force: true });
      sqliteDb = new Database(sqlitePath);
      sqliteDb.exec(DDL);
    },
    teardown: async () => {
      sqliteDb?.close();
      rmSync(sqlitePath, { force: true });
    },
  } as unknown as Backend,
];

if (PG_URL) {
  backends.push({
    name: 'postgres',
    store: createPostgresStore(),
    setup: async () => {
      initPg({ connectionString: PG_URL, schema: 'conformance' });
      const s = createPostgresStore();
      await s.exec('DROP SCHEMA IF EXISTS conformance CASCADE; CREATE SCHEMA conformance');
      await s.exec(DDL);
    },
    teardown: async () => {
      await createPostgresStore().exec('DROP SCHEMA IF EXISTS conformance CASCADE').catch(() => {});
      await closePg();
    },
  });
}

describe.each(backends.map((b) => [b.name, b] as const))('store conformance: %s', (_name, backend) => {
  let store: Store;

  beforeAll(async () => {
    await backend.setup();
    store = backend.store;
  });

  afterAll(async () => {
    await backend.teardown();
  });

  beforeEach(async () => {
    await store.prepare(`DELETE FROM conf`).run();
  });

  it('binds ? placeholders positionally', async () => {
    await store.prepare(`INSERT INTO conf (id, n, label) VALUES (?, ?, ?)`).run('a', 1, 'first');
    const row = await store.prepare(`SELECT label FROM conf WHERE id = ? AND n = ?`)
      .get<{ label: string }>('a', 1);
    expect(row?.label).toBe('first');
  });

  it('.get() returns undefined on a miss — NOT null', async () => {
    // Call sites do `if (!row)` and `row?.x`; a null/undefined split would still pass
    // those but breaks `=== undefined` checks and default-parameter behaviour.
    const row = await store.prepare(`SELECT * FROM conf WHERE id = ?`).get('nope');
    expect(row).toBeUndefined();
  });

  it('.get() returns the first row when several match', async () => {
    await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('a', 1);
    await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('b', 2);
    const row = await store.prepare(`SELECT id FROM conf ORDER BY id`).get<{ id: string }>();
    expect(row?.id).toBe('a');
  });

  it('.all() returns [] rather than undefined when nothing matches', async () => {
    expect(await store.prepare(`SELECT * FROM conf WHERE id = ?`).all('nope')).toEqual([]);
  });

  it('.run() reports the affected row count as `changes`', async () => {
    await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('a', 1);
    await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('b', 1);
    const r = await store.prepare(`UPDATE conf SET label = ? WHERE n = ?`).run('x', 1);
    expect(r.changes).toBe(2);

    const none = await store.prepare(`UPDATE conf SET label = ? WHERE n = ?`).run('x', 99);
    expect(none.changes).toBe(0);
  });

  it('a statement is reusable across calls', async () => {
    const ins = store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`);
    await ins.run('a', 1);
    await ins.run('b', 2);
    expect(await store.prepare(`SELECT * FROM conf`).all()).toHaveLength(2);
  });

  it('rejects rather than throwing synchronously on a bad statement', async () => {
    // The distinction matters: a synchronous throw escapes `.catch()` on one backend
    // and not the other, so error handling would silently differ after the flip.
    let threwSync = false;
    let rejected = false;
    try {
      const p = store.prepare(`SELECT * FROM table_that_does_not_exist`).all();
      await p.catch(() => { rejected = true; });
    } catch {
      threwSync = true;
    }
    expect(threwSync).toBe(false);
    expect(rejected).toBe(true);
  });

  it('commits a transaction', async () => {
    await store.transaction(async () => {
      await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('a', 1);
      await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('b', 2);
    });
    expect(await store.prepare(`SELECT * FROM conf`).all()).toHaveLength(2);
  });

  it('discards the whole transaction on a throw', async () => {
    await expect(
      store.transaction(async () => {
        await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('a', 1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.prepare(`SELECT * FROM conf`).all()).toHaveLength(0);
  });

  it('returns the callback value from a committed transaction', async () => {
    const out = await store.transaction(async () => {
      await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('a', 1);
      return 'result';
    });
    expect(out).toBe('result');
  });

  it('nests: an inner rollback leaves the outer transaction usable', async () => {
    await store.transaction(async () => {
      await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('outer', 1);
      await expect(
        store.transaction(async () => {
          await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('inner', 2);
          throw new Error('inner boom');
        }),
      ).rejects.toThrow('inner boom');
      // On Postgres without SAVEPOINT handling this next statement fails with
      // "current transaction is aborted"; on SQLite an unguarded ROLLBACK would have
      // ended the outer transaction entirely.
      await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('after', 3);
    });

    const ids = (await store.prepare(`SELECT id FROM conf ORDER BY id`).all<{ id: string }>())
      .map((r) => r.id);
    expect(ids).toEqual(['after', 'outer']);
  });

  it('nests: a committed inner transaction persists with the outer', async () => {
    await store.transaction(async () => {
      await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('outer', 1);
      await store.transaction(async () => {
        await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('inner', 2);
      });
    });
    expect(await store.prepare(`SELECT * FROM conf`).all()).toHaveLength(2);
  });

  it('an outer rollback discards committed inner work too', async () => {
    await expect(
      store.transaction(async () => {
        await store.transaction(async () => {
          await store.prepare(`INSERT INTO conf (id, n) VALUES (?, ?)`).run('inner', 1);
        });
        throw new Error('outer boom');
      }),
    ).rejects.toThrow('outer boom');
    expect(await store.prepare(`SELECT * FROM conf`).all()).toHaveLength(0);
  });

  it('reports its own backend name', () => {
    expect(['sqlite', 'postgres']).toContain(store.backend);
  });
});
