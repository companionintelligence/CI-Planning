import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0100 from '../src/db/migrations/0100_tags_owner_id.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { resolveTagId } from '../src/services/tags.js';
import { createOwner, resetDb, startTestServer, api, SECOND_OWNER_ID, type TestServer } from './helpers.js';

/**
 * T2 (multi-tenant) — owner-scoping the tag axis. Covers migration 0100 (the owner_id
 * rebuild + UNIQUE(owner_id, name) replacing the global UNIQUE(name) — F-TAGUNIQUE),
 * resolveTagId per-owner namespacing, HTTP owner-isolation (via T0's x-test-owner),
 * cross-owner category rejection, and the backup restore-isolation that owner-scoping
 * the tags wipe finally makes hold for entity_tags (the T1→T2 completion).
 */

const EXPECTED_COLS = ['id', 'owner_id', 'name', 'kind', 'muted', 'is_base'];
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

// ── Migration 0100 — schema, FK, UNIQUE, integrity, idempotency ─────────────────

describe('0100 tags.owner_id — migrated schema', () => {
  const fresh = () => new BetterSqlite3(':memory:');
  const cols = (db: Database) =>
    db.prepare(`PRAGMA table_info(tags)`).all() as { name: string; notnull: number }[];

  it('adds owner_id (NOT NULL, position 2) preserving the other columns + order', () => {
    const db = fresh();
    runMigrations(db);
    const c = cols(db);
    expect(c.map((x) => x.name)).toEqual(EXPECTED_COLS);
    expect(c.find((x) => x.name === 'owner_id')?.notnull).toBe(1);
    db.close();
  });

  it('owner_id is an FK to owners(id) with ON DELETE CASCADE', () => {
    const db = fresh();
    runMigrations(db);
    const fk = (
      db.prepare(`PRAGMA foreign_key_list(tags)`).all() as {
        table: string; from: string; to: string; on_delete: string;
      }[]
    ).find((f) => f.from === 'owner_id');
    expect(fk).toMatchObject({ table: 'owners', to: 'id', on_delete: 'CASCADE' });
    db.close();
  });

  it('replaces the global UNIQUE(name) with UNIQUE(owner_id, name) (F-TAGUNIQUE)', () => {
    const db = fresh();
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO owners (id, name) VALUES (?, 'B')`).run(SECOND_OWNER_ID);
    db.prepare(`INSERT INTO tags (id, owner_id, name) VALUES ('t-a', ?, 'errands')`).run(SYSTEM_OWNER_ID);
    // Two owners CAN both hold a tag named 'errands' — the whole point of T2.
    expect(() =>
      db.prepare(`INSERT INTO tags (id, owner_id, name) VALUES ('t-b', ?, 'errands')`).run(SECOND_OWNER_ID),
    ).not.toThrow();
    // …but one owner still can't hold a duplicate name.
    expect(() =>
      db.prepare(`INSERT INTO tags (id, owner_id, name) VALUES ('t-c', ?, 'errands')`).run(SYSTEM_OWNER_ID),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('leaves the schema sound (integrity + zero orphan owner_id) and is idempotent', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const orphans = db
      .prepare(`SELECT COUNT(*) AS n FROM tags WHERE owner_id NOT IN (SELECT id FROM owners)`)
      .get() as { n: number };
    expect(orphans.n).toBe(0);

    expect(runMigrations(db).applied).toEqual([]);
    const before = cols(db).map((c) => c.name);
    expect(() => m0100.up(db)).not.toThrow();
    expect(cols(db).map((c) => c.name)).toEqual(before);
    db.close();
  });
});

// ── Migration 0100 — backfill to the single owner ───────────────────────────────

describe('0100 tags.owner_id — backfill', () => {
  it('backfills every existing tag to the single owner', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`CREATE TABLE owners (id TEXT PRIMARY KEY NOT NULL, name TEXT);`);
    // pre-0100 tags: global UNIQUE(name), no owner_id.
    db.exec(`CREATE TABLE tags (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'intention', muted INTEGER NOT NULL DEFAULT 0, is_base INTEGER NOT NULL DEFAULT 0
    );`);
    db.prepare(`INSERT INTO owners (id, name) VALUES (?, 'Liam'), (?, 'B')`).run(SYSTEM_OWNER_ID, SECOND_OWNER_ID);
    db.prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES ('t1', 'work', 'pattern', 1), ('t2', 'errands', 'intention', 0)`).run();

    m0100.up(db);

    const rows = db.prepare(`SELECT owner_id FROM tags`).all() as { owner_id: string }[];
    expect(rows.length).toBe(2);
    // SYSTEM_OWNER sorts first among UUIDv7 ids → it is the single backfill owner.
    expect(rows.every((r) => r.owner_id === SYSTEM_OWNER_ID)).toBe(true);
    const nulls = db.prepare(`SELECT COUNT(*) AS n FROM tags WHERE owner_id IS NULL`).get() as { n: number };
    expect(nulls.n).toBe(0);
    db.close();
  });
});

// ── resolveTagId per-owner namespacing (shared DB) ──────────────────────────────

describe('resolveTagId owner namespacing', () => {
  beforeEach(() => { resetDb(); createOwner(); });

  it('resolves the same name to a DIFFERENT tag per owner', () => {
    const idA = resolveTagId('errands', SYSTEM_OWNER);
    const idB = resolveTagId('errands', SECOND_OWNER_ID);
    expect(idA).not.toBe(idB);
    expect((sqlite.prepare(`SELECT owner_id FROM tags WHERE id = ?`).get(idA) as { owner_id: string }).owner_id).toBe(SYSTEM_OWNER);
    expect((sqlite.prepare(`SELECT owner_id FROM tags WHERE id = ?`).get(idB) as { owner_id: string }).owner_id).toBe(SECOND_OWNER_ID);
    // Re-resolving is stable (find, not re-create).
    expect(resolveTagId('errands', SECOND_OWNER_ID)).toBe(idB);
  });
});

// ── HTTP owner-isolation via x-test-owner ───────────────────────────────────────

describe('tags HTTP owner-isolation', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { resetDb(); createOwner(); });

  const asB = { headers: { 'x-test-owner': SECOND_OWNER_ID } };

  it('two owners can each create a tag named "errands"; neither sees the other in GET', async () => {
    const a = await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'errands' } });
    const b = await api(srv.url, '/api/tags', { ...asB, method: 'POST', json: { name: 'errands' } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.tag.id).not.toBe(b.body.tag.id); // UNIQUE(owner_id, name), not global

    const aList = await api(srv.url, '/api/tags');
    const bList = await api(srv.url, '/api/tags', asB);
    expect((aList.body.tags as { id: string }[]).some((t) => t.id === b.body.tag.id)).toBe(false);
    expect((bList.body.tags as { id: string }[]).some((t) => t.id === a.body.tag.id)).toBe(false);
  });

  it('a foreign tag id 404s on PATCH and DELETE', async () => {
    const a = await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'work-a' } });
    const aId = a.body.tag.id as string;
    expect((await api(srv.url, `/api/tags/${aId}`, { ...asB, method: 'PATCH', json: { muted: true } })).status).toBe(404);
    expect((await api(srv.url, `/api/tags/${aId}`, { ...asB, method: 'DELETE' })).status).toBe(404);
  });

  it("a block can't be stamped against another owner's category", async () => {
    const cat = await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'deepwork', kind: 'category' } });
    const catId = cat.body.tag.id as string;
    // Owner B tries to create a block against owner A's category → rejected.
    const r = await api(srv.url, '/api/blocks', {
      ...asB, method: 'POST',
      json: { title: 'x', start_at: at('10:00'), end_at: at('11:00'), category_id: catId },
    });
    expect(r.status).toBe(422);
  });
});

// ── Backup restore-isolation — the tag-axis + entity_tags completion of T1 ──────

describe('backup restore isolation (tag axis)', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { resetDb(); createOwner(); });

  it("importing owner A's export leaves owner B's tags AND entity_tags intact", async () => {
    // Owner B: a tag + a task + the entity_tag linking them.
    const bTag = resolveTagId('bkeep', SECOND_OWNER_ID);
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, version) VALUES ('b-task', 'B task', ?, 'open', 3, 1)`)
      .run(SECOND_OWNER_ID);
    sqlite
      .prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', 'b-task', ?, 1)`)
      .run(bTag);

    // Owner A (SYSTEM) creates a tag, exports, and restores that export.
    await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'a-tag' } });
    const exported = await api(srv.url, '/api/export');
    expect(exported.status).toBe(200);
    expect(exported.body.version).toBe('8');
    const imported = await api(srv.url, '/api/import', { method: 'POST', json: exported.body });
    expect(imported.status).toBe(200);

    // T2's owner-scoped tags wipe means the old global `DELETE FROM tags` no longer
    // cascade-wipes owner B's tag — and so B's entity_tags survive too.
    expect(sqlite.prepare(`SELECT name FROM tags WHERE id = ?`).get(bTag)).toMatchObject({ name: 'bkeep' });
    expect(sqlite.prepare(`SELECT 1 FROM entity_tags WHERE entity_id = 'b-task' AND tag_id = ?`).get(bTag)).toBeTruthy();
  });
});
