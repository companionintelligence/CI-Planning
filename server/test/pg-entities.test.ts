import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { initPlanningDataSource, closePlanningDataSource } from '../src/db/datasource.js';
import { PLANNING_ENTITIES } from '../src/db/entities/index.js';
import { AppConfigEntity } from '../src/db/entities/AppConfigEntity.js';
import { OwnersEntity } from '../src/db/entities/OwnersEntity.js';

/**
 * Proves the generated entities actually MAP onto the ported schema, rather than merely
 * compiling. TypeORM will happily load metadata for a column that does not exist — the
 * failure only shows up at query time — so this issues real queries through the
 * repository API and cross-checks every entity's table and column names against
 * information_schema.
 */
const URL_ = process.env.PG_TEST_URL;
const MIGRATIONS = join(import.meta.dirname, '..', 'db', 'postgres', 'migrations');

function upSection(file: string): string {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');
  return sql.slice(start + '-- migrate:up'.length, end === -1 ? undefined : end);
}

describe.skipIf(!URL_)('generated TypeORM entities', () => {
  beforeAll(async () => {
    const c = new Client({ connectionString: URL_ });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS planning CASCADE');
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await c.query(upSection(f));
    }
    await c.end();
    await initPlanningDataSource(URL_!);
  });

  afterAll(async () => {
    await closePlanningDataSource();
    const c = new Client({ connectionString: URL_ });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS planning CASCADE');
    await c.end();
  });

  it('registers one entity per ported table', () => {
    expect(PLANNING_ENTITIES).toHaveLength(56);
  });

  it('every entity maps to a table and columns that really exist', async () => {
    const ds = (await initPlanningDataSource(URL_!));
    const actual = new Map<string, Set<string>>();
    const rows: { table_name: string; column_name: string }[] = await ds.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'planning'`,
    );
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }

    const problems: string[] = [];
    for (const meta of ds.entityMetadatas) {
      const cols = actual.get(meta.tableName);
      if (!cols) {
        problems.push(`${meta.name}: table "${meta.tableName}" missing`);
        continue;
      }
      for (const c of meta.columns) {
        if (!cols.has(c.databaseName)) {
          problems.push(`${meta.name}.${c.propertyName} -> "${c.databaseName}" missing`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('round-trips through the repository API', async () => {
    const ds = await initPlanningDataSource(URL_!);
    const repo = ds.getRepository(AppConfigEntity);
    await repo.save(repo.create({ key: 'entity-test', value: 'hello', updatedAt: '2026-08-02 00:00:00' }));

    const found = await repo.findOneBy({ key: 'entity-test' });
    expect(found?.value).toBe('hello');
    // camelCase property, snake_case column — the mapping actually applied.
    expect(found?.updatedAt).toBe('2026-08-02 00:00:00');
  });

  it('maps nullable columns to `| null` rather than dropping them', async () => {
    const ds = await initPlanningDataSource(URL_!);
    const repo = ds.getRepository(OwnersEntity);
    const saved = await repo.save(repo.create({ id: '22222222-2222-7222-8222-222222222222', name: 'Nullable' }));
    const found = await repo.findOneBy({ id: saved.id });
    expect(found?.name).toBe('Nullable');
    expect(found?.externalSubject).toBeNull(); // nullable auth column, absent on a local owner
  });
});
