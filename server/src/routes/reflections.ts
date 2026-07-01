import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { broadcast } from './sse.js';
import { isoWeekKey } from '../lib/tz.js';
import { localISODate, isValidISODate } from '../lib/dates.js';

// The two goal kinds the generic /done + DELETE /:kind/:position routes accept.
// day_note is deliberately NOT here: it toggles no done_at and is only ever
// written/read through the dedicated /note, /notes, and GET routes — routing it
// through the goal endpoints would contradict the "today_goal or weekly_goal"
// contract those routes advertise.
const GOAL_KINDS = new Set(['today_goal', 'weekly_goal']);
const VALID_SOURCE_KINDS = new Set(['manual', 'task', 'objective']);

/**
 * Normalize the optional (source_kind, source_ref) link pair. An unknown/absent
 * kind or a task/objective kind with no ref both collapse to the plain
 * ('manual', null) default — the `body` is always the display source of truth.
 */
function normalizeSource(kind: unknown, ref: unknown): { source_kind: string; source_ref: string | null } {
  const k = typeof kind === 'string' && VALID_SOURCE_KINDS.has(kind) ? kind : 'manual';
  const r = typeof ref === 'string' && ref.trim() ? ref : null;
  if (k === 'manual' || !r) return { source_kind: 'manual', source_ref: null };
  return { source_kind: k, source_ref: r };
}

export function reflectionsRouter() {
  const router = new Router();

  // GET /api/reflections?period=YYYY-MM-DD
  // Returns the today goal and all weekly goals for the given day's ISO week.
  router.get('/api/reflections', (ctx) => {
    const owner = currentOwnerId();
    const period = (ctx.query.period as string | undefined) ?? localISODate();
    const weekKey = isoWeekKey(period);

    const todayRow = sqlite
      .prepare(
        `SELECT r.body, r.category_id, r.done_at, r.source_kind, r.source_ref, cp.color_token
           FROM reflections r
           LEFT JOIN category_prefs cp ON cp.owner_id = r.owner_id AND cp.category_tag_id = r.category_id
          WHERE r.owner_id=? AND r.kind='today_goal' AND r.period_key=? AND r.position=0`,
      )
      .get(owner, period) as { body: string; category_id: string | null; done_at: string | null; source_kind: string; source_ref: string | null; color_token: string | null } | undefined;

    const weeklyRows = sqlite
      .prepare(
        `SELECT r.position, r.body, r.category_id, r.done_at, r.source_kind, r.source_ref, cp.color_token
           FROM reflections r
           LEFT JOIN category_prefs cp ON cp.owner_id = r.owner_id AND cp.category_tag_id = r.category_id
          WHERE r.owner_id=? AND r.kind='weekly_goal' AND r.period_key=? ORDER BY r.position`,
      )
      .all(owner, weekKey) as { position: number; body: string; category_id: string | null; done_at: string | null; source_kind: string; source_ref: string | null; color_token: string | null }[];

    const noteRow = sqlite
      .prepare(
        `SELECT body, updated_at
           FROM reflections
          WHERE owner_id=? AND kind='day_note' AND period_key=? AND position=0`,
      )
      .get(owner, period) as { body: string; updated_at: string } | undefined;

    ctx.body = {
      today: todayRow ?? null,
      weekly: weeklyRows,
      note: noteRow ? { body: noteRow.body, updated_at: noteRow.updated_at } : null,
    };
  });

  // GET /api/reflections/notes?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Returns the local dates in [from, to] that have a (non-empty) day note — the
  // calendar note-dot source. One query backs a whole visible month.
  router.get('/api/reflections/notes', (ctx) => {
    const owner = currentOwnerId();
    const from = ctx.query.from as string | undefined;
    const to = ctx.query.to as string | undefined;
    if (!isValidISODate(from) || !isValidISODate(to)) {
      ctx.status = 422;
      ctx.body = { error: 'from and to are required (YYYY-MM-DD)' };
      return;
    }
    // Only rows with a non-empty body count — guards legacy/manual whitespace-only
    // rows so the calendar never dots a day that has no real note.
    const rows = sqlite
      .prepare(
        `SELECT period_key AS date FROM reflections
          WHERE owner_id=? AND kind='day_note' AND period_key>=? AND period_key<=?
            AND TRIM(body) <> ''
          ORDER BY period_key`,
      )
      .all(owner, from, to) as { date: string }[];
    ctx.body = { dates: rows.map((r) => r.date) };
  });

  // PUT /api/reflections/note { period_key, body }
  // Upserts the single day note (kind='day_note', period_key=YYYY-MM-DD, position 0).
  // Empty body = delete (same rule as goals).
  router.put('/api/reflections/note', (ctx) => {
    const owner = currentOwnerId();
    const { period_key, body } = (ctx.request.body ?? {}) as {
      period_key?: string;
      body?: string;
    };

    // period_key IS the day the note belongs to, so it must be a real date —
    // a malformed key would silently create an unreachable row.
    if (!isValidISODate(period_key)) {
      ctx.status = 422;
      ctx.body = { error: 'period_key is required (YYYY-MM-DD)' };
      return;
    }

    const now = new Date().toISOString();
    const trimmed = (body ?? '').trim();

    if (!trimmed) {
      sqlite
        .prepare(
          `DELETE FROM reflections WHERE owner_id=? AND kind='day_note' AND period_key=? AND position=0`,
        )
        .run(owner, period_key);
      broadcast(owner, 'reflection:deleted', { kind: 'day_note', period_key, position: 0 });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:day_note:${period_key}` });
    } else {
      sqlite
        .prepare(
          `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
           VALUES (?, 'day_note', ?, 0, ?, ?, ?)
           ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
             body=excluded.body, updated_at=excluded.updated_at`,
        )
        .run(owner, period_key, trimmed, now, now);
      broadcast(owner, 'reflection:updated', { kind: 'day_note', period_key, position: 0 });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:day_note:${period_key}` });
    }

    ctx.body = { ok: true };
  });

  // PUT /api/reflections/today { period_key, body, category_id? }
  // Upserts the single today goal. Empty body = delete.
  router.put('/api/reflections/today', (ctx) => {
    const owner = currentOwnerId();
    const { period_key, body, category_id, source_kind, source_ref } = (ctx.request.body ?? {}) as {
      period_key?: string;
      body?: string;
      category_id?: string | null;
      source_kind?: string;
      source_ref?: string | null;
    };

    if (!period_key) {
      ctx.status = 422;
      ctx.body = { error: 'period_key is required' };
      return;
    }

    const now = new Date().toISOString();
    const trimmed = (body ?? '').trim();
    const src = normalizeSource(source_kind, source_ref);

    if (!trimmed) {
      sqlite
        .prepare(
          `DELETE FROM reflections WHERE owner_id=? AND kind='today_goal' AND period_key=? AND position=0`,
        )
        .run(owner, period_key);
      broadcast(owner, 'reflection:deleted', { kind: 'today_goal', period_key, position: 0 });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:today:${period_key}` });
    } else {
      sqlite
        .prepare(
          `INSERT INTO reflections (owner_id, kind, period_key, position, body, category_id, source_kind, source_ref, created_at, updated_at)
           VALUES (?, 'today_goal', ?, 0, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
             body=excluded.body, category_id=excluded.category_id,
             source_kind=excluded.source_kind, source_ref=excluded.source_ref,
             updated_at=excluded.updated_at`,
        )
        .run(owner, period_key, trimmed, category_id ?? null, src.source_kind, src.source_ref, now, now);
      broadcast(owner, 'reflection:updated', { kind: 'today_goal', period_key, position: 0 });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:today:${period_key}` });
    }

    ctx.body = { ok: true };
  });

  // PUT /api/reflections/weekly/:position { period_key, body, category_id? }
  // Upserts one of the three stable weekly goal slots (position 0–2). Empty body = delete.
  router.put('/api/reflections/weekly/:position', (ctx) => {
    const owner = currentOwnerId();
    const position = Number(ctx.params.position);

    if (!Number.isInteger(position) || position < 0 || position > 2) {
      ctx.status = 422;
      ctx.body = { error: 'position must be 0, 1, or 2' };
      return;
    }

    const { period_key, body, category_id, source_kind, source_ref } = (ctx.request.body ?? {}) as {
      period_key?: string;
      body?: string;
      category_id?: string | null;
      source_kind?: string;
      source_ref?: string | null;
    };

    if (!period_key) {
      ctx.status = 422;
      ctx.body = { error: 'period_key is required' };
      return;
    }

    const now = new Date().toISOString();
    const trimmed = (body ?? '').trim();
    const src = normalizeSource(source_kind, source_ref);

    if (!trimmed) {
      sqlite
        .prepare(
          `DELETE FROM reflections WHERE owner_id=? AND kind='weekly_goal' AND period_key=? AND position=?`,
        )
        .run(owner, period_key, position);
      broadcast(owner, 'reflection:deleted', { kind: 'weekly_goal', period_key, position });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:weekly:${period_key}:${position}` });
    } else {
      sqlite
        .prepare(
          `INSERT INTO reflections (owner_id, kind, period_key, position, body, category_id, source_kind, source_ref, created_at, updated_at)
           VALUES (?, 'weekly_goal', ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
             body=excluded.body, category_id=excluded.category_id,
             source_kind=excluded.source_kind, source_ref=excluded.source_ref,
             updated_at=excluded.updated_at`,
        )
        .run(owner, period_key, position, trimmed, category_id ?? null, src.source_kind, src.source_ref, now, now);
      broadcast(owner, 'reflection:updated', { kind: 'weekly_goal', period_key, position });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:weekly:${period_key}:${position}` });
    }

    ctx.body = { ok: true };
  });

  // POST /api/reflections/:kind/:position/done { period_key, done }
  // Toggles the done_at timestamp on a reflection row.
  router.post('/api/reflections/:kind/:position/done', (ctx) => {
    const owner = currentOwnerId();
    const kind = ctx.params.kind;
    const position = Number(ctx.params.position);

    if (!GOAL_KINDS.has(kind)) {
      ctx.status = 422;
      ctx.body = { error: 'kind must be today_goal or weekly_goal' };
      return;
    }
    const maxPos = kind === 'today_goal' ? 0 : 2;
    if (!Number.isInteger(position) || position < 0 || position > maxPos) {
      ctx.status = 422;
      ctx.body = { error: 'invalid position for kind' };
      return;
    }

    const { period_key, done } = (ctx.request.body ?? {}) as { period_key?: string; done?: boolean };

    if (!period_key) {
      ctx.status = 422;
      ctx.body = { error: 'period_key is required' };
      return;
    }

    const now = new Date().toISOString();
    const result = sqlite
      .prepare(
        `UPDATE reflections SET done_at=?, updated_at=?
         WHERE owner_id=? AND kind=? AND period_key=? AND position=?`,
      )
      .run(done ? now : null, now, owner, kind, period_key, position);

    if (result.changes === 0) {
      ctx.status = 404;
      ctx.body = { error: 'reflection not found' };
      return;
    }

    broadcast(owner, 'reflection:updated', { kind, period_key, position });
    writeAudit({ ownerId: owner, actor: 'owner', action: done ? 'done' : 'undone', entity: `reflection:${kind}:${period_key}:${position}` });
    ctx.body = { ok: true };
  });

  // DELETE /api/reflections/:kind/:position?period_key=…
  router.delete('/api/reflections/:kind/:position', (ctx) => {
    const owner = currentOwnerId();
    const kind = ctx.params.kind;
    const period_key = ctx.query.period_key as string | undefined;

    if (!GOAL_KINDS.has(kind)) {
      ctx.status = 422;
      ctx.body = { error: 'invalid kind' };
      return;
    }
    if (!period_key) {
      ctx.status = 422;
      ctx.body = { error: 'period_key query param is required' };
      return;
    }

    const position = Number(ctx.params.position);
    sqlite
      .prepare(
        `DELETE FROM reflections WHERE owner_id=? AND kind=? AND period_key=? AND position=?`,
      )
      .run(owner, kind, period_key, position);

    broadcast(owner, 'reflection:deleted', { kind, period_key, position });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:${kind}:${period_key}:${position}` });
    ctx.body = { ok: true };
  });

  return router;
}
