import { sqlite } from '../db/index.js';

/**
 * Append one row to audit_log. Fire-and-forget — never throws so a failed write
 * never aborts the main mutation.
 */
export function writeAudit(e: { ownerId: string; actor: string; action: string; entity: string }): void {
  try {
    sqlite.prepare(
      `INSERT INTO audit_log (id, owner_id, actor, action, entity) VALUES (uuid7(), ?, ?, ?, ?)`
    ).run(e.ownerId, e.actor, e.action, e.entity);
  } catch { /* silent — audit must never break the main path */ }
}
