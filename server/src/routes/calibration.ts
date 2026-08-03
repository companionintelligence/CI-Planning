import Router from '@koa/router';
import type Koa from 'koa';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { timeSenseEnabled } from '../lib/flags.js';
import { writeAudit } from '../lib/audit.js';
import { comboRef, detectComboSuggestions, suggestEstimate } from '../services/calibration.js';
import { renderCopy } from '../agents/render-copy.js';
import { calibrateEstimates } from '../jobs/calibrate-estimates.js';

/**
 * Phase Z · Z0 (Time-Sense) — the scoped-calibration read surface + combo-pin
 * confirmations. Every route 404s while the owner's time_sense_enabled flag is
 * off: the feature ships dark, and a disabled feature's endpoints should look
 * absent, not broken.
 *
 * Pins are the "accept" half of the §2.3 hybrid: the system only SUGGESTS
 * divergent tag combos (GET .../suggestions is computed on demand, stored
 * nowhere); a POSTed pin is the explicit human confirmation that persists, and
 * only pinned refs get a tag_combo calibration row.
 */
export function calibrationRouter() {
  const router = new Router({ prefix: '/api/calibration' });

  // Per-route gate (NOT router.use — @koa/router use-middleware doesn't fire on
  // the bare prefix path, which would leave GET /api/calibration ungated).
  // Async because the flag read goes through the store facade. Every caller must
  // `await` it: `if (!gate(ctx))` on a promise is ALWAYS false, which would turn
  // the 404-when-disabled posture into "the feature is always on".
  const gate = async (ctx: Koa.Context): Promise<boolean> => {
    if (await timeSenseEnabled(currentOwnerId())) return true;
    ctx.status = 404;
    ctx.body = { error: 'Not found' };
    return false;
  };

  // GET /api/calibration/scopes — all scoped rows + current (unpinned) combo
  // suggestions. (Bare GET /api/calibration is Phase N's legacy global-row
  // readout in routes/review.ts — ungated, unchanged.)
  router.get('/scopes', async (ctx) => {
    if (!(await gate(ctx))) return;
    const owner = currentOwnerId();
    const rows = await store()
      .prepare(
        `SELECT scope_kind, scope_ref, computed_at, sample_count, bias_ratio, p25, p50, p75
           FROM estimate_calibration WHERE owner_id = ?
          ORDER BY scope_kind, scope_ref`,
      )
      .all(owner);
    const pins = await store()
      .prepare(`SELECT scope_ref, created_at FROM calibration_combo_pins WHERE owner_id = ? ORDER BY scope_ref`)
      .all(owner);
    ctx.body = { rows, pins, suggestions: await detectComboSuggestions(owner) };
  });

  // GET /api/calibration/suggest/:taskId — Z6 suggest-only estimate nudge for one
  // task, or { suggestion: null } when there's nothing worth surfacing. The numbers
  // come from suggestEstimate(), which is still a PURE READ — it goes through the store
  // facade now, so it is async, but it writes nothing. Z7 renders the chip's LINE through
  // the Voice loop here, so the nudge shares the one voice and its phrasing doesn't repeat.
  router.get('/suggest/:taskId', async (ctx) => {
    if (!(await gate(ctx))) return;
    const owner = currentOwnerId();
    const suggestion = await suggestEstimate(owner, ctx.params.taskId);
    if (!suggestion) { ctx.body = { suggestion: null }; return; }
    const copy = await renderCopy('calibration_chip', {
      suggested: suggestion.suggested_minutes,
      current: suggestion.current_minutes,
      direction: suggestion.delta_minutes > 0 ? 'over' : 'under',
      scope: suggestion.scope_label,
    });
    ctx.body = { suggestion: { ...suggestion, message: copy.text } };
  });

  // POST /api/calibration/pins { tag_ids: string[] } — confirm a combo suggestion.
  router.post('/pins', async (ctx) => {
    if (!(await gate(ctx))) return;
    const owner = currentOwnerId();
    const { tag_ids } = (ctx.request.body ?? {}) as { tag_ids?: unknown };
    if (!Array.isArray(tag_ids) || tag_ids.length < 2 || !tag_ids.every((t) => typeof t === 'string' && t)) {
      ctx.status = 422;
      ctx.body = { error: 'tag_ids must be 2+ tag ids' };
      return;
    }
    const owned = await store()
      .prepare(`SELECT COUNT(*) AS n FROM tags WHERE owner_id = ? AND id IN (${tag_ids.map(() => '?').join(',')})`)
      .get<{ n: number }>(owner, ...tag_ids);
    if (owned?.n !== new Set(tag_ids).size) {
      ctx.status = 422;
      ctx.body = { error: 'unknown tag id' };
      return;
    }

    const scope_ref = comboRef(tag_ids as string[]);
    await store()
      .prepare(`INSERT OR IGNORE INTO calibration_combo_pins (owner_id, scope_ref) VALUES (?, ?)`)
      .run(owner, scope_ref);
    // Recompute immediately so the pinned combo's row exists now, not tonight.
    await calibrateEstimates();
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `calibration_pin:${scope_ref}` });
    ctx.body = { ok: true, scope_ref };
  });

  // DELETE /api/calibration/pins/:scopeRef — unpin; the combo's row goes with it
  // (an unpinned combo must stop biasing immediately, not at the next nightly).
  router.delete('/pins/:scopeRef', async (ctx) => {
    if (!(await gate(ctx))) return;
    const owner = currentOwnerId();
    const scopeRef = ctx.params.scopeRef;
    const res = await store()
      .prepare(`DELETE FROM calibration_combo_pins WHERE owner_id = ? AND scope_ref = ?`)
      .run(owner, scopeRef);
    await store()
      .prepare(`DELETE FROM estimate_calibration WHERE owner_id = ? AND scope_kind = 'tag_combo' AND scope_ref = ?`)
      .run(owner, scopeRef);
    if (res.changes === 0) {
      ctx.status = 404;
      ctx.body = { error: 'pin not found' };
      return;
    }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `calibration_pin:${scopeRef}` });
    ctx.body = { ok: true };
  });

  return router;
}
