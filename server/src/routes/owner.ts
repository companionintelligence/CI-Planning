import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { httpError } from '../lib/http-error.js';

/**
 * `/api/owner/*` — the authenticated owner's own account settings.
 *
 * V: the backup reset-email. `owners.email` is the primary password-reset destination;
 * `backup_email` is the fallback used when the primary is absent. This is the only way a
 * locally-seeded owner (bootstrapped with just a username) gets a deliverable reset
 * address, so a reset link can reach them at all.
 */

// Pragmatic email shape check — a single `@` with non-empty, dot-bearing local/domain
// parts and no whitespace. Not RFC 5322 (that's a losing battle); just enough to reject
// obvious typos before we store an address we'd try to email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ownerRouter() {
  const router = new Router();

  // PATCH /api/owner/profile — { name?: string, email?: string | null }
  // The owner's display identity. Omitted fields are preserved; email accepts
  // null/'' to clear. This is the only writer of owners.name/email post-provision —
  // without it a self-hosted (test/standalone-mode) owner is stuck as the seeded
  // 'System' identity forever.
  router.patch('/api/owner/profile', (ctx) => {
    const { name, email } = (ctx.request.body ?? {}) as { name?: unknown; email?: unknown };

    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
        throw httpError(400, 'name must be a non-empty string (max 120 chars)');
      }
      sets.push('name = ?');
      values.push(name.trim());
    }
    if (email !== undefined) {
      if (email === null || email === '') {
        sets.push('email = NULL');
      } else if (typeof email === 'string' && EMAIL_RE.test(email.trim())) {
        sets.push('email = ?');
        values.push(email.trim());
      } else {
        throw httpError(400, 'email must be a valid address (or null to clear)');
      }
    }
    if (sets.length === 0) throw httpError(400, 'nothing to update — provide name and/or email');

    const ownerId = currentOwnerId();
    sqlite.prepare(`UPDATE owners SET ${sets.join(', ')} WHERE id = ?`).run(...values, ownerId);
    const row = sqlite
      .prepare(`SELECT name, email FROM owners WHERE id = ?`)
      .get(ownerId) as { name: string; email: string | null };
    ctx.body = { ok: true, name: row.name, email: row.email };
  });

  // PATCH /api/owner/backup-email  — { backup_email: string | null }
  // A null/empty value clears it. Scoped to the current owner (never the sentinel).
  router.patch('/api/owner/backup-email', (ctx) => {
    const { backup_email } = (ctx.request.body ?? {}) as { backup_email?: unknown };

    let value: string | null;
    if (backup_email === null || backup_email === '') {
      value = null;
    } else if (typeof backup_email === 'string' && EMAIL_RE.test(backup_email.trim())) {
      value = backup_email.trim();
    } else {
      throw httpError(400, 'a valid email address (or null to clear) is required');
    }

    sqlite.prepare(`UPDATE owners SET backup_email = ? WHERE id = ?`).run(value, currentOwnerId());
    ctx.body = { ok: true, backup_email: value };
  });

  return router;
}
