import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runJob } from '../src/jobs/index.js';
import { runWithOwner, SYSTEM_OWNER, ALL_SCOPES } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';

/**
 * audit_log deliberately has NO retention (routes/backup.ts excludes it from
 * export/restore precisely because it is meant to be a permanent, host-local record).
 * That is intentional, not an oversight — but a permanently-unpruned table with no
 * visibility ANYWHERE is its own risk. `prune_sync_events`'s existing daily pass is
 * where that visibility now lives: no new job/cron, the count just rides along in the
 * log line the Jobs view already shows for sync_events' own pruning.
 */

function insertAuditRow(): void {
  sqlite
    .prepare(`INSERT INTO audit_log (id, owner_id, actor, action, entity) VALUES (?, ?, 'owner', 'test', 'x:1')`)
    .run(newId(), SYSTEM_OWNER);
}

beforeEach(() => resetDb());

describe('prune_sync_events — audit_log visibility', () => {
  it('reports the current audit_log row count in its log line, and does not delete any', async () => {
    for (let i = 0; i < 5; i++) insertAuditRow();
    const before = (sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n;
    expect(before).toBeGreaterThanOrEqual(5);

    const r = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => runJob('prune_sync_events'));

    expect(r.log).toMatch(new RegExp(`audit_log now has ${before} row\\(s\\)`));
    expect(r.log).toMatch(/unpruned by design/);
    // +1, not untouched: runJob itself writes ONE audit row for the run's own
    // completion (every job kind does) — that lands AFTER this job's own log line was
    // built, which is why the count above matches `before` exactly rather than +1.
    // What this proves is the negative: prune_sync_events deletes nothing from
    // audit_log itself, on top of that one expected completion row.
    const after = (sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n;
    expect(after).toBe(before + 1);
  });
});
