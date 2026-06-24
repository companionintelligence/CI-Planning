import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0059 from '../src/db/migrations/0059_adopt_gcal_mirror.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

const fresh = () => new BetterSqlite3(':memory:');
const cols = (db: Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tableExists = (db: Database, table: string) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
const count = (db: Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

// Insert a legacy gcal meeting block (mirrored by the OLD path: no external_events row).
function seedLegacyGcalBlock(db: Database, blockId: string, sourceRef: string) {
  db.prepare(
    `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, source_kind, source_ref, status)
     VALUES (?, 'Legacy Meeting', 'meeting', '2026-07-01T09:00:00Z', '2026-07-01T10:00:00Z', 'gcal', ?, 'planned')`,
  ).run(blockId, sourceRef);
}

describe('Wave 0 migrations', () => {
  it('0058: connection_tokens.status defaults to active; oauth_states + sync_state exist', () => {
    const db = fresh();
    runMigrations(db);

    expect(cols(db, 'connection_tokens')).toContain('status');
    expect(tableExists(db, 'oauth_states')).toBe(true);
    expect(tableExists(db, 'sync_state')).toBe(true);

    // status defaults to 'active' on insert without it.
    db.prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext)
       VALUES ('00000000-0000-7000-8000-0000000000c1', ?, 'google', 'a@x.io', 'iv', 'tag', 'ct')`,
    ).run(SYSTEM_OWNER_ID);
    const row = db.prepare(`SELECT status FROM connection_tokens WHERE account = 'a@x.io'`).get() as { status: string };
    expect(row.status).toBe('active');

    // oauth_states.state is UNIQUE + indexed; provider defaults to 'google'.
    const idx = (db.prepare(`PRAGMA index_list(oauth_states)`).all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('ix_oauth_states_state');
    db.prepare(
      `INSERT INTO oauth_states (id, owner_id, state, code_verifier) VALUES ('s1', ?, 'STATE-1', 'VERIFIER')`,
    ).run(SYSTEM_OWNER_ID);
    const os = db.prepare(`SELECT provider FROM oauth_states WHERE state = 'STATE-1'`).get() as { provider: string };
    expect(os.provider).toBe('google');

    // sync_state UNIQUE(owner_id, provider, account, resource) — a duplicate insert fails.
    db.prepare(
      `INSERT INTO sync_state (id, owner_id, provider, account, resource) VALUES ('ss1', ?, 'google', 'a@x.io', 'calendar_synctoken')`,
    ).run(SYSTEM_OWNER_ID);
    expect(() =>
      db.prepare(
        `INSERT INTO sync_state (id, owner_id, provider, account, resource) VALUES ('ss2', ?, 'google', 'a@x.io', 'calendar_synctoken')`,
      ).run(SYSTEM_OWNER_ID),
    ).toThrow();
    db.close();
  });

  it('0059: adopts a legacy gcal meeting block as one inbound mapping; re-run is a no-op', () => {
    const db = fresh();
    runMigrations(db);

    // A legacy block with no external_events row.
    seedLegacyGcalBlock(db, '00000000-0000-7000-8000-0000000000d1', 'gcal-evt-legacy');
    expect(count(db, 'external_events')).toBe(0);

    // Re-running the 0059 body adopts it (the runner already applied it on this fresh DB,
    // but there was no legacy block then, so it inserted nothing — exercise it now).
    m0059.up(db);

    const mappings = db
      .prepare(`SELECT owner_id, provider, account, external_id, block_id, direction, etag FROM external_events`)
      .all() as Array<{ owner_id: string; provider: string; account: string; external_id: string; block_id: string; direction: string; etag: string | null }>;
    expect(mappings).toHaveLength(1);
    const m = mappings[0]!;
    expect(m.owner_id).toBe(SYSTEM_OWNER_ID);
    expect(m.provider).toBe('google');
    expect(m.account).toBe('legacy');
    expect(m.external_id).toBe('gcal-evt-legacy');
    expect(m.block_id).toBe('00000000-0000-7000-8000-0000000000d1');
    expect(m.direction).toBe('inbound');
    expect(m.etag).toBeNull();

    // The block itself is untouched (ADOPT never deletes).
    expect(count(db, 'time_blocks')).toBe(1);

    // Idempotent: re-running inserts nothing.
    m0059.up(db);
    expect(count(db, 'external_events')).toBe(1);
    db.close();
  });

  it('0059: ignores non-gcal / non-meeting / already-mapped blocks', () => {
    const db = fresh();
    runMigrations(db);

    // A manual meeting (wrong source_kind) — not adopted.
    db.prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, source_kind, source_ref, status)
       VALUES ('00000000-0000-7000-8000-0000000000e1', 'Manual', 'meeting', '2026-07-01T09:00:00Z', '2026-07-01T10:00:00Z', 'manual', 'ref-x', 'planned')`,
    ).run();
    // A gcal task block (wrong block_kind) — not adopted.
    db.prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, source_kind, source_ref, status)
       VALUES ('00000000-0000-7000-8000-0000000000e2', 'Gcal Task', 'task', '2026-07-01T09:00:00Z', '2026-07-01T10:00:00Z', 'gcal', 'ref-y', 'planned')`,
    ).run();
    // A gcal meeting that ALREADY has a mapping — not duplicated.
    seedLegacyGcalBlock(db, '00000000-0000-7000-8000-0000000000e3', 'gcal-evt-mapped');
    db.prepare(
      `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id, direction)
       VALUES ('00000000-0000-7000-8000-0000000000f1', ?, 'google', 'real@x.io', 'gcal-evt-mapped', '00000000-0000-7000-8000-0000000000e3', 'inbound')`,
    ).run(SYSTEM_OWNER_ID);

    m0059.up(db);
    // Still exactly the one pre-existing mapping; nothing new adopted.
    expect(count(db, 'external_events')).toBe(1);
    db.close();
  });
});
