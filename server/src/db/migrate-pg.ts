import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../lib/logger.js';

/**
 * Forward-only Postgres migration runner — the counterpart to migrate.ts, and
 * **wire-compatible with the dbmate CLI** so the two are interchangeable.
 *
 * Compatibility is the whole point rather than a nicety: CI-Server's migrations are run
 * by `dbmate`, and an operator who runs `dbmate up` against this database must not end
 * up with a second, competing history. dbmate tracks applied migrations in a
 * `schema_migrations(version)` table keyed by the filename's numeric prefix, so this
 * uses exactly that table and exactly those keys. Either tool can apply a migration and
 * the other will see it as done.
 *
 * The app runs this at boot so a container comes up migrated with no separate step
 * (matching how the SQLite build behaved); the CLI stays available for operators who
 * want to migrate ahead of a deploy.
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db', 'postgres', 'migrations');

/** dbmate's key: the leading numeric component of the filename. */
function versionOf(file: string): string {
  const m = /^(\d+)_/.exec(file);
  if (!m) throw new Error(`migration filename must start with a numeric version: ${file}`);
  return m[1];
}

/**
 * The `-- migrate:up` half. dbmate splits on these markers and only ever runs one
 * direction; applying the whole file would immediately undo the migration with its own
 * `-- migrate:down` (which is exactly what happens if you pipe one of these into psql).
 */
export function upSection(sql: string): string {
  const start = sql.indexOf('-- migrate:up');
  if (start === -1) throw new Error('migration is missing a `-- migrate:up` marker');
  const end = sql.indexOf('-- migrate:down');
  return sql.slice(start + '-- migrate:up'.length, end === -1 ? undefined : end);
}

export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // timestamp-prefixed, so lexical order IS chronological order
}

export interface PgMigrateResult {
  applied: string[];
}

/**
 * Apply every pending migration, in order, each inside its own transaction together
 * with its bookkeeping row — so a failure leaves earlier migrations applied and this
 * one wholly absent, and a re-run resumes rather than double-applying.
 *
 * `schema` is created first because the tracking table lives inside it: the very first
 * migration is the one that would otherwise create it, and it cannot record itself into
 * a schema that does not exist yet.
 */
export async function runPgMigrations(
  pool: Pool,
  opts: { schema?: string; dir?: string } = {},
): Promise<PgMigrateResult> {
  const schema = opts.schema ?? 'planning';
  const dir = opts.dir ?? MIGRATIONS_DIR;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (version varchar(255) PRIMARY KEY)`,
  );

  const done = new Set(
    (await pool.query<{ version: string }>(`SELECT version FROM ${schema}.schema_migrations`))
      .rows.map((r) => r.version),
  );

  const applied: string[] = [];
  for (const file of migrationFiles(dir)) {
    const version = versionOf(file);
    if (done.has(version)) continue;

    const sql = upSection(readFileSync(join(dir, file), 'utf8'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO ${schema}.schema_migrations (version) VALUES ($1)`,
        [version],
      );
      await client.query('COMMIT');
      applied.push(file);
      logger.info('pg migration applied', { file });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Fail loudly with the filename: a half-migrated database is the one state an
      // operator must never have to diagnose from a bare Postgres error.
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return { applied };
}
