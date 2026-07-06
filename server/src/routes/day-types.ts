import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import {
  listDayTypes, createDayTypeChecked, renameDayTypeChecked, deleteDayTypeChecked,
  getWeekMap, setWeekMap, listAssignments, assignDate, clearAssignment,
  dayTypeKeyExists, resolveDayTypeWithSource,
} from '../services/day-types.js';

/** A real 'YYYY-MM-DD' calendar date (rejects shape-valid nonsense like 2026-13-99). */
function isISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Day-types API (T-SCHED-3): the owner's day-type catalog, the recurring weekly
 * default map, and per-date overrides. `resolveDayType()` reads these to pick which
 * pattern_blocks windows Auto places into. Builtins (workday/weekend) are rename-only.
 */
export function dayTypesRouter() {
  const router = new Router();

  // ── Catalog ──────────────────────────────────────────────────────────────
  router.get('/api/day-types', (ctx) => {
    ctx.body = { day_types: listDayTypes(currentOwnerId()) };
  });

  router.post('/api/day-types', (ctx) => {
    const body = ctx.request.body as { key?: unknown; name?: unknown };
    const res = createDayTypeChecked(currentOwnerId(), body?.key, body?.name);
    if (!res.ok) {
      if (res.error === 'bad_key') { ctx.status = 422; ctx.body = { error: 'key must be a lowercase slug' }; return; }
      if (res.error === 'name_required') { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
      ctx.status = 409; ctx.body = { error: 'A day type with that key already exists' }; return;
    }
    ctx.status = 201;
    ctx.body = { day_type: res.dayType };
  });

  router.patch('/api/day-types/:id', (ctx) => {
    const res = renameDayTypeChecked(currentOwnerId(), ctx.params.id, (ctx.request.body as { name?: unknown })?.name);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'Day type not found' }; return; }
      ctx.status = 422; ctx.body = { error: 'name is required' }; return;
    }
    ctx.body = { day_type: res.dayType };
  });

  router.delete('/api/day-types/:id', (ctx) => {
    const res = deleteDayTypeChecked(currentOwnerId(), ctx.params.id);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'Day type not found' }; return; }
      ctx.status = 422; ctx.body = { error: 'Built-in day types cannot be deleted' }; return;
    }
    ctx.body = { ok: true };
  });

  // ── Resolution (what day type applies to a date, and from where) ───────────
  router.get('/api/day-types/resolve/:date', (ctx) => {
    const { date } = ctx.params;
    if (!isISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    ctx.body = { date, ...resolveDayTypeWithSource(currentOwnerId(), date) };
  });

  // ── Weekly default map ───────────────────────────────────────────────────
  router.get('/api/day-types/week-map', (ctx) => {
    ctx.body = { map: getWeekMap(currentOwnerId()) };
  });

  router.put('/api/day-types/week-map', (ctx) => {
    const owner = currentOwnerId();
    const map = (ctx.request.body as { map?: unknown })?.map;
    if (!map || typeof map !== 'object') { ctx.status = 422; ctx.body = { error: 'map must be an object of dow→key' }; return; }
    const entries = Object.entries(map as Record<string, unknown>);
    for (const [dow, key] of entries) {
      if (!/^[0-6]$/.test(dow)) { ctx.status = 422; ctx.body = { error: `Invalid dow: ${dow}` }; return; }
      if (!dayTypeKeyExists(owner, String(key))) { ctx.status = 422; ctx.body = { error: `Unknown day type: ${key}` }; return; }
    }
    setWeekMap(owner, Object.fromEntries(entries.map(([d, k]) => [Number(d), String(k)])));
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: 'day-types:week-map' });
    ctx.body = { map: getWeekMap(owner) };
  });

  // ── Per-date assignments ───────────────────────────────────────────────────
  router.get('/api/day-types/assignments', (ctx) => {
    ctx.body = { assignments: listAssignments(currentOwnerId()) };
  });

  router.put('/api/day-types/assignments/:date', (ctx) => {
    const owner = currentOwnerId();
    const { date } = ctx.params;
    if (!isISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    const key = String((ctx.request.body as { day_type_key?: unknown })?.day_type_key ?? '');
    if (!dayTypeKeyExists(owner, key)) { ctx.status = 422; ctx.body = { error: `Unknown day type: ${key}` }; return; }
    assignDate(owner, date, key);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `day-assignment:${date}` });
    ctx.body = { date, day_type_key: key };
  });

  router.delete('/api/day-types/assignments/:date', (ctx) => {
    const owner = currentOwnerId();
    const { date } = ctx.params;
    if (!isISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    clearAssignment(owner, date);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `day-assignment:${date}` });
    ctx.body = { ok: true };
  });

  return router;
}
