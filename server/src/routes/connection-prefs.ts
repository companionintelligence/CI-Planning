import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { getConnectionPrefs, setConnectionPrefChecked, CONNECTION_TEXTURES } from '../services/connection-prefs.js';

/**
 * Per-connection display config (colour + stripe texture). Sibling of
 * routes/category-prefs.ts; auth/scope is enforced globally by requireAuth (GET needs
 * planning:read, PUT needs planning:write), so there is no per-route guard here.
 *
 * `:account` is URL-decoded by the router — Google accounts are email addresses and
 * carry '@' and sometimes '+'.
 */
export function connectionPrefsRouter() {
  const router = new Router();

  // GET /api/connection-prefs → { prefs: Record<`provider:account`, { color_token, texture }> }
  router.get('/api/connection-prefs', async (ctx) => {
    ctx.body = { prefs: await getConnectionPrefs(currentOwnerId()) };
  });

  // PUT /api/connection-prefs/:provider/:account  body: { color_token?, texture? }
  router.put('/api/connection-prefs/:provider/:account', async (ctx) => {
    const { provider, account } = ctx.params;
    const res = await setConnectionPrefChecked(currentOwnerId(), provider, account, (ctx.request.body ?? {}) as Record<string, unknown>);
    if (!res.ok) {
      switch (res.error) {
        case 'connection_not_found': ctx.status = 404; ctx.body = { error: 'Connection not found' }; return;
        case 'color_token_invalid': ctx.status = 422; ctx.body = { error: 'color_token must be a non-empty string' }; return;
        case 'texture_invalid': ctx.status = 422; ctx.body = { error: `texture must be one of: ${CONNECTION_TEXTURES.join(', ')}` }; return;
      }
      return;
    }
    ctx.body = { pref: res.pref };
  });

  return router;
}
