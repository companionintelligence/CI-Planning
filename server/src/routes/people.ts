import Router from '@koa/router';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { store } from '../db/store.js';
import { config } from '../lib/config.js';
import { provisionOwner } from '../lib/owners.js';
import { newId } from '../lib/ids.js';
import { sendMail } from '../lib/mail/index.js';
import { sendAccountInvite } from './accounts.js';
import { normalizeRole } from '../lib/auth/scopes.js';
import {
  listPeople, getPerson, createPerson, updatePerson, deletePerson, mergePeople,
  accountRoster, personForAccount,
} from '../services/people.js';
import {
  createSharedPlannerInvite, getSharedPlannerInvite, listGuestSharedContent, listSharedPlannerInvites,
  revokeSharedPlannerInvite, updateSharedPlannerInvite, validateSharedPlannerItems, type SharedPlannerItemInput,
} from '../services/shared-planner.js';

/**
 * The person directory (docs/people-on-work.md). Owner-scoped throughout: every handler
 * passes `currentOwnerId()` into the service, and a cross-tenant id reads as 404 rather
 * than 403 — the same invisibility rule the rest of the API follows.
 *
 * `account_id` is NOT settable through this surface. A client must never be able to
 * claim that one of its directory entries is a permissioned account; the only path that
 * sets it is POST /accounts/:id, which verifies the account exists first.
 */
export function peopleRouter() {
  const router = new Router();
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

  // Guest sessions have a distinct, read-only API. requireAuth limits their token to
  // this endpoint and /auth/me, so none of the usual owner data routes are reachable.
  router.get('/api/guest/shared', async (ctx) => {
    ctx.body = await listGuestSharedContent(currentOwnerId());
  });

  router.get('/api/people', async (ctx) => {
    ctx.body = { people: await listPeople(currentOwnerId()) };
  });

  /**
   * The roster the `us` shortcut pre-fills from. Deliberately minimal — id + name only.
   *
   * NOT a relaxation of GET /api/accounts, which is operator-only because it returns
   * email, role and hasPassword. A member filling in a people field needs to know who
   * exists, not their contact details or privileges.
   *
   * Pure read: an account becomes a directory row only when somebody picks it
   * (POST below), so a GET never writes.
   */
  router.get('/api/people/accounts', async (ctx) => {
    ctx.body = { accounts: await accountRoster(currentOwnerId()) };
  });

  /**
   * Find-or-create this owner's directory row for a permissioned account — the write
   * that happens when the user picks somebody off the roster. Idempotent, so the client
   * may call it every time without checking first.
   */
  router.post('/api/people/accounts/:id', async (ctx) => {
    const owner = currentOwnerId();
    const person = await personForAccount(owner, ctx.params.id);
    if (!person) { ctx.status = 404; ctx.body = { error: 'account not found' }; return; }
    ctx.body = { person };
  });

  router.get('/api/people/shares', async (ctx) => {
    ctx.body = { invites: await listSharedPlannerInvites(currentOwnerId()) };
  });

  const readShareItems = (raw: unknown): SharedPlannerItemInput[] | null => {
    if (!Array.isArray(raw)) return null;
    const out: SharedPlannerItemInput[] = [];
    for (const value of raw) {
      if (!value || typeof value !== 'object') return null;
      const item = value as Record<string, unknown>;
      if ((item.entity_kind !== 'task' && item.entity_kind !== 'objective') || typeof item.entity_id !== 'string' || !item.entity_id.trim()) return null;
      out.push({ entity_kind: item.entity_kind, entity_id: item.entity_id.trim() });
    }
    return out;
  };

  router.post('/api/people/shares', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { email?: unknown; items?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const items = readShareItems(body.items);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { ctx.status = 422; ctx.body = { error: 'Enter a valid email address.' }; return; }
    if (!items || items.length === 0) { ctx.status = 422; ctx.body = { error: 'Choose at least one task or objective to share.' }; return; }
    try { await validateSharedPlannerItems(owner, items); }
    catch (err) { ctx.status = 422; ctx.body = { error: (err as Error).message }; return; }
    const ownEmail = await store().prepare(`SELECT email FROM owners WHERE id = ?`).get<{ email: string | null }>(owner);
    if (ownEmail?.email?.toLowerCase() === email) { ctx.status = 422; ctx.body = { error: 'That email belongs to your own account.' }; return; }

    const accounts = await store().prepare(
      `SELECT id, name, role, username, email, password_hash IS NOT NULL AS has_password
         FROM owners WHERE lower(email) = lower(?) AND id <> ? LIMIT 2`,
    ).all<{ id: string; name: string; role: string; username: string | null; email: string | null; has_password: number }>(email, owner);
    if (accounts.length > 1) { ctx.status = 409; ctx.body = { error: 'More than one app account uses this email. Ask an operator to resolve the duplicate accounts.' }; return; }

    let recipient = accounts[0] ?? null;
    let passwordInvite: { delivery: 'email' | 'link'; to?: string; link?: string } | null = null;
    if (!recipient) {
      if (config.auth.mode !== 'sso') { ctx.status = 409; ctx.body = { error: 'This install cannot create invited accounts. Ask an operator to add the account first.' }; return; }
      const username = `guest-${newId().slice(-10)}`;
      const displayName = email.split('@')[0]!.replace(/[._+-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80) || email;
      const id = await provisionOwner({ name: displayName, email, username, role: 'guest' });
      recipient = { id, name: displayName, role: 'guest', username, email, has_password: 0 };
      passwordInvite = await sendAccountInvite({ id: recipient.id, name: recipient.name, username: recipient.username, email: recipient.email, role: normalizeRole(recipient.role), hasPassword: false });
    } else if (recipient.role === 'guest' && recipient.has_password === 0 && recipient.username) {
      passwordInvite = await sendAccountInvite({ id: recipient.id, name: recipient.name, username: recipient.username, email: recipient.email, role: normalizeRole(recipient.role), hasPassword: false });
    }

    let invite;
    try {
      invite = await createSharedPlannerInvite(owner, email, recipient?.id ?? null, items);
    } catch (err) {
      ctx.status = 422; ctx.body = { error: (err as Error).message }; return;
    }
    let delivery: 'email' | 'link' = passwordInvite?.delivery ?? 'email';
    let inviteLink = passwordInvite?.delivery === 'link' ? passwordInvite.link : undefined;
    if (!passwordInvite) {
      const itemNames = await Promise.all(items.map(async (item) => {
        const table = item.entity_kind === 'task' ? 'tasks' : 'objectives';
        const row = await store().prepare(`SELECT title FROM ${table} WHERE id = ? AND owner_id = ?`).get<{ title: string }>(item.entity_id, owner);
        return row?.title ?? 'shared item';
      }));
      const link = `${config.mail.appBaseUrl}/login`;
      const intro = `${(await store().prepare(`SELECT name FROM owners WHERE id = ?`).get<{ name: string }>(owner))?.name ?? 'A planner owner'} shared items with you in Companion Planning.`;
      try {
        const sent = await sendMail({
          to: email,
          subject: 'Companion Planning shared items',
          text: `${intro}\n\n${itemNames.map((name) => `• ${name}`).join('\n')}\n\nSign in to view them: ${link}`,
          html: `<p>${escapeHtml(intro)}</p><ul>${itemNames.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul><p><a href="${escapeHtml(link)}">Sign in to Companion Planning</a></p>`,
        });
        if (sent.transport === 'console') { delivery = 'link'; inviteLink = link; }
      } catch {
        // The invite remains editable; the owner can resend it from Settings → People.
      }
    }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'share.create', entity: `share:${invite.id}` });
    if (invite.recipient_owner_id && invite.status === 'active') {
      broadcast(invite.recipient_owner_id, 'task:updated', { sharedAccessChanged: true });
    }
    ctx.status = 201;
    ctx.body = { invite, ...(inviteLink ? { invite_link: inviteLink } : {}), delivery };
  });

  router.patch('/api/people/shares/:id', async (ctx) => {
    const owner = currentOwnerId();
    const items = readShareItems((ctx.request.body as { items?: unknown } | undefined)?.items);
    if (!items) { ctx.status = 422; ctx.body = { error: 'items must be a list of tasks or objectives.' }; return; }
    let invite;
    try { invite = await updateSharedPlannerInvite(owner, ctx.params.id, items); }
    catch (err) { ctx.status = 422; ctx.body = { error: (err as Error).message }; return; }
    if (!invite) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'share.update', entity: `share:${invite.id}` });
    if (invite.recipient_owner_id && invite.status === 'active') {
      broadcast(invite.recipient_owner_id, 'task:updated', { sharedAccessChanged: true });
    }
    ctx.body = { invite };
  });

  router.post('/api/people/shares/:id/resend', async (ctx) => {
    const owner = currentOwnerId();
    const invite = await getSharedPlannerInvite(owner, ctx.params.id);
    if (!invite || invite.status === 'revoked') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const account = invite.recipient_owner_id ? await store().prepare(
      `SELECT id, name, role, username, email, password_hash IS NOT NULL AS has_password FROM owners WHERE id = ?`,
    ).get<{ id: string; name: string; role: string; username: string | null; email: string | null; has_password: number }>(invite.recipient_owner_id) : null;
    let result: { delivery: 'email' | 'link'; link?: string };
    if (!account) {
      const sent = await sendMail({ to: invite.email, subject: 'Companion Planning invitation', text: `You have been invited to view shared items. Sign in at ${config.mail.appBaseUrl}/login using ${invite.email}.`, html: `<p>You have been invited to view shared items in Companion Planning.</p><p><a href="${config.mail.appBaseUrl}/login">Sign in</a> using ${invite.email}.</p>` });
      result = sent.transport === 'console' ? { delivery: 'link', link: `${config.mail.appBaseUrl}/login` } : { delivery: 'email' };
    } else if (account.role === 'guest' && account.username && account.has_password === 0) {
      result = await sendAccountInvite({ id: account.id, name: account.name, username: account.username, email: account.email, role: normalizeRole(account.role), hasPassword: false });
    } else {
      const link = `${config.mail.appBaseUrl}/login`;
      const sent = await sendMail({ to: invite.email, subject: 'Companion Planning shared items', text: `Shared items are ready for you. Sign in: ${link}`, html: `<p>Shared items are ready for you.</p><p><a href="${link}">Sign in</a></p>` });
      result = sent.transport === 'console' ? { delivery: 'link', link } : { delivery: 'email' };
    }
    ctx.body = { ok: true, ...(result.delivery === 'link' ? { invite_link: result.link } : {}), delivery: result.delivery };
  });

  router.delete('/api/people/shares/:id', async (ctx) => {
    const owner = currentOwnerId();
    const invite = await getSharedPlannerInvite(owner, ctx.params.id);
    if (!(await revokeSharedPlannerInvite(owner, ctx.params.id))) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'share.revoke', entity: `share:${ctx.params.id}` });
    if (invite?.recipient_owner_id) broadcast(invite.recipient_owner_id, 'task:updated', { sharedAccessChanged: true });
    ctx.body = { ok: true };
  });

  router.get('/api/people/:id', async (ctx) => {
    const person = await getPerson(currentOwnerId(), ctx.params.id);
    if (!person) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { person };
  });

  router.post('/api/people', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { display_name?: unknown; emails?: unknown };
    const name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    if (!name) { ctx.status = 422; ctx.body = { error: 'display_name is required' }; return; }
    const emails = Array.isArray(body.emails) ? body.emails.filter((e): e is string => typeof e === 'string') : [];
    // source/confirmed/account_id are server-decided: a hand-created person is manual
    // and confirmed by definition, and no client may claim an account link.
    const person = await createPerson(owner, { display_name: name, emails, source: 'manual', confirmed: true });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'person.create', entity: `person:${person.id}` });
    broadcast(owner, 'person:created', { id: person.id });
    ctx.status = 201;
    ctx.body = { person };
  });

  router.patch('/api/people/:id', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as {
      display_name?: unknown; notes?: unknown; confirmed?: unknown; emails?: unknown;
    };
    let person;
    try {
      person = await updatePerson(owner, ctx.params.id, {
        ...(typeof body.display_name === 'string' ? { display_name: body.display_name } : {}),
        ...(typeof body.notes === 'string' || body.notes === null ? { notes: body.notes as string | null } : {}),
        ...(typeof body.confirmed === 'boolean' ? { confirmed: body.confirmed } : {}),
        ...(Array.isArray(body.emails)
          ? { emails: body.emails.filter((e): e is string => typeof e === 'string') }
          : {}),
      });
    } catch (err) {
      ctx.status = 422; ctx.body = { error: (err as Error).message }; return;
    }
    if (!person) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'person.update', entity: `person:${person.id}` });
    broadcast(owner, 'person:updated', { id: person.id });
    ctx.body = { person };
  });

  router.delete('/api/people/:id', async (ctx) => {
    const owner = currentOwnerId();
    const res = await deletePerson(owner, ctx.params.id);
    if (res === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    // The self row anchors the "me" shortcut; removing it would silently break both
    // people fields, so it is refused rather than cascaded.
    if (res === 'is_self') { ctx.status = 422; ctx.body = { error: 'cannot delete your own person row' }; return; }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'person.delete', entity: `person:${ctx.params.id}` });
    broadcast(owner, 'person:deleted', { id: ctx.params.id });
    ctx.status = 204;
  });

  /** Fold a duplicate into a keeper, moving addresses and every attachment. */
  router.post('/api/people/:id/merge', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { merge_id?: unknown };
    if (typeof body.merge_id !== 'string' || !body.merge_id) {
      ctx.status = 422; ctx.body = { error: 'merge_id is required' }; return;
    }
    let person;
    try {
      person = await mergePeople(owner, ctx.params.id, body.merge_id);
    } catch (err) {
      ctx.status = 422; ctx.body = { error: (err as Error).message }; return;
    }
    if (!person) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'person.merge', entity: `person:${person.id}` });
    broadcast(owner, 'person:updated', { id: person.id });
    ctx.body = { person };
  });

  return router;
}
