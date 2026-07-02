import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0099 from '../src/db/migrations/0099_time_blocks_owner_id.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { applyOp, type Op } from '../src/sync/apply.js';
import { reflow } from '../src/engine/auto-defense.js';
import { ensureRecurringBlocksForRange } from '../src/engine/blocks-recur.js';
import { createOwner, resetDb, startTestServer, api, SECOND_OWNER_ID, type TestServer } from './helpers.js';

/**
 * T1 (multi-tenant) — owner-scoping `time_blocks`. Covers migration 0099 (the
 * NOT NULL owner_id rebuild + backfill + indexes), the applyOp block owner-check
 * (L Gap 5), HTTP owner-isolation (via T0's `x-test-owner` header), the reflow /
 * recurrence cross-owner non-interference faults (F-REFLOW / G-RECUR), and the
 * backup restore wipe-scoping.
 */

// The exact physical column order the rebuild must reproduce (31 legacy columns +
// owner_id inserted at position 3, mirroring the sibling `time_entries`).
const EXPECTED_COLS = [
  'id', 'task_id', 'owner_id', 'title', 'block_kind', 'start_at', 'end_at',
  'is_locked', 'is_auto', 'source_kind', 'source_ref', 'status', 'created_at',
  'all_day', 'tag', 'block_type', 'goal_start_date', 'duration_minutes', 'note',
  'parent_block_id', 'recurrence_rule', 'recurrence_dtstart', 'recurrence_parent_id',
  'occurrence_date', 'auto_run_id', 'last_moved_at', 'category_id', 'color_token',
  'recurrence_exdates', 'version', 'updated_at', 'field_ts',
];

const EXPECTED_INDEXES = [
  'ix_time_blocks_task', 'ix_time_blocks_category', 'ix_time_blocks_parent',
  'ix_time_blocks_pattern_source', 'ux_block_occurrence', 'ux_time_blocks_ingest_source',
  'ix_time_blocks_owner_start',
];

// ── Migration 0099 — schema shape, FK, indexes, integrity, idempotency ──────────

describe('0099 time_blocks.owner_id — migrated schema', () => {
  const fresh = () => new BetterSqlite3(':memory:');
  const cols = (db: Database) =>
    db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string; notnull: number }[];

  it('adds owner_id (NOT NULL, position 3) and preserves every other column + order', () => {
    const db = fresh();
    runMigrations(db);
    const c = cols(db);
    expect(c.map((x) => x.name)).toEqual(EXPECTED_COLS);
    expect(c.find((x) => x.name === 'owner_id')?.notnull).toBe(1);
    db.close();
  });

  it('owner_id is an enforced FK to owners(id) with ON DELETE CASCADE', () => {
    const db = fresh();
    runMigrations(db);
    const fk = (
      db.prepare(`PRAGMA foreign_key_list(time_blocks)`).all() as {
        table: string; from: string; to: string; on_delete: string;
      }[]
    ).find((f) => f.from === 'owner_id');
    expect(fk).toMatchObject({ table: 'owners', to: 'id', on_delete: 'CASCADE' });
    db.close();
  });

  it('recreates all 6 pre-existing indexes and adds ix_time_blocks_owner_start', () => {
    const db = fresh();
    runMigrations(db);
    const present = new Set(
      (db.prepare(`PRAGMA index_list(time_blocks)`).all() as { name: string }[]).map((i) => i.name),
    );
    for (const name of EXPECTED_INDEXES) expect(present.has(name), `missing index ${name}`).toBe(true);
    db.close();
  });

  it('leaves the schema sound (integrity + zero orphan owner_id) and is idempotent', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const orphans = db
      .prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE owner_id NOT IN (SELECT id FROM owners)`)
      .get() as { n: number };
    expect(orphans.n).toBe(0);

    // The runner skips an already-applied migration; up()'s own guard no-ops on re-run.
    expect(runMigrations(db).applied).toEqual([]);
    const before = cols(db).map((c) => c.name);
    expect(() => m0099.up(db)).not.toThrow();
    expect(cols(db).map((c) => c.name)).toEqual(before);
    db.close();
  });

  it('the owner-scoped range read plans against ix_time_blocks_owner_start (not a scan)', () => {
    const db = fresh();
    runMigrations(db);
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM time_blocks WHERE owner_id = ? AND start_at >= ? AND end_at <= ?`)
      .all(SYSTEM_OWNER_ID, '2026-06-22T00:00:00Z', '2026-06-22T23:59:59Z') as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toMatch(/USING (COVERING )?INDEX ix_time_blocks_owner_start/);
    expect(detail).not.toMatch(/SCAN time_blocks/);
    db.close();
  });
});

// ── Migration 0099 — backfill correctness on legacy (pre-owner_id) rows ─────────

describe('0099 time_blocks.owner_id — backfill', () => {
  it('backfills task-backed blocks to the task owner and task_id-NULL blocks to the single owner', () => {
    const db = new BetterSqlite3(':memory:');
    // Minimal pre-0099 world: FK targets + a time_blocks WITHOUT owner_id.
    db.exec(`CREATE TABLE owners (id TEXT PRIMARY KEY NOT NULL, name TEXT);`);
    db.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL);`);
    db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES owners(id));`);
    db.exec(`
      CREATE TABLE time_blocks (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL, block_kind TEXT DEFAULT 'task',
        start_at TEXT NOT NULL, end_at TEXT NOT NULL,
        is_locked INTEGER DEFAULT 0, is_auto INTEGER DEFAULT 1,
        source_kind TEXT DEFAULT 'manual', source_ref TEXT, status TEXT DEFAULT 'planned',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, all_day INTEGER DEFAULT 0, tag TEXT,
        block_type TEXT, goal_start_date TEXT, duration_minutes INTEGER, note TEXT,
        parent_block_id TEXT REFERENCES time_blocks(id) ON DELETE SET NULL,
        recurrence_rule TEXT, recurrence_dtstart TEXT, recurrence_parent_id TEXT,
        occurrence_date TEXT, auto_run_id TEXT, last_moved_at TEXT,
        category_id TEXT REFERENCES tags(id) ON DELETE SET NULL, color_token TEXT,
        recurrence_exdates TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, field_ts TEXT
      );
    `);
    // SYSTEM_OWNER_ID sorts first (zero timestamp bytes) → it is the "single owner" fallback.
    db.prepare(`INSERT INTO owners (id, name) VALUES (?, 'Liam'), (?, 'Owner B')`).run(SYSTEM_OWNER_ID, SECOND_OWNER_ID);
    db.prepare(`INSERT INTO tasks (id, owner_id) VALUES ('task-b', ?)`).run(SECOND_OWNER_ID);
    db.prepare(`INSERT INTO time_blocks (id, task_id, title, start_at, end_at) VALUES ('blk-task', 'task-b', 'T', '2026-06-22T10:00:00Z', '2026-06-22T11:00:00Z')`).run();
    db.prepare(`INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at) VALUES ('blk-cont', NULL, 'Container', 'timeblock', '2026-06-22T09:00:00Z', '2026-06-22T12:00:00Z')`).run();

    m0099.up(db);

    const byId = Object.fromEntries(
      (db.prepare(`SELECT id, owner_id FROM time_blocks`).all() as { id: string; owner_id: string }[]).map((r) => [r.id, r.owner_id]),
    );
    expect(byId['blk-task']).toBe(SECOND_OWNER_ID); // inherits its task's owner
    expect(byId['blk-cont']).toBe(SYSTEM_OWNER_ID);  // task_id NULL → the single owner
    const nulls = db.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE owner_id IS NULL`).get() as { n: number };
    expect(nulls.n).toBe(0);
    db.close();
  });
});

// ── Shared-DB helpers ───────────────────────────────────────────────────────────

const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

/** Insert a time_blocks row directly (owner_id is now required). Returns the id. */
function insertBlock(id: string, owner: string, over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    id, owner_id: owner, title: 'Block', block_kind: 'task',
    start_at: at('10:00'), end_at: at('11:00'), is_auto: 1, is_locked: 0,
    source_kind: 'agent', status: 'planned', version: 1, ...over,
  };
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO time_blocks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
  return id;
}

// ── applyOp — block owner-check (L Gap 5) ───────────────────────────────────────

describe('applyOp — block owner isolation (L Gap 5)', () => {
  beforeEach(() => resetDb());

  it('rejects a block op from a different owner as not found', () => {
    insertBlock('blk-1', SYSTEM_OWNER); // owned by SYSTEM_OWNER
    expect(() =>
      applyOp(sqlite, {
        opId: 'op-1', entity: 'block', entityId: 'blk-1',
        fields: { title: 'hijacked' }, baseVersion: 1, clientTs: at('12:00'),
      } as Op, SECOND_OWNER_ID),
    ).toThrow('not found');
    // The block is untouched.
    expect((sqlite.prepare(`SELECT title FROM time_blocks WHERE id = 'blk-1'`).get() as { title: string }).title).toBe('Block');
  });

  it('applies an owned block op but never lets a synced op author owner_id', () => {
    insertBlock('blk-2', SYSTEM_OWNER);
    const result = applyOp(sqlite, {
      opId: 'op-2', entity: 'block', entityId: 'blk-2',
      fields: { owner_id: SECOND_OWNER_ID, title: 'renamed' }, baseVersion: 1, clientTs: at('12:00'),
    } as Op, SYSTEM_OWNER);
    expect(result.applied).toEqual({ title: 'renamed' }); // owner_id silently dropped (not in BLOCK_FIELDS)
    const row = sqlite.prepare(`SELECT owner_id, title FROM time_blocks WHERE id = 'blk-2'`).get() as { owner_id: string; title: string };
    expect(row.owner_id).toBe(SYSTEM_OWNER); // owner unchanged
    expect(row.title).toBe('renamed');
  });
});

// ── HTTP owner-isolation via the x-test-owner header ────────────────────────────

describe('time_blocks HTTP owner-isolation', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { resetDb(); createOwner(); }); // SYSTEM_OWNER + Owner B (SECOND_OWNER_ID)

  const asB = { headers: { 'x-test-owner': SECOND_OWNER_ID } };

  async function createBlockAsSystem(): Promise<string> {
    const r = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'A block', start_at: at('10:00'), end_at: at('11:00') },
    });
    expect(r.status).toBe(201);
    return r.body.block.id as string;
  }

  it('owner B never sees owner A blocks in the range read', async () => {
    const aId = await createBlockAsSystem();
    const r = await api(srv.url, `/api/blocks?from=${at('00:00')}&to=${at('23:59')}`, asB);
    expect(r.status).toBe(200);
    expect((r.body.blocks as { id: string }[]).some((b) => b.id === aId)).toBe(false);
  });

  it('owner B cannot PATCH, DELETE, move-group, or promote owner A blocks (404)', async () => {
    const aId = await createBlockAsSystem();
    expect((await api(srv.url, `/api/blocks/${aId}`, { ...asB, method: 'PATCH', json: { title: 'x' } })).status).toBe(404);
    expect((await api(srv.url, `/api/blocks/${aId}/move-group`, { ...asB, method: 'POST', json: { delta_minutes: 30 } })).status).toBe(404);
    expect((await api(srv.url, `/api/blocks/${aId}/promote`, { ...asB, method: 'POST', json: { start_at: at('14:00') } })).status).toBe(404);
    expect((await api(srv.url, `/api/blocks/${aId}`, { ...asB, method: 'DELETE' })).status).toBe(404);
    // Still there for its real owner.
    expect(sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(aId)).toBeTruthy();
  });

  it("owner A never sees owner B's blocks", async () => {
    const r = await api(srv.url, '/api/blocks', { ...asB, method: 'POST', json: { title: 'B block', start_at: at('10:00'), end_at: at('11:00') } });
    expect(r.status).toBe(201);
    const bId = r.body.block.id as string;
    const seen = await api(srv.url, `/api/blocks?from=${at('00:00')}&to=${at('23:59')}`); // as SYSTEM
    expect((seen.body.blocks as { id: string }[]).some((b) => b.id === bId)).toBe(false);
  });
});

// ── Cross-owner non-interference: reflow (F-REFLOW) + recurrence (G-RECUR) ───────

describe('time_blocks cross-owner non-interference', () => {
  beforeEach(() => { resetDb(); createOwner(); });

  it('reflow(B) never deletes or moves owner A auto blocks (F-REFLOW)', () => {
    // Owner A (SYSTEM) has an auto task-block; a bare reflow for owner B must not
    // clear or move it (clearPriorAuto + snapshotAutoBlocks are owner-scoped now).
    insertBlock('a-auto', SYSTEM_OWNER, { start_at: at('10:00'), end_at: at('11:00') });
    reflow(SECOND_OWNER_ID, DAY);
    const row = sqlite.prepare(`SELECT start_at, end_at, status FROM time_blocks WHERE id = 'a-auto'`).get() as
      | { start_at: string; end_at: string; status: string }
      | undefined;
    expect(row).toMatchObject({ start_at: at('10:00'), end_at: at('11:00'), status: 'planned' });
  });

  it('a GET-driven recurrence materialization for B never expands owner A templates (G-RECUR)', () => {
    const today = new Date().toISOString().slice(0, 10);
    // Owner A owns a DAILY recurring container template (rule set, no parent).
    insertBlock('a-tmpl', SYSTEM_OWNER, {
      block_kind: 'timeblock', title: 'Daily focus', is_auto: 0, source_kind: 'manual',
      start_at: `${today}T09:00:00.000Z`, end_at: `${today}T10:00:00.000Z`,
      recurrence_rule: 'FREQ=DAILY', recurrence_dtstart: `${today}T09:00:00.000Z`,
    });
    const from = `${today}T00:00:00.000Z`;
    const to = new Date(Date.parse(from) + 2 * 86_400_000).toISOString();

    ensureRecurringBlocksForRange(SECOND_OWNER_ID, from, to); // B: sees no template → materializes nothing
    ensureRecurringBlocksForRange(SYSTEM_OWNER, from, to);     // A: its own template DOES fire (sanity)

    const bInstances = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE owner_id = ? AND recurrence_parent_id IS NOT NULL`)
      .get(SECOND_OWNER_ID) as { n: number };
    const aInstances = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE owner_id = ? AND recurrence_parent_id = 'a-tmpl'`)
      .get(SYSTEM_OWNER) as { n: number };
    expect(aInstances.n).toBeGreaterThanOrEqual(1); // the template is live
    expect(bInstances.n).toBe(0);                   // …but never for owner B
  });
});

// ── Backup restore — owner-scoped wipe leaves other owners' blocks intact ───────

describe('backup restore isolation (time_blocks wipe scoping)', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { resetDb(); createOwner(); });

  it("importing owner A's export leaves owner B's blocks intact", async () => {
    // Owner B has a block that must survive owner A's restore.
    insertBlock('b-survivor', SECOND_OWNER_ID, { title: 'B keep', is_auto: 0, source_kind: 'manual' });
    // Owner A (SYSTEM) creates a block, exports, then restores that export.
    await api(srv.url, '/api/blocks', { method: 'POST', json: { title: 'A block', start_at: at('10:00'), end_at: at('11:00') } });
    const exported = await api(srv.url, '/api/export');
    expect(exported.status).toBe(200);
    expect(exported.body.version).toBe('5');
    const imported = await api(srv.url, '/api/import', { method: 'POST', json: exported.body });
    expect(imported.status).toBe(200);
    // The owner-scoped `DELETE FROM time_blocks WHERE owner_id = ?` never touched B.
    expect(sqlite.prepare(`SELECT title FROM time_blocks WHERE id = 'b-survivor'`).get()).toMatchObject({ title: 'B keep' });
  });
});
