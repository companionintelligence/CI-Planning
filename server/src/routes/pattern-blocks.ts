import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import {
  clearDatePatternBlockOverrides, getPatternBlocks, getPatternBlocksForDate,
  replaceDatePatternBlockRanges, replacePatternBlockRanges,
} from '../services/pattern-blocks.js';
import { isValidISODate } from '../lib/dates.js';

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

  // Date-scoped windows inherit the resolved day-type defaults until edited here.
  router.get('/api/pattern-blocks/date/:date', async (ctx) => {
    const { date } = ctx.params;
    if (!isValidISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    ctx.body = await getPatternBlocksForDate(currentOwnerId(), date);
  });

  // Replace/clear the selected date's complete set of direction overrides.
  router.delete('/api/pattern-blocks/date/:date', async (ctx) => {
    const { date } = ctx.params;
    if (!isValidISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    await clearDatePatternBlockOverrides(currentOwnerId(), date);
    ctx.body = { ok: true };
  });

  router.put('/api/pattern-blocks/date/:date/:dirTagId', async (ctx) => {
    const owner = currentOwnerId();
    const { date, dirTagId } = ctx.params;
    if (!isValidISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    const body = ctx.request.body as { ranges?: unknown };
    if (!Array.isArray(body?.ranges)) { ctx.status = 422; ctx.body = { error: 'ranges must be an array' }; return; }
    const res = await replaceDatePatternBlockRanges(owner, dirTagId, date, body.ranges as { start_time: string; end_time: string }[]);
    if (!res.ok) {
      if (res.error === 'tag_not_found') { ctx.status = 404; ctx.body = { error: 'Tag not found' }; return; }
      if (res.error === 'not_direction') { ctx.status = 422; ctx.body = { error: 'Tag is not a direction' }; return; }
      ctx.status = 422; ctx.body = { error: res.message ?? 'Invalid date' }; return;
    }
    ctx.body = { ranges: res.ranges };
  });

  // GET /api/pattern-blocks/:dayType → default DirectionWindows for one day type (incl. custom).
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
