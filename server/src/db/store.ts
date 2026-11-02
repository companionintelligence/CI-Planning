import type { Database, Statement } from 'better-sqlite3';
import { prepare as pgPrepare, transaction as pgTransaction, execRaw as pgExec } from './pg.js';

/**
 * The backend-agnostic data facade — one async API that both SQLite and Postgres
 * implement, so the store swap and the async migration can be done SEPARATELY.
 *
 * Why this exists rather than porting call sites straight to `pg`:
 *
 * The expensive, risky half of this migration is not SQL, it is that better-sqlite3 is
 * SYNCHRONOUS and `pg` is not: every call site becomes an `await` and every enclosing
 * function becomes async. Porting those directly to Postgres means the test suite proves
 * nothing until the very last edit lands, with a red suite the whole way.
 *
 * With this facade the same work is done in two independently-verifiable passes:
 *
 *   1. DONE — move the call sites to `await store().prepare(...)`, with the SQLite
 *      backend underneath. The suite stayed GREEN at every commit, because the data store
 *      did not change — only the shape of the calls. The raw `sqlite.*` left in
 *      `server/src` is the sqlite-vec dedupe in `agents/groom.ts` and this seam.
 *   2. NOT DONE — flip `STORE_BACKEND` to Postgres. That is the cutover. It also needs the
 *      Postgres baseline brought up to SQLite first: it stops at migration 0147 (see
 *      server/db/postgres/README.md). Then the suite says what is wrong (dialect
 *      differences: INSERT OR IGNORE, strftime, and so on).
 *
 * Each pass is reviewable and revertible on its own, and neither has a window where the
 * suite is meaningless. That is the whole justification for the indirection — it is not
 * an abstraction for its own sake, and it is DELETED once the cutover lands.
 *
 * The SQLite backend deliberately wraps synchronous results in already-resolved
 * promises. That is not "fake async": it is what lets pass 1 be a pure refactor, and it
 * costs a microtask per query in a process that is about to be doing real network I/O
 * per query anyway.
 */

export interface StoreStatement {
  get<T = unknown>(...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<{ changes: number }>;
}

export interface Store {
  prepare(sql: string): StoreStatement;
  /** Runs `fn` inside a transaction. Note this RUNS it, unlike better-sqlite3's
   *  `transaction()` which returns a callable — `sqlite.transaction(fn)()` becomes
   *  `await store.transaction(fn)`. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Multi-statement DDL/utility execution, no parameters (`sqlite.exec`). */
  exec(sql: string): Promise<void>;
  readonly backend: 'sqlite' | 'postgres';
}

/**
 * SQLite backend. Every method resolves immediately — better-sqlite3 is synchronous, so
 * there is nothing to await underneath. Errors still reject rather than throw
 * synchronously, so a caller's `try/catch` around `await` behaves identically on both
 * backends; a synchronous throw from inside `prepare()` would otherwise escape a
 * `.catch()` on one backend and not the other.
 */
export function createSqliteStore(db: Database): Store {
  return {
    backend: 'sqlite',
    prepare(sql: string): StoreStatement {
      // Prepared lazily: better-sqlite3 throws on a statement whose table does not
      // exist yet, and module-level `prepare` calls run before migrations in some
      // import orders. Postgres has the same property, so this keeps them alike.
      // Explicit `unknown[]` binding generic: better-sqlite3's default overload infers a
      // fixed-arity tuple, which then rejects the variadic spread below (and, worse,
      // rejects the zero-parameter case that plenty of statements use).
      let stmt: Statement<unknown[], unknown> | undefined;
      const get_ = () => (stmt ??= db.prepare<unknown[], unknown>(sql));
      return {
        async get<T>(...params: unknown[]) {
          return get_().get(...params) as T | undefined;
        },
        async all<T>(...params: unknown[]) {
          return get_().all(...params) as T[];
        },
        async run(...params: unknown[]) {
          const r = get_().run(...params);
          return { changes: r.changes };
        },
      };
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // better-sqlite3's own `transaction()` cannot wrap an async function — it commits
      // when the synchronous callback returns, which for an async one is at the first
      // await, leaving the rest outside the transaction. So the statements are issued
      // directly. SQLite transactions are connection-scoped and better-sqlite3 has one
      // connection, so this is exactly what its wrapper does underneath, minus the
      // synchronous assumption. SAVEPOINT gives the same nesting semantics as the
      // Postgres backend.
      const depth = sqliteTxDepth++;
      const name = `sp_${depth}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
      try {
        const out = await fn();
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (err) {
        try {
          db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${name}`);
        } catch {
          /* a failed rollback must not mask the original error */
        }
        throw err;
      } finally {
        sqliteTxDepth--;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
    },
  };
}

let sqliteTxDepth = 0;

/** Postgres backend — delegates to db/pg.ts (placeholder rewriting, ALS transactions). */
export function createPostgresStore(): Store {
  return {
    backend: 'postgres',
    prepare: (sql: string) => pgPrepare(sql),
    transaction: (fn) => pgTransaction(fn),
    exec: (sql: string) => pgExec(sql),
  };
}

let active: Store | undefined;

/** Install the backend for this process. Called once during boot (and by the tests). */
export function setStore(s: Store): void {
  active = s;
}

export function store(): Store {
  if (!active) throw new Error('store not initialised — setStore() must run during boot');
  return active;
}
