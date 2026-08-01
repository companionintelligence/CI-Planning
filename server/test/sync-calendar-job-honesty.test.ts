import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SyncResult } from '../src/agents/sync.js';

/**
 * RC7-4 — `sync_calendar` used to reduce only the created/updated/deleted/conflicts
 * counters and ignore `errors` entirely, so a run in which EVERY connector failed
 * returned status 'done' with all-zero counts: identical, in the Jobs UI, to "nothing
 * to sync". A dead calendar integration could therefore look healthy indefinitely.
 *
 * syncAll is mocked because the point under test is the job's interpretation of the
 * results, not the sync itself.
 */

const syncAll = vi.hoisted(() => vi.fn());
vi.mock('../src/agents/sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agents/sync.js')>();
  return { ...actual, syncAll };
});

const { runJob } = await import('../src/jobs/index.js');
const { config } = await import('../src/lib/config.js');
const { resetDb } = await import('./helpers.js');
const { runWithOwner, SYSTEM_OWNER, ALL_SCOPES } = await import('../src/lib/context.js');

function result(over: Partial<SyncResult> = {}): SyncResult {
  return {
    provider: 'google',
    account: 'a@x.io',
    created: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
    errors: [],
    ...over,
  };
}

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);

describe('RC7-4 sync_calendar reports failure honestly', () => {
  let savedMode: string;

  beforeEach(() => {
    resetDb();
    savedMode = config.google.mode;
    (config.google as { mode: string }).mode = 'fixture'; // anything but 'off'
    syncAll.mockReset();
  });
  afterEach(() => {
    (config.google as { mode: string }).mode = savedMode;
    vi.restoreAllMocks();
  });

  it("does NOT report done when every connector failed", async () => {
    syncAll.mockResolvedValue([
      result({ account: 'a@x.io', errors: ['McpUnavailable: connect failed'] }),
      result({ account: 'b@x.io', errors: ['McpUnavailable: unauthorized'] }),
    ]);

    const r = await run(() => runJob('sync_calendar'));

    expect(r.status).toBe('error');
    expect(r.log).toMatch(/all 2 calendar connector\(s\) failed/);
  });

  it('reports done but names the failures on a PARTIAL failure', async () => {
    syncAll.mockResolvedValue([
      result({ account: 'a@x.io', created: 3 }),
      result({ account: 'b@x.io', errors: ['McpUnavailable: connect failed'] }),
    ]);

    const r = await run(() => runJob('sync_calendar'));

    // Some work genuinely landed, so the run is not a failure — but the error must
    // still be visible rather than swallowed.
    expect(r.status).toBe('done');
    expect(r.log).toMatch(/1 error\(s\) on 1 connector\(s\)/);
  });

  it('a clean run with nothing to do still reports done, with no error text', async () => {
    syncAll.mockResolvedValue([result({ account: 'a@x.io' })]);

    const r = await run(() => runJob('sync_calendar'));

    expect(r.status).toBe('done');
    expect(r.log).not.toMatch(/error/);
  });

  it('no connectors at all is done, not an error', async () => {
    syncAll.mockResolvedValue([]);

    const r = await run(() => runJob('sync_calendar'));

    expect(r.status).toBe('done');
  });
});
