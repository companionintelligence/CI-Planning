import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import {
  normalizeTagName, tagIsUsed, setTagDirections, directionsOf,
  setCategoryMemberships, categoriesOf, directionOptoutsOf, setDirectionEnabled, categoryIsReferenced,
} from '../services/tags.js';
import { setCategoryPref } from '../services/category-prefs.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';

/** Resolve direction NAMES to existing direction-tag ids (ignores unknown / non-directions). */
function directionIds(names: string[]): string[] {
  const out: string[] = [];
  const find = sqlite.prepare(`SELECT id FROM tags WHERE name = ? AND kind = 'pattern'`);
  for (const n of names) {
    const row = find.get(normalizeTagName(n)) as { id: string } | undefined;
    if (row) out.push(row.id);
  }
  return out;
}

/** Resolve category NAMES to existing category-tag ids (ignores unknown / non-categories). */
function categoryIds(names: string[]): string[] {
  const out: string[] = [];
  const find = sqlite.prepare(`SELECT id FROM tags WHERE name = ? AND kind = 'category'`);
  for (const n of names) {
    const row = find.get(normalizeTagName(n)) as { id: string } | undefined;
    if (row) out.push(row.id);
  }
  return out;
}

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
          GROUP BY t.id
          ORDER BY t.kind DESC, count DESC, t.name`,
      )
      .all() as { id: string; name: string; kind: string; isBase: number; muted: number; count: number }[];
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

  // POST /api/tags — { name, kind?='intention', directions?: string[] }.
  router.post('/api/tags', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { name?: string; kind?: string; directions?: string[]; categories?: string[] };
    if (!body.name?.trim()) { ctx.status = 400; ctx.body = { error: 'name is required' }; return; }
    const name = normalizeTagName(body.name);
    if (!name) { ctx.status = 400; ctx.body = { error: 'name is required' }; return; }
    const kind = body.kind === 'pattern' ? 'pattern' : body.kind === 'category' ? 'category' : 'intention';

    let tag = sqlite.prepare('SELECT * FROM tags WHERE name = ?').get(name) as
      | { id: string; name: string; kind: string }
      | undefined;
    if (!tag) {
      tag = sqlite
        .prepare(`INSERT INTO tags (id, name, kind) VALUES (?, ?, ?) RETURNING *`)
        .get(newId(), name, kind) as { id: string; name: string; kind: string };
    }
    // A new category gets a default category_prefs row up-front so a block created
    // against it always has a color stamp source (forward-only never falls through).
    if (tag.kind === 'category') setCategoryPref(currentOwnerId(), tag.id, {});
    if (tag.kind === 'intention' && Array.isArray(body.directions) && body.directions.length) {
      setTagDirections(tag.id, directionIds(body.directions));
    }
    if (tag.kind === 'intention' && Array.isArray(body.categories) && body.categories.length) {
      setCategoryMemberships(tag.id, categoryIds(body.categories));
    }
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `tag:${tag.id}` });
    ctx.status = 201;
    ctx.body = { tag: {
      ...tag,
      directions: tag.kind === 'intention' ? directionsOf(tag.id) : [],
      categories: tag.kind === 'intention' ? categoriesOf(tag.id) : [],
      direction_optouts: tag.kind === 'category' ? directionOptoutsOf(tag.id) : [],
    } };
  });

  // PATCH /api/tags/:id — { directions?: string[] (REPLACE membership = drag-move), muted? }.
  router.patch('/api/tags/:id', async (ctx) => {
    const id = ctx.params.id;
    const tag = sqlite.prepare('SELECT id, kind FROM tags WHERE id = ?').get(id) as
      | { id: string; kind: string }
      | undefined;
    if (!tag) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as {
      directions?: string[];
      categories?: string[];
      direction_toggle?: { patternTagId?: string; enabled?: boolean };
      muted?: boolean;
      name?: string;
    };

    if (Array.isArray(body.directions) && tag.kind === 'intention') {
      setTagDirections(id, directionIds(body.directions));
    }
    if (Array.isArray(body.categories) && tag.kind === 'intention') {
      setCategoryMemberships(id, categoryIds(body.categories));
    }
    if (body.direction_toggle && tag.kind === 'category'
        && typeof body.direction_toggle.patternTagId === 'string'
        && typeof body.direction_toggle.enabled === 'boolean') {
      setDirectionEnabled(id, body.direction_toggle.patternTagId, body.direction_toggle.enabled);
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      const newName = normalizeTagName(body.name);
      if (newName) {
        const clash = sqlite.prepare('SELECT 1 FROM tags WHERE name = ? AND id != ?').get(newName, id);
        if (clash) { ctx.status = 409; ctx.body = { error: 'a tag with that name already exists' }; return; }
        sqlite.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName, id);
      }
    }
    if (typeof body.muted === 'boolean') {
      sqlite.prepare('UPDATE tags SET muted = ? WHERE id = ?').run(body.muted ? 1 : 0, id);
    }
    const out = sqlite
      .prepare('SELECT id, name, kind, is_base AS isBase, muted FROM tags WHERE id = ?')
      .get(id) as { id: string; name: string; kind: string; isBase: number; muted: number };
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `tag:${id}` });
    ctx.body = {
      tag: {
        ...out, is_base: !!out.isBase, muted: !!out.muted,
        directions: out.kind === 'intention' ? directionsOf(id) : [],
        categories: out.kind === 'intention' ? categoriesOf(id) : [],
        direction_optouts: out.kind === 'category' ? directionOptoutsOf(id) : [],
      },
    };
  });

  // DELETE /api/tags/:id — a used tag or a base direction cannot be deleted.
  router.delete('/api/tags/:id', async (ctx) => {
    const id = ctx.params.id;
    const tag = sqlite.prepare('SELECT id, kind, is_base AS isBase FROM tags WHERE id = ?').get(id) as
      | { id: string; kind: string; isBase: number }
      | undefined;
    if (!tag) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    if (tag.isBase) { ctx.status = 409; ctx.body = { error: 'base tags cannot be deleted' }; return; }
    // A category's refs live in time_blocks.category_id + tag_categories (not entity_tags),
    // so tagIsUsed() doesn't see them — guard categories separately.
    if (tag.kind === 'category') {
      if (categoryIsReferenced(id)) { ctx.status = 409; ctx.body = { error: 'category has members or is used by a time block' }; return; }
    } else if (tagIsUsed(id)) {
      ctx.status = 409; ctx.body = { error: 'tags in use cannot be deleted' }; return;
    }
    sqlite.prepare('DELETE FROM tags WHERE id = ?').run(id); // tag_patterns / tag_categories / optouts cascade via FK
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'delete', entity: `tag:${id}` });
    ctx.body = { ok: true };
  });

  return router;
}
