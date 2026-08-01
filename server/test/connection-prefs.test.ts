import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { SYSTEM_OWNER, ALL_SCOPES, runWithOwner } from '../src/lib/context.js';
import {
  getConnectionPrefs,
  setConnectionPref,
  setConnectionPrefChecked,
  connectionKey,
} from '../src/services/connection-prefs.js';
import { createBlock, listBlocks } from '../src/services/blocks.js';
import { resetDb } from './helpers.js';

/**
 * 0145 — per-connection colour + texture, and the block→connection attribution the
 * calendar needs to apply them.
 */

const ACCOUNT = 'liam@example.com';

function seedConnection(account = ACCOUNT, provider = 'google') {
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
       VALUES (?, ?, ?, ?, 'iv', 'tag', 'ct', 1)`,
    )
    .run(newId(), SYSTEM_OWNER, provider, account);
}

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);

beforeEach(() => resetDb());

describe('connection prefs', () => {
  it('is empty until something is set — the default look is untouched', () => {
    seedConnection();
    expect(getConnectionPrefs(SYSTEM_OWNER)).toEqual({});
  });

  it('round-trips a colour and texture keyed by provider:account', () => {
    seedConnection();
    setConnectionPref(SYSTEM_OWNER, 'google', ACCOUNT, { color_token: 'chart-4', texture: 'grid' });
    expect(getConnectionPrefs(SYSTEM_OWNER)[connectionKey('google', ACCOUNT)]).toEqual({
      color_token: 'chart-4',
      texture: 'grid',
    });
  });

  it('merges a partial patch instead of resetting the other field', () => {
    seedConnection();
    setConnectionPref(SYSTEM_OWNER, 'google', ACCOUNT, { color_token: 'chart-4', texture: 'grid' });
    setConnectionPref(SYSTEM_OWNER, 'google', ACCOUNT, { texture: 'vertical' });
    expect(getConnectionPrefs(SYSTEM_OWNER)[connectionKey('google', ACCOUNT)]).toEqual({
      color_token: 'chart-4', // preserved
      texture: 'vertical',
    });
  });

  it('refuses a pref for a connection this owner does not hold', () => {
    // Without this the table would be an unbounded owner-writable key/value store, and
    // one owner could author prefs keyed to another's account.
    const res = setConnectionPrefChecked(SYSTEM_OWNER, 'google', 'stranger@example.com', { color_token: 'primary' });
    expect(res).toEqual({ ok: false, error: 'connection_not_found' });
  });

  it('rejects an unknown texture name', () => {
    seedConnection();
    expect(setConnectionPrefChecked(SYSTEM_OWNER, 'google', ACCOUNT, { texture: 'sparkles' })).toEqual({
      ok: false,
      error: 'texture_invalid',
    });
  });

  it('rejects an empty colour token', () => {
    seedConnection();
    expect(setConnectionPrefChecked(SYSTEM_OWNER, 'google', ACCOUNT, { color_token: '' })).toEqual({
      ok: false,
      error: 'color_token_invalid',
    });
  });

  it('SURVIVES a disconnect — reconnecting the same account restores its look', () => {
    // The whole reason the row is keyed (provider, account) rather than FK'd to
    // connection_tokens.id: disconnect hard-deletes the token row, and an FK/CASCADE
    // would silently discard the owner's colour every time they re-authorized.
    seedConnection();
    setConnectionPref(SYSTEM_OWNER, 'google', ACCOUNT, { color_token: 'chart-2', texture: 'diagonal' });
    sqlite.prepare(`DELETE FROM connection_tokens WHERE owner_id = ? AND account = ?`).run(SYSTEM_OWNER, ACCOUNT);

    expect(getConnectionPrefs(SYSTEM_OWNER)[connectionKey('google', ACCOUNT)]).toEqual({
      color_token: 'chart-2',
      texture: 'diagonal',
    });
  });
});

describe('block → connection attribution', () => {
  it('reports the source provider/account for a mirrored block, null for a local one', async () => {
    seedConnection();

    const { block: synced } = (await run(() =>
      createBlock(SYSTEM_OWNER, {
        title: 'CI Standup',
        block_kind: 'meeting',
        start_at: '2026-07-31T16:00:00.000Z',
        end_at: '2026-07-31T16:30:00.000Z',
      }),
    )) as { block: { id: string } };

    const { block: local } = (await run(() =>
      createBlock(SYSTEM_OWNER, {
        title: 'Local work',
        block_kind: 'task',
        start_at: '2026-07-31T18:00:00.000Z',
        end_at: '2026-07-31T19:00:00.000Z',
      }),
    )) as { block: { id: string } };

    sqlite
      .prepare(
        `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id, direction, last_synced_at)
         VALUES (?, ?, 'google', ?, 'evt-1', ?, 'inbound', '2026-07-31T16:00:00.000Z')`,
      )
      .run(newId(), SYSTEM_OWNER, ACCOUNT, synced.id);

    const rows = await run(() =>
      listBlocks(SYSTEM_OWNER, { from: '2026-07-31T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
    );

    const syncedRow = rows.find((r) => r.id === synced.id)!;
    const localRow = rows.find((r) => r.id === local.id)!;

    expect(syncedRow.source_provider).toBe('google');
    expect(syncedRow.source_account).toBe(ACCOUNT);
    // A locally created block must never be attributed to a connection — the free-time
    // view and the per-source colouring both key off this.
    expect(localRow.source_provider).toBeNull();
    expect(localRow.source_account).toBeNull();
  });
});
