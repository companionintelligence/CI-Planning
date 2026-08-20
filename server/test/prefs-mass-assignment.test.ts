import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { startTestServer, api, resetDb, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * PATCH /api/prefs must write only real preference columns.
 *
 * `updatePrefs` validated two specific fields and then passed the WHOLE remaining body
 * through `fromApi()` — a blind snake_case→camelCase key rename with no allowlist —
 * straight into a Drizzle `.set()`. Every column on `scheduling_prefs` was therefore
 * client-writable, including its own `owner_id` and `id`.
 *
 * That is a tenant-isolation hole, not just sloppiness. `scheduling_prefs.owner_id` has no
 * UNIQUE constraint, so reassigning it silently succeeds and leaves the victim with TWO
 * prefs rows; the many `SELECT … FROM scheduling_prefs WHERE owner_id = ?` single-row
 * `.get()` reads (owner timezone, block services, autoplan) then return whichever SQLite
 * yields first — applying attacker-chosen timezone, workday window and trust dial to
 * someone else. The sentinel owner id is a hardcoded public constant and is the template
 * `provisionOwner()` clones for every new owner, which makes it a standing target.
 *
 * Every sibling write path in this codebase validates cross-entity ids against the owner
 * (blocks' category_id, tasks' parent, pattern-blocks). This one did not validate its own
 * owner column.
 */

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterEach(() => resetDb());

/** The caller's own prefs row, straight from SQLite. */
function prefsRowsFor(ownerId: string) {
  return sqlite
    .prepare('SELECT id, owner_id, timezone FROM scheduling_prefs WHERE owner_id = ?')
    .all(ownerId) as { id: string; owner_id: string; timezone: string }[];
}

describe('PATCH /api/prefs — mass assignment', () => {
  it('ignores owner_id in the body and leaves the row on the caller', async () => {
    createOwner(SECOND_OWNER_ID, 'Owner B', 'UTC');
    const before = prefsRowsFor(SYSTEM_OWNER);
    expect(before).toHaveLength(1);

    const { status } = await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { owner_id: SECOND_OWNER_ID, timezone: 'Pacific/Kiritimati' },
    });
    expect(status).toBe(200);

    // The legitimate field applied…
    const mine = prefsRowsFor(SYSTEM_OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0].timezone).toBe('Pacific/Kiritimati');
    // …and the row did NOT move to the other owner.
    expect(mine[0].owner_id).toBe(SYSTEM_OWNER);
  });

  it('does not plant a second prefs row on the victim', async () => {
    createOwner(SECOND_OWNER_ID, 'Owner B', 'UTC');
    const victimBefore = prefsRowsFor(SECOND_OWNER_ID);

    await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { owner_id: SECOND_OWNER_ID, capacity_hours_per_week: 40 },
    });

    // scheduling_prefs.owner_id carries no UNIQUE constraint, so a successful hijack
    // would leave the victim with two rows and make their single-row reads ambiguous.
    expect(prefsRowsFor(SECOND_OWNER_ID)).toHaveLength(victimBefore.length);
  });

  it('ignores the primary key, so a row cannot be re-pointed by id either', async () => {
    const before = prefsRowsFor(SYSTEM_OWNER)[0];

    await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { id: 'forged-prefs-id', timezone: 'UTC' },
    });

    const after = prefsRowsFor(SYSTEM_OWNER);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
  });

  it('still applies ordinary preference fields', async () => {
    // The allowlist must not become a silent no-op for legitimate writes.
    const { status } = await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { timezone: 'America/New_York', capacity_hours_per_week: 40, max_focus_block_minutes: 75 },
    });
    expect(status).toBe(200);

    const row = sqlite
      .prepare('SELECT timezone, capacity_hours_per_week, max_focus_block_minutes FROM scheduling_prefs WHERE owner_id = ?')
      .get(SYSTEM_OWNER) as { timezone: string; capacity_hours_per_week: number; max_focus_block_minutes: number };
    expect(row).toEqual({
      timezone: 'America/New_York',
      capacity_hours_per_week: 40,
      max_focus_block_minutes: 75,
    });
  });
});
