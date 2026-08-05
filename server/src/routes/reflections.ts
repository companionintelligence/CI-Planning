import Router from '@koa/router';
import type Koa from 'koa';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from './sse.js';
import { localISODate, isValidISODate } from '../lib/dates.js';
import { timeSenseEnabled } from '../lib/flags.js';
import { gatherEvening, summarizeEvening } from '../agents/summarize.js';
import {
  getTodayGoal, getWeeklyGoals, getDayNote, getEvening, categoryColorToken, noteDates,
  upsertTodayGoal, upsertWeeklyGoal, upsertDayNote, upsertEvening, saveEveningNarrative,
  toggleDone, deleteGoal,
  type ReflectionRow,
} from '../services/reflections.js';

/**
 * Thin transport over services/reflections.ts (Phase W · W8b, Decision 3). The route owns
 * ONLY request/response shaping, status codes, the time-sense flag gate, and the SSE
 * `broadcast(...)` envelopes; all reads, writes, validation, and `writeAudit` live in the
 * service — the SAME owner-scoped code path GraphQL calls. The route test suite
 * (reflections.test.ts) is unchanged, proving byte-equivalence.
 */

/** GET shape for the today goal (no position — it's the single slot). */
function toTodayDto(row: ReflectionRow, colorToken: string | null) {
  return { body: row.body, category_id: row.category_id, done_at: row.done_at, source_kind: row.source_kind, source_ref: row.source_ref, color_token: colorToken };
}

export function reflectionsRouter() {
  const router = new Router();

  // GET /api/reflections?period=YYYY-MM-DD
  router.get('/api/reflections', async (ctx) => {
    const owner = currentOwnerId();
    const period = (ctx.query.period as string | undefined) ?? localISODate();

    const todayRow = await getTodayGoal(owner, period);
    const weeklyRows = await getWeeklyGoals(owner, period);
    const noteRow = await getDayNote(owner, period);

    const weekly = [];
    for (const r of weeklyRows) {
      weekly.push({
        position: r.position,
        body: r.body,
        category_id: r.category_id,
        done_at: r.done_at,
        source_kind: r.source_kind,
        source_ref: r.source_ref,
        color_token: await categoryColorToken(owner, r.category_id),
      });
    }
    ctx.body = {
      today: todayRow ? toTodayDto(todayRow, await categoryColorToken(owner, todayRow.category_id)) : null,
      weekly,
      note: noteRow ? { body: noteRow.body, updated_at: noteRow.updated_at } : null,
    };
  });

  // GET /api/reflections/notes?from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get('/api/reflections/notes', async (ctx) => {
    const owner = currentOwnerId();
    const from = ctx.query.from as string | undefined;
    const to = ctx.query.to as string | undefined;
    if (!isValidISODate(from) || !isValidISODate(to)) {
      ctx.status = 422;
      ctx.body = { error: 'from and to are required (YYYY-MM-DD)' };
      return;
    }
    ctx.body = { dates: await noteDates(owner, from!, to!) };
  });

  // PUT /api/reflections/note { period_key, body }
  router.put('/api/reflections/note', async (ctx) => {
    const owner = currentOwnerId();
    const { period_key, body } = (ctx.request.body ?? {}) as { period_key?: string; body?: string };
    const res = await upsertDayNote(owner, { period_key, body });
    if (!res.ok) {
      ctx.status = 422;
      ctx.body = { error: 'period_key is required (YYYY-MM-DD)' };
      return;
    }
    broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'day_note', period_key, position: 0 });
    ctx.body = { ok: true };
  });

  // PUT /api/reflections/today { period_key, body, category_id? }
  router.put('/api/reflections/today', async (ctx) => {
    const owner = currentOwnerId();
    const { period_key, body, category_id, source_kind, source_ref } = (ctx.request.body ?? {}) as {
      period_key?: string; body?: string; category_id?: string | null; source_kind?: string; source_ref?: string | null;
    };
    const res = await upsertTodayGoal(owner, { period_key, body, category_id, source_kind, source_ref });
    if (!res.ok) {
      ctx.status = 422;
      ctx.body = { error: 'period_key is required' };
      return;
    }
    broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'today_goal', period_key, position: 0 });
    ctx.body = { ok: true };
  });

  // PUT /api/reflections/weekly/:position { period_key, body, category_id? }
  router.put('/api/reflections/weekly/:position', async (ctx) => {
    const owner = currentOwnerId();
    const position = Number(ctx.params.position);
    const { period_key, body, category_id, source_kind, source_ref } = (ctx.request.body ?? {}) as {
      period_key?: string; body?: string; category_id?: string | null; source_kind?: string; source_ref?: string | null;
    };
    const res = await upsertWeeklyGoal(owner, position, { period_key, body, category_id, source_kind, source_ref });
    if (!res.ok) {
      ctx.status = 422;
      ctx.body = { error: res.error === 'bad_position' ? 'position must be 0, 1, or 2' : 'period_key is required' };
      return;
    }
    broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'weekly_goal', period_key, position });
    ctx.body = { ok: true };
  });

  // ── Phase Z · Z1 (Time-Sense) — EOD Alignment (kind='evening') ──────────────
  // All three routes 404 while the owner's time_sense_enabled flag is off: the feature
  // ships dark, and a disabled feature's endpoints should look absent.
  // Async because the flag read goes through the store facade. Every caller must
  // `await` it: `if (!timeSenseGate(ctx))` on a promise is ALWAYS false, which would turn
  // the 404-when-disabled posture into "the feature is always on".
  const timeSenseGate = async (ctx: Koa.Context): Promise<boolean> => {
    if (await timeSenseEnabled(currentOwnerId())) return true;
    ctx.status = 404;
    ctx.body = { error: 'Not found' };
    return false;
  };

  // GET /api/reflections/evening?period=YYYY-MM-DD — pure read: live payload + authored row.
  router.get('/api/reflections/evening', async (ctx) => {
    if (!(await timeSenseGate(ctx))) return;
    const owner = currentOwnerId();
    const period = (ctx.query.period as string | undefined) ?? localISODate();
    if (!isValidISODate(period)) {
      ctx.status = 422;
      ctx.body = { error: 'period must be YYYY-MM-DD' };
      return;
    }
    const row = await getEvening(owner, period);
    ctx.body = {
      period_key: period,
      row: row ? { body: row.body, created_at: row.created_at, updated_at: row.updated_at } : null,
      payload: await gatherEvening(period),
    };
  });

  // POST /api/reflections/evening/open { period_key, refresh? } — opening the modal IS the
  // authorship act: generate the narrative + persist. Idempotent unless refresh:true.
  router.post('/api/reflections/evening/open', async (ctx) => {
    if (!(await timeSenseGate(ctx))) return;
    const owner = currentOwnerId();
    const { period_key, refresh } = (ctx.request.body ?? {}) as { period_key?: string; refresh?: boolean };
    const period = period_key ?? localISODate();
    if (!isValidISODate(period)) {
      ctx.status = 422;
      ctx.body = { error: 'period_key must be YYYY-MM-DD' };
      return;
    }

    const existing = await getEvening(owner, period);
    if (existing && !refresh) {
      ctx.body = { period_key: period, body: existing.body, llm: null, created: false, payload: await gatherEvening(period) };
      return;
    }

    const summary = await summarizeEvening(period);
    await saveEveningNarrative(owner, period, summary.prose);
    broadcast(owner, 'reflection:updated', { kind: 'evening', period_key: period, position: 0 });
    ctx.body = { period_key: period, body: summary.prose, llm: summary.llm, created: !existing, payload: summary.payload };
  });

  // PUT /api/reflections/evening { period_key, body } — the user's own edits over the
  // narrative. Empty body = delete.
  router.put('/api/reflections/evening', async (ctx) => {
    if (!(await timeSenseGate(ctx))) return;
    const owner = currentOwnerId();
    const { period_key, body } = (ctx.request.body ?? {}) as { period_key?: string; body?: string };
    const res = await upsertEvening(owner, { period_key, body });
    if (!res.ok) {
      ctx.status = 422;
      ctx.body = { error: 'period_key is required (YYYY-MM-DD)' };
      return;
    }
    broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'evening', period_key, position: 0 });
    ctx.body = { ok: true };
  });

  // POST /api/reflections/:kind/:position/done { period_key, done }
  router.post('/api/reflections/:kind/:position/done', async (ctx) => {
    const owner = currentOwnerId();
    const kind = ctx.params.kind;
    const position = Number(ctx.params.position);
    const { period_key, done } = (ctx.request.body ?? {}) as { period_key?: string; done?: boolean };

    const res = await toggleDone(owner, kind, position, { period_key, done });
    if (!res.ok) {
      if (res.error === 'not_found') {
        ctx.status = 404;
        ctx.body = { error: 'reflection not found' };
        return;
      }
      ctx.status = 422;
      ctx.body = {
        error: res.error === 'bad_kind' ? 'kind must be today_goal or weekly_goal'
          : res.error === 'bad_position' ? 'invalid position for kind'
            : 'period_key is required',
      };
      return;
    }
    broadcast(owner, 'reflection:updated', { kind, period_key, position });
    ctx.body = { ok: true };
  });

  // DELETE /api/reflections/:kind/:position?period_key=…
  router.delete('/api/reflections/:kind/:position', async (ctx) => {
    const owner = currentOwnerId();
    const kind = ctx.params.kind;
    const period_key = ctx.query.period_key as string | undefined;
    const position = Number(ctx.params.position);

    const res = await deleteGoal(owner, kind, position, period_key);
    if (!res.ok) {
      ctx.status = 422;
      ctx.body = { error: res.error === 'bad_kind' ? 'invalid kind' : 'period_key query param is required' };
      return;
    }
    broadcast(owner, 'reflection:deleted', { kind, period_key, position });
    ctx.body = { ok: true };
  });

  return router;
}
