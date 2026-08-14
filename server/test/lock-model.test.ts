import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { FixtureConnector } from '../src/connectors/fixture.js';
import { syncConnector } from '../src/agents/sync.js';
import { updateBlock } from '../src/services/blocks.js';
import { newId } from '../src/lib/ids.js';
import { up as lockSyncedBlocks } from '../src/db/migrations/0148_lock_synced_blocks.js';
import { resetDb } from './helpers.js';

function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Focus × Time Blocks, Phase 1 — the lock model.
 *
 * L00: a synced calendar event is locked, always, and the app never moves it. The
 * ongoing ingest already stamps `is_locked = 1` (agents/sync.ts) — pinned here so a
 * refactor cannot quietly drop it — and migration 0148 backfills the rows that
 * predate the rule. Decision 1 adds the other half: it cannot be UNLOCKED, enforced
 * in the service so the guarantee is real rather than a UI convention.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

beforeEach(() => { resetDb(); });

/** A block row, returning its id. */
function insertBlock(over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    owner_id: OWNER, title: 'Block', block_kind: 'task',
    start_at: at('10:00'), end_at: at('11:00'),
    is_auto: 0, is_locked: 0, source_kind: 'manual', status: 'planned', ...over,
  };
  const keys = Object.keys(row);
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`)
    .get(...keys.map((k) => row[k])) as { id: string }).id;
}

/** Map a block as an inbound (or outbound) mirror of an external event. */
function mapExternal(blockId: string, direction: 'inbound' | 'outbound' = 'inbound'): void {
  sqlite
    .prepare(
      `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id, etag, direction, last_synced_at)
       VALUES (?, ?, 'google', 'work', ?, ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
    .run(newId(), OWNER, `ext-${blockId}`, blockId, direction);
}

const lockedOf = (id: string) =>
  (sqlite.prepare(`SELECT is_locked FROM time_blocks WHERE id = ?`).get(id) as { is_locked: number }).is_locked;

describe('ingest — a fresh calendar sync produces locked events', () => {
  it('a real sync cycle lands its inbound mirrors locked', async () => {
    const connector = new FixtureConnector('google', 'lock-test@example.com');
    connector.seed({ id: 'evt-1', title: 'Standup', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    connector.seed({ id: 'evt-2', title: 'Review', start: futureDate(2), end: futureDate(2, 1), etag: 'v1' });

    const res = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => syncConnector(connector));
    expect(res.created).toBe(2);

    const mirrored = sqlite
      .prepare(
        `SELECT tb.title, tb.is_locked FROM time_blocks tb
           JOIN external_events ee ON ee.block_id = tb.id AND ee.direction = 'inbound'`,
      )
      .all() as { title: string; is_locked: number }[];
    expect(mirrored).toHaveLength(2);
    // L00 — the source calendar owns their time; the app never moves them.
    expect(mirrored.every((m) => m.is_locked === 1)).toBe(true);
  });
});

describe('migration 0148 — backfill', () => {
  it('locks an inbound-mirrored block that predates the rule', () => {
    const id = insertBlock({ block_kind: 'meeting', source_kind: 'gcal', is_locked: 0 });
    mapExternal(id, 'inbound');
    expect(lockedOf(id)).toBe(0);
    lockSyncedBlocks(sqlite);
    expect(lockedOf(id)).toBe(1);
  });

  it('leaves the owner’s own blocks alone', () => {
    const mine = insertBlock({ is_locked: 0 });
    lockSyncedBlocks(sqlite);
    expect(lockedOf(mine)).toBe(0);
  });

  it('leaves OUTBOUND mirrors alone — those are the owner’s blocks pushed to a calendar', () => {
    const pushed = insertBlock({ is_locked: 0 });
    mapExternal(pushed, 'outbound');
    lockSyncedBlocks(sqlite);
    expect(lockedOf(pushed)).toBe(0);
  });

  it('is idempotent and never unlocks anything', () => {
    const id = insertBlock({ is_locked: 1 });
    mapExternal(id, 'inbound');
    lockSyncedBlocks(sqlite);
    lockSyncedBlocks(sqlite);
    expect(lockedOf(id)).toBe(1);
  });
});

describe('decision 1 — a synced event cannot be unlocked', () => {
  it('rejects an unlock of an inbound mirror', async () => {
    const id = insertBlock({ block_kind: 'meeting', is_locked: 1 });
    mapExternal(id, 'inbound');
    const res = await updateBlock(OWNER, id, { is_locked: false });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('inbound_readonly');
    expect(lockedOf(id)).toBe(1);
  });

  it('still allows re-locking one (a no-op, not an error)', async () => {
    const id = insertBlock({ block_kind: 'meeting', is_locked: 1 });
    mapExternal(id, 'inbound');
    const res = await updateBlock(OWNER, id, { is_locked: true });
    expect(res.ok).toBe(true);
    expect(lockedOf(id)).toBe(1);
  });

  it('the owner’s own block unlocks normally', async () => {
    const id = insertBlock({ is_locked: 1 });
    const res = await updateBlock(OWNER, id, { is_locked: false });
    expect(res.ok).toBe(true);
    expect(lockedOf(id)).toBe(0);
  });

  it('an OUTBOUND-mapped block is still the owner’s to unlock', async () => {
    const id = insertBlock({ is_locked: 1 });
    mapExternal(id, 'outbound');
    const res = await updateBlock(OWNER, id, { is_locked: false });
    expect(res.ok).toBe(true);
    expect(lockedOf(id)).toBe(0);
  });
});
