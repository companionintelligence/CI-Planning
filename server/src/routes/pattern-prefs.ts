import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { getPatternPrefs, setPatternPrefChecked } from '../services/pattern-prefs.js';

export function patternPrefsRouter() {
  const router = new Router();

  // GET /api/pattern-prefs → { prefs: Record<string, { auto_fill: boolean, reminder_offsets: number[] }> }
  router.get('/api/pattern-prefs', async (ctx) => {
    const owner = currentOwnerId();
    ctx.body = { prefs: await getPatternPrefs(owner) };
  });

  // PUT /api/pattern-prefs/:patternTagId  body: { auto_fill?, reminder_offsets?, icon_shape?, color_token?, default_minutes? }
  // Validation + upsert live in services/pattern-prefs.ts (shared with GraphQL); this maps
  // the discriminated result back to the original REST status codes + messages.
  router.put('/api/pattern-prefs/:patternTagId', async (ctx) => {
    const owner = currentOwnerId();
    const res = await setPatternPrefChecked(owner, ctx.params.patternTagId, (ctx.request.body ?? {}) as Record<string, unknown>);
    if (!res.ok) {
      switch (res.error) {
        case 'tag_not_found': ctx.status = 404; ctx.body = { error: 'Tag not found' }; return;
        case 'not_direction': ctx.status = 422; ctx.body = { error: 'Tag is not a direction' }; return;
        case 'auto_fill_type': ctx.status = 422; ctx.body = { error: 'auto_fill must be a boolean' }; return;
        case 'reminder_offsets_invalid': ctx.status = 422; ctx.body = { error: 'reminder_offsets must be an array of non-negative integers' }; return;
        case 'icon_shape_invalid': ctx.status = 422; ctx.body = { error: 'icon_shape must be circle, square, or triangle' }; return;
        case 'color_token_invalid': ctx.status = 422; ctx.body = { error: 'color_token must be a non-empty string' }; return;
        case 'default_minutes_invalid': ctx.status = 422; ctx.body = { error: 'default_minutes must be a positive integer' }; return;
      }
      return;
    }
    ctx.body = { pref: res.pref };
  });

  return router;
}
