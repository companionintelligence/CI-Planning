import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { provisionOwner, deleteOwner } from '../src/lib/owners.js';

/**
 * F-CASCADE: deleteOwner() is the app-level owner-deletion primitive. It must purge
 * ALL of an owner's data (portable + non-portable/sync/secret tables) in one
 * transaction and leave every OTHER owner untouched. The system owner is never deletable.
 */

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
beforeEach(() => resetDb());

// Owner-scoped tables (direct owner_id) swept to prove a deleted owner leaves no residue.
// Mix of provisionOwner-seeded, portable, and non-portable/sync tables.
const OWNER_SCOPED_TABLES = [
  'tasks', 'time_blocks', 'tags', 'pattern_blocks', 'pattern_types', 'day_types',
  'day_of_week_map', 'scheduling_prefs', 'tag_prefs', 'sync_events', 'external_events',
  'outbound_queue', 'copy_history', 'audit_log',
] as const;

function countFor(table: string, ownerId: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`).get(ownerId) as { n: number }).n;
}

/** Populate an owner with rows spanning portable, sync, and audit tables (on top of the provisioned seed). */
function populate(ownerId: string): void {
  const blockId = (sqlite.prepare('SELECT uuid7() AS id').get() as { id: string }).id;
  sqlite.prepare(`INSERT INTO tasks (id, title, owner_id) VALUES (uuid7(), 'a-task', ?)`).run(ownerId);
  sqlite.prepare(
    `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at)
     VALUES (?, ?, 'blk', 'timeblock', '2026-06-22T10:00:00.000Z', '2026-06-22T11:00:00.000Z')`
  ).run(blockId, ownerId);
  sqlite.prepare(
    `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id)
     VALUES (uuid7(), ?, 'google', 'acct@ci.test', ?, ?)`
  ).run(ownerId, `ext-${ownerId}`, blockId);
  sqlite.prepare(
    `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
     VALUES (uuid7(), ?, ?, 'google', 'acct@ci.test')`
  ).run(ownerId, blockId);
  sqlite.prepare(
    `INSERT INTO sync_events (owner_id, event, payload, at) VALUES (?, 'task:updated', '{}', '2026-06-22T10:00:00.000Z')`
  ).run(ownerId);
  sqlite.prepare(`INSERT INTO copy_history (id, owner_id, surface, signature) VALUES (uuid7(), ?, 'brief', 'sig')`).run(ownerId);
  sqlite.prepare(`INSERT INTO audit_log (id, owner_id, actor, action, entity) VALUES (uuid7(), ?, 'owner', 'create', 'task:x')`).run(ownerId);
}

describe('deleteOwner (F-CASCADE)', () => {
  it('purges every owner-scoped table for the target and leaves other owners intact', () => {
    const a = provisionOwner({ name: 'Owner A', username: 'owner-a', passwordHash: 'x' });
    const b = provisionOwner({ name: 'Owner B', username: 'owner-b', passwordHash: 'y' });
    populate(a);
    populate(b);

    // Sanity: A has rows across the sweep before deletion.
    for (const t of OWNER_SCOPED_TABLES) expect(countFor(t, a), `${t} seeded for A`).toBeGreaterThan(0);

    deleteOwner(a);

    // A is gone everywhere; the owners row too.
    for (const t of OWNER_SCOPED_TABLES) expect(countFor(t, a), `${t} residue for A`).toBe(0);
    expect(sqlite.prepare('SELECT id FROM owners WHERE id = ?').get(a)).toBeUndefined();

    // B is fully intact (isolation).
    expect(sqlite.prepare('SELECT id FROM owners WHERE id = ?').get(b)).toBeTruthy();
    for (const t of OWNER_SCOPED_TABLES) expect(countFor(t, b), `${t} lost for B`).toBeGreaterThan(0);
  });

  it('refuses to delete the system owner', () => {
    expect(() => deleteOwner(SYSTEM_OWNER_ID)).toThrow(/system owner/i);
    expect(sqlite.prepare('SELECT id FROM owners WHERE id = ?').get(SYSTEM_OWNER_ID)).toBeTruthy();
  });
});
