import Router from '@koa/router';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import {
  listPeople, getPerson, createPerson, updatePerson, deletePerson, mergePeople,
  accountRoster, personForAccount,
} from '../services/people.js';

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
    const person = await mergePeople(owner, ctx.params.id, body.merge_id);
    if (!person) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'person.merge', entity: `person:${person.id}` });
    broadcast(owner, 'person:updated', { id: person.id });
    ctx.body = { person };
  });

  return router;
}
