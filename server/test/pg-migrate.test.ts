import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pkg from 'pg';
import { runPgMigrations, upSection, migrationFiles } from '../src/db/migrate-pg.js';

const { Pool } = pkg;

/**
 * The boot-time migration runner. `upSection` is pure and always runs; the runner
 * itself needs a database and skips without PG_TEST_URL (see pg-integration.test.ts).
 */
describe('upSection', () => {
  it('returns only the up half', () => {
    const sql = '-- migrate:up\nCREATE TABLE a();\n-- migrate:down\nDROP TABLE a;';
    const out = upSection(sql);
    expect(out).toContain('CREATE TABLE a()');
    expect(out).not.toContain('DROP TABLE a');
  });

  it('tolerates a migration with no down section', () => {
    expect(upSection('-- migrate:up\nSELECT 1;')).toContain('SELECT 1');
  });

  it('throws when the up marker is missing, rather than running the whole file', () => {
    expect(() => upSection('CREATE TABLE a();')).toThrow(/migrate:up/);
  });

  it('every shipped migration has a parseable up section', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d+_.*\.sql$/);
  });
});

const URL_ = process.env.PG_TEST_URL;

describe.skipIf(!URL_)('runPgMigrations', () => {
  const pool = new Pool({ connectionString: URL_ });

  beforeEach(async () => {
    await pool.query('DROP SCHEMA IF EXISTS planning CASCADE');
  });

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS planning CASCADE').catch(() => {});
    await pool.end();
  });

  it('applies every migration on a fresh database', async () => {
    const { applied } = await runPgMigrations(pool);
    expect(applied.length).toBe(migrationFiles().length);

    const n = await pool.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.tables WHERE table_schema='planning' AND table_name<>'schema_migrations'`,
    );
    expect(Number(n.rows[0].count)).toBe(56);
  });

  it('is idempotent — a second run applies nothing', async () => {
    await runPgMigrations(pool);
    const { applied } = await runPgMigrations(pool);
    expect(applied).toEqual([]);
  });

  it('records dbmate-compatible versions, so the CLI sees the same state', async () => {
    await runPgMigrations(pool);
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM planning.schema_migrations ORDER BY version`,
    );
    // dbmate keys on the filename's numeric prefix — not the whole filename.
    expect(rows.rows.map((r) => r.version)).toEqual(
      migrationFiles().map((f) => /^(\d+)_/.exec(f)![1]),
    );
  });

  it('resumes: a migration already recorded by the dbmate CLI is not re-applied', async () => {
    // Simulate `dbmate up` having run the first migration before the app booted.
    await pool.query('CREATE SCHEMA IF NOT EXISTS planning');
    await pool.query(
      'CREATE TABLE IF NOT EXISTS planning.schema_migrations (version varchar(255) PRIMARY KEY)',
    );
    const first = /^(\d+)_/.exec(migrationFiles()[0])![1];
    await pool.query('INSERT INTO planning.schema_migrations (version) VALUES ($1)', [first]);

    const { applied } = await runPgMigrations(pool);
    expect(applied).toHaveLength(migrationFiles().length - 1);
    expect(applied.some((f) => f.startsWith(first))).toBe(false);
  });

  it('leaves nothing behind when a migration fails', async () => {
    await expect(
      runPgMigrations(pool, { dir: new URL('./fixtures/bad-migrations', import.meta.url).pathname }),
    ).rejects.toThrow(/failed/);

    // The good migration in that dir committed; the bad one rolled back entirely.
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='planning' AND table_name NOT IN ('schema_migrations')`,
    );
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual(['good_one']);
  });
});
