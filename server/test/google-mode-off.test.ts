import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config } from '../src/lib/config.js';
import { createGoogleClient } from '../src/mcp/google.js';
import { gmailLiveAllowed } from '../src/mcp/gmail-flag.js';
import { runJob } from '../src/jobs/index.js';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { resetDb } from './helpers.js';

/**
 * GOOGLE_MODE 'off' (the unset default) — fixture data must never reach a user who
 * didn't explicitly opt in, and live mode must skip owners with no connected account.
 * The test env pins GOOGLE_MODE=fixture (vitest.config env), so these tests flip the
 * config singleton's mode directly and restore it after each test.
 */
const SAVED_MODE = config.google.mode;

afterEach(() => {
  config.google.mode = SAVED_MODE;
});

describe("GOOGLE_MODE 'off' (unset default)", () => {
  it('createGoogleClient throws McpUnavailable — never silently returns fixtures', () => {
    config.google.mode = 'off';
    expect(() => createGoogleClient()).toThrowError(/off/);
    try {
      createGoogleClient();
    } catch (err) {
      expect((err as Error).name).toBe('McpUnavailable');
    }
  });

  it('gmailLiveAllowed is false', () => {
    config.google.mode = 'off';
    expect(gmailLiveAllowed()).toBe(false);
  });

  describe('ingest jobs', () => {
    beforeEach(() => {
      resetDb();
    });

    async function lastRunLog(kind: string): Promise<string> {
      const row = sqlite
        .prepare(
          `SELECT r.log AS log FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
            WHERE j.kind = ? ORDER BY r.started_at DESC LIMIT 1`,
        )
        .get(kind) as { log: string } | undefined;
      return row?.log ?? '';
    }

    it('off: both ingest jobs skip and create zero possibles', async () => {
      config.google.mode = 'off';
      await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, async () => {
        await runJob('ingest_gmail');
        await runJob('ingest_gcal');
      });
      const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM possible_tasks`).get() as { n: number }).n;
      expect(n).toBe(0);
      expect(await lastRunLog('ingest_gmail')).toMatch(/Google integration off/);
      expect(await lastRunLog('ingest_gcal')).toMatch(/Google integration off/);
    });

    it('live: an owner with no connected Google account is skipped (no fixture leak)', async () => {
      config.google.mode = 'live';
      await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, async () => {
        await runJob('ingest_gcal');
      });
      const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM possible_tasks`).get() as { n: number }).n;
      expect(n).toBe(0);
      expect(await lastRunLog('ingest_gcal')).toMatch(/No Google account connected/);
    });

    it('fixture (explicit opt-in): the canned client is still handed out', () => {
      config.google.mode = 'fixture';
      expect(createGoogleClient().mode).toBe('fixture');
      expect(gmailLiveAllowed()).toBe(true);
    });
  });
});
