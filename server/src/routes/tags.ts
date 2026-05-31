import Router from '@koa/router';
import { db, sqlite } from '../db/index.js';
import { tags } from '../db/schema.js';

export function tagsRouter() {
  const router = new Router();

  // GET /api/tags
  router.get('/api/tags', async (ctx) => {
    const rows = sqlite
      .prepare<{ id: number; name: string; count: number }, []>(
        `SELECT tags.id, tags.name, COUNT(task_tags.task_id) as count
         FROM tags
         LEFT JOIN task_tags ON tags.id = task_tags.tag_id
         GROUP BY tags.id
         ORDER BY count DESC, tags.name`
      )
      .all();
    ctx.body = { tags: rows };
  });

  // POST /api/tags
  router.post('/api/tags', async (ctx) => {
    const body = ctx.request.body as { name: string };
    if (!body.name?.trim()) {
      ctx.status = 400;
      ctx.body = { error: 'name is required' };
      return;
    }
    const name = body.name.toLowerCase().replace(/\s+/g, '-').slice(0, 32);
    const [tag] = await db.insert(tags).values({ name }).onConflictDoNothing().returning();
    ctx.status = tag ? 201 : 200;
    ctx.body = { tag: tag ?? sqlite.prepare('SELECT * FROM tags WHERE name = ?').get(name) };
  });

  return router;
}
