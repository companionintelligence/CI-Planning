import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { getConnectors, googleAccounts } from '../src/connectors/index.js';
import { config } from '../src/lib/config.js';
import { resetDb } from './helpers.js';

/**
 * GOOGLE_MODE=off must silence STORED connections, not just block new ones.
 * getConnectors()/googleAccounts() are the single choke point every sync path
 * (syncAll, enqueueOutbound, pushOutboundDeletes, ingest) sources connectors from —
 * without this gate, disabling Google in Settings left the 15-minute sync_calendar
 * cron pulling/pushing real calendar data with the stored OAuth tokens.
 */
const savedMode = config.google.mode;

function seedActiveToken(account: string): void {
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
       VALUES (uuid7(), ?, 'google', ?, 'aXY=', 'dGFn', 'Y2lwaGVy', 1)`,
    )
    .run(SYSTEM_OWNER, account);
}

beforeEach(() => {
  resetDb();
  seedActiveToken('gated@example.com');
});
afterEach(() => {
  config.google.mode = savedMode;
});

describe('connectors mode gate', () => {
  it('mode off → no connectors and no accounts, despite an active stored token', () => {
    config.google.mode = 'off';
    runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => {
      expect(getConnectors()).toEqual([]);
      expect(googleAccounts()).toEqual([]);
    });
  });

  it('any non-off mode surfaces the stored connection (fixture/live behave as before)', () => {
    config.google.mode = 'fixture';
    runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => {
      expect(getConnectors()).toHaveLength(1);
      expect(googleAccounts()).toEqual(['gated@example.com']);
    });
  });
});
