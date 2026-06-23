import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { getPatternPrefs, setPatternPref } from '../services/pattern-prefs.js';
import { writeAudit } from '../lib/audit.js';

export function patternPrefsRouter() {
  const router = new Router();

  // GET /api/pattern-prefs → { prefs: Record<string, { auto_fill: boolean, reminder_offsets: number[] }> }
  router.get('/api/pattern-prefs', (ctx) => {
    const owner = currentOwnerId();
    ctx.body = { prefs: getPatternPrefs(owner) };
  });

  // PUT /api/pattern-prefs/:patternTagId  body: { auto_fill?: boolean, reminder_offsets?: number[] }
  // Validates tag existence and kind, then upserts.
  router.put('/api/pattern-prefs/:patternTagId', (ctx) => {
    const owner = currentOwnerId();
    const { patternTagId } = ctx.params;

    const tag = sqlite
      .prepare(`SELECT kind FROM tags WHERE id = ?`)
      .get(patternTagId) as { kind: string } | undefined;
    if (!tag) { ctx.status = 404; ctx.body = { error: 'Tag not found' }; return; }
    if (tag.kind !== 'pattern') { ctx.status = 422; ctx.body = { error: 'Tag is not a pattern' }; return; }

    const body = (ctx.request.body ?? {}) as {
      auto_fill?: unknown;
      reminder_offsets?: unknown;
      icon_shape?: unknown;
      color_token?: unknown;
      default_minutes?: unknown;
    };

    if (body.auto_fill !== undefined && typeof body.auto_fill !== 'boolean') {
      ctx.status = 422; ctx.body = { error: 'auto_fill must be a boolean' }; return;
    }

    if (body.reminder_offsets !== undefined) {
      if (
        !Array.isArray(body.reminder_offsets) ||
        !(body.reminder_offsets as unknown[]).every(
          (v) => Number.isInteger(v) && (v as number) >= 0
        )
      ) {
        ctx.status = 422;
        ctx.body = { error: 'reminder_offsets must be an array of non-negative integers' };
        return;
      }
    }

    if (body.icon_shape !== undefined && !['circle', 'square', 'triangle'].includes(body.icon_shape as string)) {
      ctx.status = 422; ctx.body = { error: 'icon_shape must be circle, square, or triangle' }; return;
    }

    if (body.color_token !== undefined && (typeof body.color_token !== 'string' || !body.color_token)) {
      ctx.status = 422; ctx.body = { error: 'color_token must be a non-empty string' }; return;
    }

    if (body.default_minutes !== undefined &&
        !(Number.isInteger(body.default_minutes) && (body.default_minutes as number) > 0)) {
      ctx.status = 422; ctx.body = { error: 'default_minutes must be a positive integer' }; return;
    }

    const pref = setPatternPref(owner, patternTagId, {
      auto_fill: body.auto_fill as boolean | undefined,
      reminder_offsets: body.reminder_offsets as number[] | undefined,
      icon_shape: body.icon_shape as string | undefined,
      color_token: body.color_token as string | undefined,
      default_minutes: body.default_minutes as number | undefined,
    });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `pattern-prefs:${patternTagId}` });
    ctx.body = { pref };
  });

  return router;
}
