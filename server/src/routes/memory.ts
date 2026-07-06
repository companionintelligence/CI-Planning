import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { sqlite } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { memoryStatus, syncToMemory } from '../services/memory.js';
import { storeMemoryConnection, deleteMemoryConnection } from '../connectors/memory.js';
import { suggestFromMemory } from '../agents/memory-suggest.js';

export function memoryRouter() {
  const router = new Router();

  // GET /api/memory/status — connection + sync state for the Settings panel.
  // AA0: `pull` reports the CI-Server pull connector (flag / availability / source).
  router.get('/api/memory/status', async (ctx) => {
    ctx.body = memoryStatus(currentOwnerId());
  });

  // POST /api/memory/connect — store the owner's CI-Server connection (AA0).
  // Body: { url, api_key? } (apiKey accepted too). Sealed with the KEK into
  // connection_tokens (provider='ci_memory'); also stamps memory_account (the URL
  // host) so the Settings card's "Connected as …" reflects the connection.
  router.post('/api/memory/connect', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const apiKey =
      typeof body.api_key === 'string' ? body.api_key : typeof body.apiKey === 'string' ? body.apiKey : undefined;
    const bearer = typeof body.bearer === 'string' ? body.bearer : undefined;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      ctx.status = 422;
      ctx.body = { error: 'url must be a valid http(s) URL' };
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.status = 422;
      ctx.body = { error: 'url must be a valid http(s) URL' };
      return;
    }

    let account: string;
    try {
      account = storeMemoryConnection(owner, { url, apiKey, bearer });
    } catch (err) {
      // Almost always a missing/short CP_KEK_B64 — surface the real message, never the key.
      ctx.status = 500;
      ctx.body = { error: `Could not store the connection: ${(err as Error).message}` };
      return;
    }
    sqlite.prepare(`UPDATE scheduling_prefs SET memory_account = ? WHERE owner_id = ?`).run(account, owner);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'connect', entity: 'memory:ci_server' });
    ctx.status = 201;
    ctx.body = memoryStatus(owner);
  });

  // POST /api/memory/disconnect — drop the stored connection + clear the account
  // label. Env-fallback creds (CI_SERVER_URL) are deployment config, not per-owner
  // state, so `pull.available` may remain true afterwards — `source` says why.
  router.post('/api/memory/disconnect', async (ctx) => {
    const owner = currentOwnerId();
    deleteMemoryConnection(owner);
    sqlite.prepare(`UPDATE scheduling_prefs SET memory_account = NULL WHERE owner_id = ?`).run(owner);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'disconnect', entity: 'memory:ci_server' });
    ctx.body = memoryStatus(owner);
  });

  // POST /api/memory/suggest — manual AA1 trigger (testing/UX "pull now"). Same
  // gates as the scheduled job: flag on AND connector available.
  router.post('/api/memory/suggest', async (ctx) => {
    const r = await suggestFromMemory();
    if (r.status === 'flag_off') {
      ctx.status = 400;
      ctx.body = { reason: 'disabled', error: 'Memory suggestions are turned off' };
      return;
    }
    if (r.status === 'unavailable') {
      ctx.status = 503;
      ctx.body = { reason: 'unavailable', error: 'Companion Memory is not reachable — connect it in Settings' };
      return;
    }
    ctx.body = r;
  });

  // POST /api/memory/sync — trigger a one-way push now. Stubbed until AA4 lands:
  // returns 503 'unavailable' (sync off → 400, not connected → 400).
  router.post('/api/memory/sync', async (ctx) => {
    const r = syncToMemory(currentOwnerId());
    if (!r.ok) {
      ctx.status = r.reason === 'unavailable' ? 503 : 400;
      ctx.body = {
        reason: r.reason,
        error:
          r.reason === 'disabled'
            ? 'Memory sync is turned off'
            : r.reason === 'not_connected'
              ? 'Connect Companion Memory first'
              : 'Companion Memory push arrives with AA4 — not available yet',
      };
      return;
    }
    ctx.body = r;
  });

  return router;
}
