import Router from '@koa/router';
import { store } from '../db/store.js';
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

  // PATCH /api/owner/profile — { name?: string, email?: string | null, username?: string }
  // The owner's display identity. Omitted fields are preserved; email accepts
  // null/'' to clear. This is the only writer of owners.name/email/username
  // post-provision — without it a self-hosted (test/standalone-mode) owner is stuck as
  // the seeded 'System' identity forever.
  router.patch('/api/owner/profile', async (ctx) => {
    const { name, email, username } = (ctx.request.body ?? {}) as {
      name?: unknown;
      email?: unknown;
      username?: unknown;
    };

    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
        throw httpError(400, 'name must be a non-empty string (max 120 chars)');
      }
      sets.push('name = ?');
      values.push(name.trim());
    }
    if (username !== undefined) {
      if (typeof username !== 'string' || !username.trim()) {
        throw httpError(400, 'username must be a non-empty string');
      }
      const next = username.trim();
      if (next.length > 64) throw httpError(400, 'username must be at most 64 characters');
      // No whitespace: the login form submits it verbatim and a leading/trailing or
      // embedded space is an unloggable-in account waiting to happen.
      if (/\s/.test(next)) throw httpError(400, 'username cannot contain spaces');
      // Deliberately NOT case-folded. `ux_owners_username` and findOwnerByUsername
      // (lib/auth/password.ts) are both binary-collated, so silently lowercasing here
      // would store a handle the owner then cannot log in with.
      sets.push('username = ?');
      values.push(next);
    }
    if (email !== undefined) {
      if (email === null || email === '') {
        sets.push('email = NULL');
      } else if (typeof email === 'string' && EMAIL_RE.test(email.trim())) {
        sets.push('email = ?');
        values.push(email.trim());
      } else {
        throw httpError(400, 'email must be a valid address (or null / empty string to clear)');
      }
    }
    if (sets.length === 0) throw httpError(400, 'nothing to update — provide name, email and/or username');

    const ownerId = currentOwnerId();
    try {
      await store().prepare(`UPDATE owners SET ${sets.join(', ')} WHERE id = ?`).run(...values, ownerId);
    } catch (err) {
      // The DB is the single enforcer of username uniqueness (partial unique index
      // ux_owners_username) — same posture as POST /api/accounts. Translate rather than
      // pre-checking, which would race.
      if (/UNIQUE|constraint/i.test((err as Error).message)) {
        throw httpError(409, 'username is already taken');
      }
      throw err;
    }
    const row = await store()
      .prepare(`SELECT name, email, username FROM owners WHERE id = ?`)
      .get<{ name: string; email: string | null; username: string | null }>(ownerId);
    if (!row) throw httpError(404, 'owner not found');
    // NOTE: session_epoch is deliberately NOT bumped. The session cookie is keyed by
    // owner id, not username, so a rename doesn't invalidate it — signing the owner out
    // of every device for a cosmetic change would be gratuitous.
    ctx.body = { ok: true, name: row.name, email: row.email, username: row.username };
  });

  // PATCH /api/owner/backup-email  — { backup_email: string | null }
  // A null/empty value clears it. Scoped to the current owner (never the sentinel).
  router.patch('/api/owner/backup-email', async (ctx) => {
    const { backup_email } = (ctx.request.body ?? {}) as { backup_email?: unknown };

    let value: string | null;
    if (backup_email === null || backup_email === '') {
      value = null;
    } else if (typeof backup_email === 'string' && EMAIL_RE.test(backup_email.trim())) {
      value = backup_email.trim();
    } else {
      throw httpError(400, 'a valid email address (or null / empty string to clear) is required');
    }

    await store().prepare(`UPDATE owners SET backup_email = ? WHERE id = ?`).run(value, currentOwnerId());
    ctx.body = { ok: true, backup_email: value };
  });

  return router;
}
