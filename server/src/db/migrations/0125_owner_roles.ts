import type { Database } from 'better-sqlite3';
import { SYSTEM_OWNER_ID } from '../../lib/ids.js';

export const id = '0125_owner_roles';

/**
 * Phase AG — multi-tenant RBAC (docs/AG-multitenant-rbac.md). Give `owners` a `role`
 * column so verifySession can derive scopes per owner instead of granting every
 * SSO/local session `[read, write, admin]` unconditionally.
 *
 * Three roles, mapped 1:1 onto the existing planning:read/write/admin scopes by
 * roleToScopes (lib/auth/scopes.ts): `operator` (R+W+A), `member` (R+W), `viewer` (R).
 *
 * The column DEFAULT is 'member' — the safe default for every FUTURE owner (OIDC
 * auto-provision must not mint admins) — but every owner that exists at migration
 * time is backfilled to 'operator': under the original one-operator-per-box model
 * the logged-in owner IS the operator, so a current install must keep admin and
 * never lock itself out. The SYSTEM_OWNER sentinel is auth-inert (no session can
 * ever resolve to it), so it is excluded from the backfill and keeps 'member'.
 *
 * Additive + idempotent: guarded on the column already existing, so the historical
 * replay in migrate.test.ts and a re-run are both no-ops.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(owners)`).all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('role')) return; // already migrated — re-run safety.

  db.exec(`ALTER TABLE owners ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`);
  db.prepare(`UPDATE owners SET role = 'operator' WHERE id <> ?`).run(SYSTEM_OWNER_ID);
}
