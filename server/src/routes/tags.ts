import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import {
  directionsOf, categoriesOf, directionOptoutsOf,
  createTag, updateTag, deleteTag,
} from '../services/tags.js';
import { currentOwnerId } from '../lib/context.js';

export function tagsRouter() {
  const router = new Router();

  // GET /api/tags — every tag with its taxonomy facets. `count`/`used` come from the
  // canonical entity_tags store (covers tasks · time blocks · routines). The client
  // groups directions / intentions / Unsorted from this one list.
  router.get('/api/tags', async (ctx) => {
    const rows = sqlite
      .prepare(
        `SELECT t.id, t.name, t.kind, t.is_base AS isBase, t.muted,
                COUNT(et.tag_id) AS count
           FROM tags t
           LEFT JOIN entity_tags et ON et.tag_id = t.id
          WHERE t.owner_id = ?
          GROUP BY t.id
          ORDER BY t.kind DESC, count DESC, t.name`,
      )
      .all(currentOwnerId()) as { id: string; name: string; kind: string; isBase: number; muted: number; count: number }[];
    const tags = rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      is_base: !!r.isBase,
      muted: !!r.muted,
      count: r.count,
      used: r.count > 0,
      directions: r.kind === 'intention' ? directionsOf(r.id) : [],
      categories: r.kind === 'intention' ? categoriesOf(r.id) : [],
      direction_optouts: r.kind === 'category' ? directionOptoutsOf(r.id) : [],
    }));
    ctx.body = { tags };
  });

  // POST /api/tags — { name, kind?='intention', directions?, categories? }. Business logic
  // lives in services/tags.createTag (shared with the GraphQL createTag mutation).
  router.post('/api/tags', async (ctx) => {
    const res = createTag(currentOwnerId(), (ctx.request.body ?? {}) as Parameters<typeof createTag>[1]);
    if (!res.ok) { ctx.status = 400; ctx.body = { error: 'name is required' }; return; }
    const tag = res.tag;
    ctx.status = 201;
    ctx.body = { tag: {
      ...tag,
      directions: tag.kind === 'intention' ? directionsOf(tag.id) : [],
      categories: tag.kind === 'intention' ? categoriesOf(tag.id) : [],
      direction_optouts: tag.kind === 'category' ? directionOptoutsOf(tag.id) : [],
    } };
  });

  // PATCH /api/tags/:id — { name?, muted?, directions?, categories?, direction_toggle? }.
  // Shared with the GraphQL updateTag mutation (services/tags.updateTag).
  router.patch('/api/tags/:id', async (ctx) => {
    const res = updateTag(currentOwnerId(), ctx.params.id, (ctx.request.body ?? {}) as Parameters<typeof updateTag>[2]);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      ctx.status = 409; ctx.body = { error: 'a tag with that name already exists' }; return;
    }
    const out = res.tag;
    ctx.body = {
      tag: {
        ...out, is_base: !!out.isBase, muted: !!out.muted,
        directions: out.kind === 'intention' ? directionsOf(out.id) : [],
        categories: out.kind === 'intention' ? categoriesOf(out.id) : [],
        direction_optouts: out.kind === 'category' ? directionOptoutsOf(out.id) : [],
      },
    };
  });

  // DELETE /api/tags/:id — a used tag or a base direction cannot be deleted.
  // Shared with the GraphQL deleteTag mutation (services/tags.deleteTag).
  router.delete('/api/tags/:id', async (ctx) => {
    const res = deleteTag(currentOwnerId(), ctx.params.id);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (res.error === 'base') { ctx.status = 409; ctx.body = { error: 'base tags cannot be deleted' }; return; }
      ctx.status = 409;
      ctx.body = { error: res.error === 'category_in_use' ? 'category has members or is used by a time block' : 'tags in use cannot be deleted' };
      return;
    }
    ctx.body = { ok: true };
  });

  return router;
}
