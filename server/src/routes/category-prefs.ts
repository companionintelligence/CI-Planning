import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { getCategoryPrefs, setCategoryPref } from '../services/category-prefs.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Per-category display config. Clone of routes/pattern-prefs.ts, trimmed to the two
 * fields categories carry (color_token, default_minutes). Status codes match
 * pattern-prefs: 404 (tag missing) / 422 (tag not a category). 409 stays reserved for
 * the tags DELETE used/base guards.
 */
export function categoryPrefsRouter() {
  const router = new Router();

  // GET /api/category-prefs → { prefs: Record<categoryTagId, { color_token, default_minutes }> }
  router.get('/api/category-prefs', (ctx) => {
    ctx.body = { prefs: getCategoryPrefs(currentOwnerId()) };
  });

  // PUT /api/category-prefs/:categoryTagId  body: { color_token?: string, default_minutes?: number }
  router.put('/api/category-prefs/:categoryTagId', (ctx) => {
    const owner = currentOwnerId();
    const { categoryTagId } = ctx.params;

    const tag = sqlite.prepare(`SELECT kind FROM tags WHERE id = ?`).get(categoryTagId) as { kind: string } | undefined;
    if (!tag) { ctx.status = 404; ctx.body = { error: 'Tag not found' }; return; }
    if (tag.kind !== 'category') { ctx.status = 422; ctx.body = { error: 'Tag is not a category' }; return; }

    const body = (ctx.request.body ?? {}) as { color_token?: unknown; default_minutes?: unknown };

    if (body.color_token !== undefined && (typeof body.color_token !== 'string' || !body.color_token)) {
      ctx.status = 422; ctx.body = { error: 'color_token must be a non-empty string' }; return;
    }
    if (body.default_minutes !== undefined &&
        !(Number.isInteger(body.default_minutes) && (body.default_minutes as number) > 0)) {
      ctx.status = 422; ctx.body = { error: 'default_minutes must be a positive integer' }; return;
    }

    const pref = setCategoryPref(owner, categoryTagId, {
      color_token: body.color_token as string | undefined,
      default_minutes: body.default_minutes as number | undefined,
    });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `category-prefs:${categoryTagId}` });
    ctx.body = { pref };
  });

  return router;
}
