import type { Database } from 'better-sqlite3';
import { SYSTEM_OWNER_ID } from '../../lib/ids.js';

export const id = '0122_scrub_seed_owner';

/**
 * Scrub the hardcoded personal identity from the seeded system owner.
 *
 * 0003 used to seed owner id=1 as 'Liam' / 'REDACTED-DEV-EMAIL@example.invalid' (a developer's real
 * name + personal email); 0030 remapped that row to the SYSTEM_OWNER_ID sentinel but
 * copied name/email verbatim. In single-owner mode the sentinel IS the identity the UI
 * shows, so every pre-existing install carries that personal data. 0003 now seeds
 * ('System', NULL) for fresh DBs; this migration fixes DBs seeded before the change.
 *
 * Guarded on BOTH old literals so an owner who personalized the row (renamed it or
 * changed the email) is never touched. Idempotent: after one pass the WHERE no longer
 * matches. Also matches the pre-0030 integer id 1 for DBs replaying mid-history —
 * harmless when absent.
 */
export function up(db: Database): void {
  db.prepare(
    `UPDATE owners SET name = 'System', email = NULL
      WHERE id IN (?, '1')
        AND name = 'Liam'
        AND email = 'REDACTED-DEV-EMAIL@example.invalid'`,
  ).run(SYSTEM_OWNER_ID);
}
