import Router from '@koa/router';
import type Koa from 'koa';
import { sqlite } from '../db/index.js';
import { currentScopes, currentOwnerId } from '../lib/context.js';
import { hasAdminScope, OWNER_ROLES, type OwnerRole } from '../lib/auth/scopes.js';
import { hashPassword } from '../lib/auth/password.js';
import { bumpSessionEpoch } from '../lib/auth/session.js';
import { provisionOwner, deleteOwner, listOwners, operatorCount, type OwnerAccount } from '../lib/owners.js';
import { SYSTEM_OWNER_ID } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Phase AG — operator account management (docs/AG-multitenant-rbac.md). Like
 * /api/jobs and /api/google-config this is a system surface, not owner-scoped data:
 * every route is admin-gated, and under the role split only `operator` sessions
 * (or an API key explicitly issued with planning:admin) carry that scope.
 *
 * Lockout guards: the instance must always keep at least one operator, so demoting
 * or deleting the last one is refused (409), as is deleting your own account.
 * Role changes and password resets bump the target's session epoch so their live
 * sessions re-derive scopes (or die) on the next request.
 *
 * The initial/reset password is operator-set and never echoed back — the SMTP-free
 * onboarding path (the operator hands it over; the user changes it after first
 * login via the existing V reset flow or a future change-password surface).
 */

const MIN_PASSWORD_LENGTH = 8; // matches routes/auth.ts's reset floor

function requireAdmin(ctx: Koa.Context): boolean {
  if (hasAdminScope(currentScopes())) return true;
  ctx.status = 403;
  ctx.body = { error: 'forbidden' };
  return false;
}

const isRole = (v: unknown): v is OwnerRole => OWNER_ROLES.includes(v as OwnerRole);

/** One real (non-sentinel) account row, or undefined. */
function getAccount(id: string): OwnerAccount | undefined {
  if (id === SYSTEM_OWNER_ID) return undefined;
  const r = sqlite
    .prepare(
      `SELECT id, name, username, email, role, password_hash IS NOT NULL AS has_password
         FROM owners WHERE id = ? AND id <> ?`,
    )
    .get(id, SYSTEM_OWNER_ID) as
    | { id: string; name: string; username: string | null; email: string | null; role: string; has_password: number }
    | undefined;
  if (!r) return undefined;
  return { id: r.id, name: r.name, username: r.username, email: r.email, role: r.role, hasPassword: r.has_password === 1 };
}

export function accountsRouter() {
  const router = new Router();

  // GET /api/accounts — every real owner (sentinel excluded), creation order.
  router.get('/api/accounts', (ctx) => {
    if (!requireAdmin(ctx)) return;
    ctx.body = { accounts: listOwners() };
  });

  // POST /api/accounts — create a local account. Body: { username, password,
  // name?, email?, role? }. The password is operator-set (shown once client-side,
  // never echoed back here); role defaults to 'member'.
  router.post('/api/accounts', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = (ctx.request.body ?? {}) as {
      username?: unknown; password?: unknown; name?: unknown; email?: unknown; role?: unknown;
    };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username) { ctx.status = 400; ctx.body = { error: 'username is required' }; return; }
    if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD_LENGTH) {
      ctx.status = 400;
      ctx.body = { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
      return;
    }
    if (body.role !== undefined && !isRole(body.role)) {
      ctx.status = 400; ctx.body = { error: `role must be one of: ${OWNER_ROLES.join(', ')}` }; return;
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      ctx.status = 400; ctx.body = { error: 'name must be a string' }; return;
    }
    if (body.email !== undefined && typeof body.email !== 'string') {
      ctx.status = 400; ctx.body = { error: 'email must be a string' }; return;
    }

    const passwordHash = await hashPassword(body.password);
    let id: string;
    try {
      id = provisionOwner({
        name: (typeof body.name === 'string' && body.name.trim()) || username,
        username,
        passwordHash,
        email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : undefined,
        role: (body.role as OwnerRole | undefined) ?? 'member',
      });
    } catch (err) {
      // ux_owners_username (0101) — the DB is the single enforcer of uniqueness.
      if (/UNIQUE/i.test((err as Error).message)) {
        ctx.status = 409; ctx.body = { error: 'username is already taken' }; return;
      }
      throw err;
    }
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `account:${id}` });
    ctx.status = 201;
    ctx.body = { account: getAccount(id) };
  });

  // PATCH /api/accounts/:id — set role and/or name. Refuses to demote the last
  // operator; a role change invalidates the target's live sessions (epoch bump).
  router.patch('/api/accounts/:id', (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = (ctx.request.body ?? {}) as { role?: unknown; name?: unknown };
    if (body.role === undefined && body.name === undefined) {
      ctx.status = 400; ctx.body = { error: 'nothing to update — provide role and/or name' }; return;
    }
    if (body.role !== undefined && !isRole(body.role)) {
      ctx.status = 400; ctx.body = { error: `role must be one of: ${OWNER_ROLES.join(', ')}` }; return;
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      ctx.status = 400; ctx.body = { error: 'name must be a non-empty string' }; return;
    }

    const target = getAccount(ctx.params.id);
    if (!target) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const roleChanged = body.role !== undefined && body.role !== target.role;
    if (roleChanged && target.role === 'operator' && operatorCount() <= 1) {
      ctx.status = 409; ctx.body = { error: 'cannot demote the last operator' }; return;
    }

    if (roleChanged) {
      sqlite.prepare(`UPDATE owners SET role = ? WHERE id = ?`).run(body.role, target.id);
      // Live sessions carry scopes derived at verify time from the OLD role; the
      // epoch bump forces every outstanding cookie to re-login → new scopes.
      bumpSessionEpoch(target.id);
    }
    if (typeof body.name === 'string') {
      sqlite.prepare(`UPDATE owners SET name = ? WHERE id = ?`).run(body.name.trim(), target.id);
    }
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `account:${target.id}` });
    ctx.body = { account: getAccount(target.id) };
  });

  // POST /api/accounts/:id/reset-password — operator sets a new password for a
  // local account (shown once client-side) and signs the target out everywhere.
  router.post('/api/accounts/:id/reset-password', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = (ctx.request.body ?? {}) as { password?: unknown };
    if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD_LENGTH) {
      ctx.status = 400;
      ctx.body = { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
      return;
    }
    const target = getAccount(ctx.params.id);
    if (!target) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    if (!target.username) {
      // An OIDC-only account has no local login — a password would be inert; they
      // authenticate (and reset) in CI-Portal.
      ctx.status = 409; ctx.body = { error: 'this account signs in via CI-Portal — no local password to set' }; return;
    }

    const passwordHash = await hashPassword(body.password);
    sqlite.prepare(`UPDATE owners SET password_hash = ? WHERE id = ?`).run(passwordHash, target.id);
    bumpSessionEpoch(target.id); // every existing session for the target signs out
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'reset-password', entity: `account:${target.id}` });
    ctx.body = { ok: true };
  });

  // DELETE /api/accounts/:id — permanently delete an account and ALL its data.
  // Refuses yourself (use another operator) and the last operator (lockout).
  router.delete('/api/accounts/:id', (ctx) => {
    if (!requireAdmin(ctx)) return;
    const target = getAccount(ctx.params.id);
    if (!target) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    if (target.id === currentOwnerId()) {
      ctx.status = 409; ctx.body = { error: 'cannot delete your own account' }; return;
    }
    if (target.role === 'operator' && operatorCount() <= 1) {
      ctx.status = 409; ctx.body = { error: 'cannot delete the last operator' }; return;
    }
    deleteOwner(target.id); // refuses the sentinel internally as well
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'delete', entity: `account:${target.id}` });
    ctx.body = { ok: true };
  });

  return router;
}
