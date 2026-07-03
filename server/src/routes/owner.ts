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
