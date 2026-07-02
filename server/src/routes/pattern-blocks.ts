import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { getPatternBlocks, setPatternBlockRanges } from '../services/pattern-blocks.js';
import { dayTypeKeyExists } from '../services/day-types.js';
import { writeAudit } from '../lib/audit.js';

const TIME_RE = /^\d{2}:\d{2}$/;

export function patternBlocksRouter() {
  const router = new Router();

  // GET /api/pattern-blocks → { workday: DirectionWindows, weekend: DirectionWindows }
  router.get('/api/pattern-blocks', (ctx) => {
    const owner = currentOwnerId();
    ctx.body = {
      workday: getPatternBlocks(owner, 'workday'),
      weekend: getPatternBlocks(owner, 'weekend'),
    };
  });

  // GET /api/pattern-blocks/:dayType → DirectionWindows for one day type (incl. custom).
  router.get('/api/pattern-blocks/:dayType', (ctx) => {
    ctx.body = { windows: getPatternBlocks(currentOwnerId(), ctx.params.dayType) };
  });

  // PUT /api/pattern-blocks/:dirTagId/:dayType  body: { ranges: [{start_time,end_time}] }
  // Replaces all ranges for that direction+dayType atomically.
  router.put('/api/pattern-blocks/:dirTagId/:dayType', (ctx) => {
    const owner = currentOwnerId();
    const { dirTagId, dayType } = ctx.params;

    const tag = sqlite
      .prepare(`SELECT kind FROM tags WHERE id = ? AND owner_id = ?`)
      .get(dirTagId, owner) as { kind: string } | undefined;
    if (!tag) { ctx.status = 404; ctx.body = { error: 'Tag not found' }; return; }
    if (tag.kind !== 'pattern') { ctx.status = 422; ctx.body = { error: 'Tag is not a pattern' }; return; }
    if (!dayTypeKeyExists(owner, dayType)) { ctx.status = 422; ctx.body = { error: 'Invalid day_type' }; return; }

    const body = ctx.request.body as { ranges?: unknown };
    if (!Array.isArray(body?.ranges)) { ctx.status = 422; ctx.body = { error: 'ranges must be an array' }; return; }

    for (const r of body.ranges as Record<string, unknown>[]) {
      if (!TIME_RE.test(String(r.start_time)) || !TIME_RE.test(String(r.end_time))) {
        ctx.status = 422; ctx.body = { error: 'Times must be HH:MM' }; return;
      }
      if (String(r.start_time) >= String(r.end_time)) {
        ctx.status = 422; ctx.body = { error: 'start_time must be before end_time' }; return;
      }
    }

    const ranges = (body.ranges as { start_time: string; end_time: string }[]);
    setPatternBlockRanges(owner, dirTagId, dayType, ranges);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `pattern-block:${dirTagId}:${dayType}` });
    ctx.body = { ranges: (getPatternBlocks(owner, dayType as 'workday' | 'weekend')[dirTagId] ?? []) };
  });

  return router;
}
