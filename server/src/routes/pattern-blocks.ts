import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { getPatternBlocks, replacePatternBlockRanges } from '../services/pattern-blocks.js';

export function patternBlocksRouter() {
  const router = new Router();

  // GET /api/pattern-blocks → { workday: DirectionWindows, weekend: DirectionWindows }
  router.get('/api/pattern-blocks', async (ctx) => {
    const owner = currentOwnerId();
    ctx.body = {
      workday: await getPatternBlocks(owner, 'workday'),
      weekend: await getPatternBlocks(owner, 'weekend'),
    };
  });

  // GET /api/pattern-blocks/:dayType → DirectionWindows for one day type (incl. custom).
  router.get('/api/pattern-blocks/:dayType', async (ctx) => {
    ctx.body = { windows: await getPatternBlocks(currentOwnerId(), ctx.params.dayType) };
  });

  // PUT /api/pattern-blocks/:dirTagId/:dayType  body: { ranges: [{start_time,end_time}] }
  // Replaces all ranges for that direction+dayType atomically.
  router.put('/api/pattern-blocks/:dirTagId/:dayType', async (ctx) => {
    const owner = currentOwnerId();
    const { dirTagId, dayType } = ctx.params;
    const body = ctx.request.body as { ranges?: unknown };
    // REST body hygiene: guard the untyped `ranges` before handing it to the service.
    if (!Array.isArray(body?.ranges)) { ctx.status = 422; ctx.body = { error: 'ranges must be an array' }; return; }

    const res = await replacePatternBlockRanges(owner, dirTagId, dayType, body.ranges as { start_time: string; end_time: string }[]);
    if (!res.ok) {
      if (res.error === 'tag_not_found') { ctx.status = 404; ctx.body = { error: 'Tag not found' }; return; }
      if (res.error === 'not_direction') { ctx.status = 422; ctx.body = { error: 'Tag is not a direction' }; return; }
      if (res.error === 'invalid_day_type') { ctx.status = 422; ctx.body = { error: 'Invalid day_type' }; return; }
      ctx.status = 422; ctx.body = { error: res.message }; return;
    }
    ctx.body = { ranges: res.ranges };
  });

  return router;
}
