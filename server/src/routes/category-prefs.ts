import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { getCategoryPrefs, setCategoryPrefChecked } from '../services/category-prefs.js';

/**
 * Per-category display config. Clone of routes/pattern-prefs.ts, trimmed to the two
 * fields categories carry (color_token, default_minutes). Status codes match
 * pattern-prefs: 404 (tag missing) / 422 (tag not a category). 409 stays reserved for
 * the tags DELETE used/base guards.
 */
export function categoryPrefsRouter() {
  const router = new Router();

  // GET /api/category-prefs → { prefs: Record<categoryTagId, { color_token, default_minutes }> }
  router.get('/api/category-prefs', async (ctx) => {
    ctx.body = { prefs: await getCategoryPrefs(currentOwnerId()) };
  });

  // PUT /api/category-prefs/:categoryTagId  body: { color_token?: string, default_minutes?: number }
  // Validation + upsert live in services/category-prefs.ts (shared with GraphQL).
  router.put('/api/category-prefs/:categoryTagId', async (ctx) => {
    const res = await setCategoryPrefChecked(currentOwnerId(), ctx.params.categoryTagId, (ctx.request.body ?? {}) as Record<string, unknown>);
    if (!res.ok) {
      switch (res.error) {
        case 'tag_not_found': ctx.status = 404; ctx.body = { error: 'Tag not found' }; return;
        case 'not_category': ctx.status = 422; ctx.body = { error: 'Tag is not a category' }; return;
        case 'color_token_invalid': ctx.status = 422; ctx.body = { error: 'color_token must be a non-empty string' }; return;
        case 'default_minutes_invalid': ctx.status = 422; ctx.body = { error: 'default_minutes must be a positive integer' }; return;
      }
      return;
    }
    ctx.body = { pref: res.pref };
  });

  return router;
}
