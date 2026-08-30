import { store } from '../db/store.js';
import { logger } from './logger.js';

/**
 * Append one row to audit_log. Fire-and-forget — never throws, so a failed audit write
 * cannot abort the mutation it is recording, and never awaited, so it cannot slow one
 * down either.
 *
 * WHY IT STAYS FIRE-AND-FORGET. The store facade is async, so the obvious move is to
 * make this `async` and await it at all 125 call sites. That was tried and rejected: it
 * turns 125 edits into ~59 service functions becoming async, which cascades to ~300
 * caller sites — async-ifying essentially the whole service and resolver layer in one
 * unreviewable commit. Nothing on a request path justifies that, because `audit_log` is
 * WRITE-ONLY in production: the only readers are the backup export, owner deletion, and
 * the test suite.
 *
 * So the promise is deliberately floated, and the ordering the synchronous SQLite write
 * used to give for free is provided explicitly by {@link flushAudits} for the 29
 * assertions that read the table right after the mutation that wrote it. Under Postgres
 * those would otherwise be a race that only shows up after the cutover.
 */

/** In-flight audit writes, so {@link flushAudits} can wait for them. */
const inFlight = new Set<Promise<void>>();

export function writeAudit(e: { ownerId: string; actor: string; action: string; entity: string }): void {
  const p: Promise<void> = store()
    .prepare(
      `INSERT INTO audit_log (id, owner_id, actor, action, entity) VALUES (uuid7(), ?, ?, ?, ?)`,
    )
    .run(e.ownerId, e.actor, e.action, e.entity)
    .then(
      () => {},
      // NEVER re-thrown or awaited by the caller — that contract doesn't change. But a
      // failed write used to vanish with zero trace anywhere: no log, no metric, nothing.
      // For a security-relevant record, "we don't know it's missing" is worse than the
      // loss itself. `action`/`entity` only (never a full payload) — this is a log line
      // about the audit system, not a second copy of what it was trying to record.
      (err: unknown) => {
        logger.error('audit write failed — this event is not recorded', {
          ownerId: e.ownerId, action: e.action, err: (err as Error).message,
        });
      },
    )
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/**
 * Wait for every audit write issued so far.
 *
 * For tests (and anything else) that read `audit_log` immediately after the mutation
 * that wrote it: with a synchronous SQLite handle the row was always already there;
 * under Postgres it is a network round trip that may not have landed. Call this first
 * and the read is deterministic on both backends.
 *
 * Loops rather than draining once, because awaiting the current set can itself let a
 * queued write start — a single drain would leave anything issued during the await
 * still outstanding.
 */
export async function flushAudits(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}
