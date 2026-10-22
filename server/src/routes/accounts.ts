import Router from '@koa/router';
import type Koa from 'koa';
import { store } from '../db/store.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { currentScopes, currentOwnerId } from '../lib/context.js';
import { hasAdminScope, normalizeRole, OWNER_ROLES, type OwnerRole } from '../lib/auth/scopes.js';
import { issueResetToken } from '../lib/auth/resetToken.js';
import { bumpSessionEpoch } from '../lib/auth/session.js';
import { provisionOwner, deleteOwner, listOwners, operatorCount, LastOperatorError, type OwnerAccount } from '../lib/owners.js';
import { SYSTEM_OWNER_ID } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';
import { sendMail } from '../lib/mail/index.js';
import { issueSignupCode, listSignupCodes, revokeSignupCode, getSignupCode } from '../lib/auth/signupCodes.js';

/**
 * Phase AG — operator account management (docs/AG-multitenant-rbac.md). Like
 * /api/jobs and /api/google-config this is a system surface, not owner-scoped data:
 * every route is admin-gated, and under the role split only `operator` sessions
 * (or an API key explicitly issued with planning:admin) carry that scope.
 *
 * Onboarding is by EMAIL INVITE (owner ruling, 2026-07-12): creating an account
 * mints it with NO password and emails a single-use set-your-password link — the
 * existing V reset-token machinery (`password_reset_tokens` + /reset-password),
 * so the operator never knows anyone's password. When the server has no SMTP the
 * link is returned to the operator instead (shown once) to forward out-of-band —
 * the same honesty rule as reset-request's "written to the server log" message.
 *
 * Lockout guards: the instance must always keep at least one operator, so demoting
 * or deleting the last one is refused (409), as is deleting your own account.
 * A role change bumps the target's session epoch so their live sessions re-derive
 * scopes (or die) on the next request; completing an invite/reset link bumps it
 * too (inside /api/auth/reset), so no epoch handling is needed when sending one.
 */

// An invite waits in an inbox; a reset is used within minutes. Resends to an
// account that already has a password keep the short V reset TTL.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function requireAdmin(ctx: Koa.Context): boolean {
  if (hasAdminScope(currentScopes())) return true;
  ctx.status = 403;
  ctx.body = { error: 'forbidden' };
  return false;
}

const isRole = (v: unknown): v is OwnerRole => OWNER_ROLES.includes(v as OwnerRole);
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export type InviteResult = { delivery: 'email'; to: string } | { delivery: 'link'; link: string };

/**
 * Mint a set-password link for `target` and email it. Falls back to handing the
 * link back to the operator when SMTP is unconfigured OR the send fails — an
 * invite must never be silently lost. Precondition: target.email is set.
 */
async function sendInvite(target: OwnerAccount): Promise<InviteResult> {
  const fresh = !target.hasPassword; // first invite vs. reset of an active account
  const raw = await issueResetToken(target.id, fresh ? INVITE_TTL_MS : undefined);
  const link = `${config.mail.appBaseUrl}/reset-password?token=${encodeURIComponent(raw)}`;
  if (!config.mail.host) return { delivery: 'link', link };

  const intro = fresh
    ? `You've been invited to Companion Planning. Your username is "${target.username}".`
    : `An operator sent you a password reset for your Companion Planning account.`;
  const ttlText = fresh ? '7 days' : `${Math.round(config.auth.resetTokenTtlMs / 60000)} minutes`;
  const text = `${intro}\n\nSet your password: ${link}\n\nThis link expires in ${ttlText} and can be used once.`;
  // The token is base64url, but appBaseUrl is operator config — escape the whole
  // URL so an unusual base (query string, quotes) can't malform the attribute.
  const html =
    `<p>${escapeHtml(intro)}</p>` +
    `<p><a href="${escapeHtml(link)}">Set your password</a></p>` +
    `<p>This link expires in ${ttlText} and can be used once.</p>`;
  try {
    await sendMail({ to: target.email!, subject: fresh ? "You're invited to Companion Planning" : 'Reset your Companion Planning password', text, html });
    return { delivery: 'email', to: target.email! };
  } catch (err) {
    // Unlike the public reset-request (fire-and-forget, anti-enumeration), the caller
    // here is the operator — surface the failure honestly by handing them the link.
    logger.warn('account invite: sendMail failed — returning the link to the operator', { owner: target.id, err: (err as Error).message });
    return { delivery: 'link', link };
  }
}

/** One real (non-sentinel) account row, or undefined. */
async function getAccount(id: string): Promise<OwnerAccount | undefined> {
  if (id === SYSTEM_OWNER_ID) return undefined;
  const r = await store()
    .prepare(
      `SELECT id, name, username, email, role, password_hash IS NOT NULL AS has_password
         FROM owners WHERE id = ? AND id <> ?`,
    )
    .get<{ id: string; name: string; username: string | null; email: string | null; role: string; has_password: number }>(
      id, SYSTEM_OWNER_ID);
  if (!r) return undefined;
  // normalizeRole: a hand-edited role string leaves the union the client types
  // expect — read it as 'viewer', the role whose scopes it effectively grants.
  return { id: r.id, name: r.name, username: r.username, email: r.email, role: normalizeRole(r.role), hasPassword: r.has_password === 1 };
}

export function accountsRouter() {
  const router = new Router();

  // GET /api/accounts — every real owner (sentinel excluded), creation order.
  router.get('/api/accounts', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    ctx.body = { accounts: await listOwners() };
  });

  // ── B2: invite codes for local self-serve sign-up (AUTH_SIGNUP=invite) ─────────
  // Registered BEFORE the /:id routes so `signup-codes` is never read as an account id.
  // Codes are the invite-LINK model's sibling for people the operator has no email
  // for (or who should pick their own username): the code admits them to /signup;
  // the account and password are theirs. Hashed at rest; the raw code is shown once.

  // GET /api/accounts/signup-codes — every code, newest first, with a derived status.
  router.get('/api/accounts/signup-codes', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    ctx.body = { codes: await listSignupCodes() };
  });

  // POST /api/accounts/signup-codes — mint one. Body { note? }. Refused unless the
  // policy is `invite`: under `open` nobody needs a code and under `off` nobody can use
  // one, and a code that can never be redeemed is a support ticket, not a feature.
  router.post('/api/accounts/signup-codes', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    if (config.auth.mode !== 'sso' || config.auth.signup !== 'invite') {
      ctx.status = 409;
      ctx.body = {
        error: config.auth.signup === 'open'
          ? 'sign-up is open (AUTH_SIGNUP=open) — nobody needs an invite code'
          : 'self-serve sign-up is off (AUTH_SIGNUP=off) — set AUTH_SIGNUP=invite to use invite codes',
      };
      return;
    }
    const body = (ctx.request.body ?? {}) as { note?: unknown };
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
      ctx.status = 400; ctx.body = { error: 'note must be a string' }; return;
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 120) : null;
    const { code, record } = await issueSignupCode({ createdBy: currentOwnerId(), note });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `signup_code:${record.id}` });
    ctx.status = 201;
    // `code` is the only time the raw value leaves the server.
    ctx.body = { code, signupCode: record };
  });

  // DELETE /api/accounts/signup-codes/:id — revoke. Idempotent on an already-revoked
  // or used code (the row keeps its history); 404 for an unknown id.
  router.delete('/api/accounts/signup-codes/:id', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    if (!(await revokeSignupCode(ctx.params.id))) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'revoke', entity: `signup_code:${ctx.params.id}` });
    ctx.body = { ok: true, signupCode: await getSignupCode(ctx.params.id) };
  });

  // POST /api/accounts — create a local account and send its invite. Body:
  // { username, email, name?, role? }. No password crosses this API: the account
  // is minted password-less and the user sets their own via the invite link.
  router.post('/api/accounts', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = (ctx.request.body ?? {}) as {
      username?: unknown; email?: unknown; name?: unknown; role?: unknown;
    };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username) { ctx.status = 400; ctx.body = { error: 'username is required' }; return; }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || !email.includes('@')) {
      ctx.status = 400; ctx.body = { error: 'email is required — the invite link is sent there' }; return;
    }
    if (body.role !== undefined && !isRole(body.role)) {
      ctx.status = 400; ctx.body = { error: `role must be one of: ${OWNER_ROLES.join(', ')}` }; return;
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      ctx.status = 400; ctx.body = { error: 'name must be a string' }; return;
    }

    let id: string;
    try {
      id = await provisionOwner({
        name: (typeof body.name === 'string' && body.name.trim()) || username,
        username,
        email,
        role: (body.role as OwnerRole | undefined) ?? 'member',
      });
    } catch (err) {
      // ux_owners_username (0101) — the DB is the single enforcer of uniqueness.
      if (/UNIQUE/i.test((err as Error).message)) {
        ctx.status = 409; ctx.body = { error: 'username is already taken' }; return;
      }
      throw err;
    }
    const account = (await getAccount(id))!;
    const invite = await sendInvite(account);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `account:${id}` });
    ctx.status = 201;
    ctx.body = { account, invite };
  });

  // POST /api/accounts/:id/invite — (re)send the set-password link: a fresh invite
  // for an account that never set a password, a reset link for one that has. The
  // newest link supersedes any outstanding one (issueResetToken drops siblings).
  router.post('/api/accounts/:id/invite', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const target = await getAccount(ctx.params.id);
    if (!target) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    if (!target.username) {
      // An OIDC-only account has no local login — a password would be inert; they
      // authenticate (and reset) in CI-Portal.
      ctx.status = 409; ctx.body = { error: 'this account signs in via Companion Portal — no local password to set' }; return;
    }
    if (!target.email) {
      ctx.status = 409; ctx.body = { error: 'this account has no email on file — set one first' }; return;
    }
    const invite = await sendInvite(target);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'invite', entity: `account:${target.id}` });
    ctx.body = { ok: true, invite };
  });

  // PATCH /api/accounts/:id — set role, name, and/or email. Refuses to demote the
  // last operator; a role change invalidates the target's live sessions (epoch bump).
  router.patch('/api/accounts/:id', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = (ctx.request.body ?? {}) as { role?: unknown; name?: unknown; email?: unknown };
    if (body.role === undefined && body.name === undefined && body.email === undefined) {
      ctx.status = 400; ctx.body = { error: 'nothing to update — provide role, name, and/or email' }; return;
    }
    if (body.role !== undefined && !isRole(body.role)) {
      ctx.status = 400; ctx.body = { error: `role must be one of: ${OWNER_ROLES.join(', ')}` }; return;
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      ctx.status = 400; ctx.body = { error: 'name must be a non-empty string' }; return;
    }
    if (body.email !== undefined && body.email !== null && (typeof body.email !== 'string' || !body.email.trim().includes('@'))) {
      ctx.status = 400; ctx.body = { error: 'email must be an email address or null' }; return;
    }

    const target = await getAccount(ctx.params.id);
    if (!target) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const roleChanged = body.role !== undefined && body.role !== target.role;
    if (roleChanged) {
      // Guard + write in ONE statement so the last-operator check is atomic even
      // under concurrent PATCHes (a check-then-write pair could let two demotions
      // both pass the count and leave zero operators). The UPDATE refuses to fire
      // when the target is the final operator and the new role isn't operator.
      const res = await store()
        .prepare(
          `UPDATE owners SET role = @role
             WHERE id = @id AND NOT (
               role = 'operator' AND @role <> 'operator'
               AND (SELECT COUNT(*) FROM owners WHERE role = 'operator' AND id <> @sentinel) <= 1
             )`,
        )
        .run({ role: body.role, id: target.id, sentinel: SYSTEM_OWNER_ID });
      if (res.changes === 0) {
        ctx.status = 409; ctx.body = { error: 'cannot demote the last operator' }; return;
      }
      // Live sessions carry scopes derived at verify time from the OLD role; the
      // epoch bump forces every outstanding cookie to re-login → new scopes.
      await bumpSessionEpoch(target.id);
    }
    if (typeof body.name === 'string') {
      await store().prepare(`UPDATE owners SET name = ? WHERE id = ?`).run(body.name.trim(), target.id);
    }
    if (body.email !== undefined) {
      await store().prepare(`UPDATE owners SET email = ? WHERE id = ?`).run(body.email === null ? null : (body.email as string).trim(), target.id);
    }
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `account:${target.id}` });
    ctx.body = { account: await getAccount(target.id) };
  });

  // DELETE /api/accounts/:id — permanently delete an account and ALL its data.
  // Refuses yourself (use another operator) and the last operator (lockout).
  router.delete('/api/accounts/:id', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const target = await getAccount(ctx.params.id);
    if (!target) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    if (target.id === currentOwnerId()) {
      ctx.status = 409; ctx.body = { error: 'cannot delete your own account' }; return;
    }
    // Fast-path refusal for the common case. This pre-check is ADVISORY under the
    // async facade (an await now sits between count and delete, so two concurrent
    // DELETEs could both pass it) — the atomic enforcement is the guarded
    // owners-row DELETE inside deleteOwner's transaction, surfaced as
    // LastOperatorError and mapped to the same 409 below.
    if (target.role === 'operator' && (await operatorCount()) <= 1) {
      ctx.status = 409; ctx.body = { error: 'cannot delete the last operator' }; return;
    }
    try {
      await deleteOwner(target.id); // refuses the sentinel internally as well
    } catch (err) {
      if (err instanceof LastOperatorError) {
        ctx.status = 409; ctx.body = { error: 'cannot delete the last operator' }; return;
      }
      throw err;
    }
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'delete', entity: `account:${target.id}` });
    ctx.body = { ok: true };
  });

  return router;
}
