import { AsyncLocalStorage } from 'node:async_hooks';
import pkg, { type Pool as PoolType, type PoolClient } from 'pg';
import { logger } from '../lib/logger.js';

const { Pool } = pkg;

/**
 * Postgres access layer, shaped to match the better-sqlite3 handle it replaces.
 *
 * The app was written against `sqlite.prepare(sql).get/all/run(...)`; those call sites now go
 * through `store.ts`, which uses this module when STORE_BACKEND=postgres.
 * Postgres is async and speaks `$1` placeholders, so a naive swap would mean rewriting
 * every one of those statements AND every function that transitively calls them. This
 * module removes the first half of that: same `prepare().get/all/run()` shape, same `?`
 * placeholders, same `{ changes }` result — so a call site ports by adding `await` and
 * changing `sqlite` to `pg`, not by being redesigned. The async cascade through callers
 * is unavoidable; the SQL text does not have to change too.
 *
 * TRANSACTIONS use AsyncLocalStorage rather than a threaded handle, for the same reason:
 * `pg.transaction(async () => { … })` makes every `pg.prepare` inside the callback —
 * including ones several calls deep — run on that transaction's client automatically,
 * so the existing transaction sites keep their bodies unchanged. The
 * repo already uses this pattern for owner scoping (`runWithOwner` / `currentOwnerId`),
 * so it is an established idiom here, not a new concept.
 *
 * Concurrency note: a pooled Postgres client must NOT be shared across interleaved
 * async work, which is exactly the trap AsyncLocalStorage avoids — each transaction
 * gets its own client, and only code running inside that callback's async context sees
 * it. Nested `transaction()` calls join the outer one via SAVEPOINT rather than
 * deadlocking on a second checkout from the pool.
 */

let pool: PoolType | undefined;

/** The client bound to the innermost active transaction, if any. */
const txStore = new AsyncLocalStorage<{ client: PoolClient; depth: number }>();

export interface PgConfig {
  connectionString: string;
  /** Set as the connection's `search_path`, so unqualified table names resolve. */
  schema?: string;
  max?: number;
}

export function initPg(cfg: PgConfig): PoolType {
  if (pool) return pool;
  const schema = cfg.schema ?? 'planning';
  pool = new Pool({
    connectionString: cfg.connectionString,
    max: cfg.max ?? 10,
    // Every checkout starts in the planning schema, so ported statements keep their
    // unqualified table names (`FROM tasks`) exactly as the SQLite ones had them.
    // `public` stays on the path for extensions (pgvector's operators live there).
    options: `-c search_path=${schema},public`,
  });
  pool.on('error', (err) => logger.error('pg pool error', { err: err.message }));
  logger.info('Postgres pool created', { schema, max: cfg.max ?? 10 });
  return pool;
}

function activePool(): PoolType {
  if (!pool) throw new Error('Postgres pool not initialised — call initPg() during boot');
  return pool;
}

/**
 * Rewrite SQLite `?` placeholders to Postgres `$1..$n`.
 *
 * Literal-aware on purpose: a `?` inside a quoted string or a comment is DATA, not a
 * parameter, and renumbering it would both corrupt the value and shift every parameter
 * after it — a silent, data-dependent bug rather than a loud one. Handles single-quoted
 * strings (including SQL's doubled-quote escape `''`), double-quoted identifiers,
 * dollar-quoted bodies, `--` line comments and `/* *\/` block comments.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let n = 0;
  while (i < sql.length) {
    const c = sql[i];

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; } // '' / "" escape
          break;
        }
        j++;
      }
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (c === '$' && sql[i + 1] === '$') { // dollar-quoted body (function definitions)
      const end = sql.indexOf('$$', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (c === '?') {
      out += `$${++n}`;
      i++;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** better-sqlite3's `RunResult`, minus what Postgres cannot provide. */
export interface PgRunResult {
  changes: number;
}

export interface PgStatement {
  get<T = unknown>(...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<PgRunResult>;
}

async function exec(text: string, params: unknown[]) {
  const active = txStore.getStore();
  if (active) return active.client.query(text, params);
  return activePool().query(text, params);
}

/**
 * Prepare a statement. Mirrors `sqlite.prepare` — the returned object is reusable and
 * carries no connection of its own, so a module-level `const stmt = pg.prepare(...)`
 * stays valid across pool checkouts and inside transactions (the client is resolved per
 * call, from the async context).
 */
export function prepare(sql: string): PgStatement {
  const text = toPgPlaceholders(sql);
  return {
    async get<T>(...params: unknown[]) {
      const r = await exec(text, params);
      return r.rows[0] as T | undefined;
    },
    async all<T>(...params: unknown[]) {
      const r = await exec(text, params);
      return r.rows as T[];
    },
    async run(...params: unknown[]) {
      const r = await exec(text, params);
      // `lastInsertRowid` has no Postgres equivalent and is deliberately absent rather
      // than faked — the two call sites that read it must use `RETURNING id` instead,
      // which is what the app's uuid7 ids want anyway.
      return { changes: r.rowCount ?? 0 };
    },
  };
}

/** Multi-statement DDL/utility execution (`sqlite.exec`). No parameters. */
export async function execRaw(sql: string): Promise<void> {
  await exec(sql, []);
}

/**
 * Run `fn` inside a transaction. Unlike better-sqlite3's `transaction()`, which returns
 * a callable, this RUNS the callback — `sqlite.transaction(fn)()` becomes
 * `await pg.transaction(fn)`.
 *
 * A nested call joins the enclosing transaction through a SAVEPOINT, so an inner
 * rollback undoes only the inner work and the outer transaction survives. Without that,
 * a nested call would try to check out a second pooled client and could deadlock
 * against its own parent while the parent waits on it.
 */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const outer = txStore.getStore();

  if (outer) {
    const name = `sp_${outer.depth + 1}`;
    await outer.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await txStore.run({ client: outer.client, depth: outer.depth + 1 }, fn);
      await outer.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await outer.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }

  const client = await activePool().connect();
  try {
    await client.query('BEGIN');
    const result = await txStore.run({ client, depth: 0 }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Best-effort rollback: if the connection itself died the ROLLBACK will throw too,
    // and surfacing THAT would bury the original error the caller needs to see.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('pg rollback failed', { err: (rollbackErr as Error).message });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePg(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** The better-sqlite3-shaped facade the ported call sites import. */
export const pg = { prepare, transaction, exec: execRaw, init: initPg, close: closePg };
