import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, runWithOwner, SYSTEM_OWNER } from '../src/lib/context.js';
import {
  skipInstance,
  computeStreak,
  resolveTemplateId,
  deleteFutureOpenInstances,
} from '../src/engine/recurrence-ops.js';
import { generateRecurrences } from '../src/engine/recurrence-generate.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Recurrence instance ops (Phase E, PR-3): skip durability (EXDATE), streak
 * counting, future-instance cleanup, and the API surface (recurring create,
 * scope=series vs instance, skip, streak). Ops are tested directly with explicit
 * dates (clock-free); the routes are smoke-tested over HTTP.
 */

const OWNER = SYSTEM_OWNER;
const TZ = 'America/Los_Angeles';

function insertTemplate(o: { rule?: string; subtype?: string; taskTime?: string | null } = {}): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, priority, task_time, subtype,
                            recurrence_rule, recurrence_dtstart)
         VALUES (uuid7(), 'Tpl', 'recurring', ?, 3, ?, ?, ?, '2026-06-01T12:00:00.000Z') RETURNING id`
      )
      .get(OWNER, o.taskTime ?? null, o.subtype ?? 'standard', o.rule ?? 'FREQ=DAILY') as { id: string }
  ).id;
}

function insertInstance(templateId: string, day: string, status = 'open'): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, priority, recurrence_parent_id, occurrence_date, source_kind)
         VALUES (uuid7(), 'Inst', ?, ?, 3, ?, ?, 'recurrence') RETURNING id`
      )
      .get(status, OWNER, templateId, day) as { id: string }
  ).id;
}

const statusOf = (id: string) =>
  (sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string }).status;
const exdatesOf = (id: string): string[] => {
  const r = sqlite.prepare(`SELECT recurrence_exdates AS e FROM tasks WHERE id = ?`).get(id) as { e: string | null };
  return r.e ? (JSON.parse(r.e) as string[]) : [];
};
const countInstances = (tpl: string, status?: string): number =>
  (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks WHERE recurrence_parent_id = ?${status ? ` AND status = '${status}'` : ''}`
      )
      .get(tpl) as { c: number }
  ).c;

beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run(TZ, OWNER);
});

describe('resolveTemplateId', () => {
  it('maps an instance to its template, a template to itself, a normal task to null', async () => {
    const tpl = insertTemplate();
    const inst = insertInstance(tpl, '2026-06-10');
    const normal = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'n', ?, 'open') RETURNING id`).get(OWNER) as { id: string }).id;

    expect(await resolveTemplateId(inst)).toBe(tpl);
    expect(await resolveTemplateId(tpl)).toBe(tpl);
    expect(await resolveTemplateId(normal)).toBeNull();
    expect(await resolveTemplateId('999999')).toBeNull();
  });
});

describe('skipInstance', () => {
  it('marks the instance skipped and adds its day to the template EXDATE', async () => {
    const tpl = insertTemplate();
    const inst = insertInstance(tpl, '2026-06-10');

    const res = await skipInstance(inst);

    expect(res).toMatchObject({ ok: true, templateId: tpl, date: '2026-06-10' });
    expect(statusOf(inst)).toBe('skipped');
    expect(exdatesOf(tpl)).toContain('2026-06-10');
  });

  it('is durable across a regenerate — the skipped day is not re-materialized', async () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY' });
    const inst = insertInstance(tpl, '2026-06-10');
    await skipInstance(inst);

    // Delete the skipped row to isolate EXDATE from the unique-index guard, then
    // regenerate a window that covers 06-10.
    sqlite.prepare(`DELETE FROM tasks WHERE id = ?`).run(inst);
    runWithOwner(OWNER, ALL_SCOPES, () => generateRecurrences({ today: '2026-06-09', horizonDays: 3 }));

    // 06-10 stays excluded by EXDATE; 06-09, 06-11, 06-12 are created.
    const days = sqlite
      .prepare(`SELECT occurrence_date AS d FROM tasks WHERE recurrence_parent_id = ? ORDER BY d`)
      .all(tpl) as { d: string }[];
    expect(days.map((x) => x.d)).toEqual(['2026-06-09', '2026-06-11', '2026-06-12']);
  });

  it('rejects a non-instance (template or normal task) and a missing id', async () => {
    const tpl = insertTemplate();
    expect(await skipInstance(tpl)).toEqual({ ok: false, reason: 'not_instance' });
    expect(await skipInstance('424242')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('computeStreak', () => {
  it('counts consecutive done back from today; today-open is pending and does not break', async () => {
    const tpl = insertTemplate({ subtype: 'habit' });
    insertInstance(tpl, '2026-06-07', 'done');
    insertInstance(tpl, '2026-06-08', 'done');
    insertInstance(tpl, '2026-06-09', 'done');
    insertInstance(tpl, '2026-06-10', 'open'); // today, not done yet

    const s = await computeStreak(tpl, '2026-06-10');
    expect(s?.current).toBe(3);
    expect(s?.recent.map((r) => r.date)).toEqual(['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10']);
  });

  it('a skipped or missed day breaks the streak', async () => {
    const tpl = insertTemplate({ subtype: 'habit' });
    insertInstance(tpl, '2026-06-07', 'done');
    insertInstance(tpl, '2026-06-08', 'skipped');
    insertInstance(tpl, '2026-06-09', 'done');
    insertInstance(tpl, '2026-06-10', 'open');

    expect((await computeStreak(tpl, '2026-06-10'))?.current).toBe(1); // only 06-09 before the 06-08 skip
  });

  it('resolves the template when passed an instance id, and returns null for a non-recurring task', async () => {
    const tpl = insertTemplate({ subtype: 'habit' });
    const inst = insertInstance(tpl, '2026-06-09', 'done');
    insertInstance(tpl, '2026-06-10', 'done');

    expect((await computeStreak(inst, '2026-06-10'))?.current).toBe(2); // via the instance id

    const normal = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'n', ?, 'open') RETURNING id`).get(OWNER) as { id: string }).id;
    expect(await computeStreak(normal, '2026-06-10')).toBeNull();
  });
});

describe('deleteFutureOpenInstances', () => {
  it('drops future open instances, preserves past + completed + skipped', async () => {
    const tpl = insertTemplate();
    insertInstance(tpl, '2026-06-08', 'done'); // past done
    insertInstance(tpl, '2026-06-09', 'skipped'); // past skipped
    insertInstance(tpl, '2026-06-10', 'open'); // today open
    insertInstance(tpl, '2026-06-11', 'open'); // future open
    insertInstance(tpl, '2026-06-12', 'open'); // future open

    const deleted = await deleteFutureOpenInstances(tpl, '2026-06-10');

    expect(deleted).toBe(3); // 06-10, 06-11, 06-12 (>= today, open)
    const remaining = sqlite
      .prepare(`SELECT occurrence_date AS d, status FROM tasks WHERE recurrence_parent_id = ? ORDER BY d`)
      .all(tpl) as { d: string; status: string }[];
    expect(remaining).toEqual([
      { d: '2026-06-08', status: 'done' },
      { d: '2026-06-09', status: 'skipped' },
    ]);
  });
});

describe('routes — recurrence API', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('POST /api/tasks with recurrence_rule creates a template and materializes instances', async () => {
    const { status, body } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Meditate', recurrence_rule: 'FREQ=DAILY', is_habit: true },
    });
    expect(status).toBe(201);
    expect(body.task.status).toBe('recurring');
    expect(body.task.recurrence_rule).toMatch(/FREQ=DAILY/);
    expect(body.generated.created).toBeGreaterThan(0);
    expect(countInstances(body.task.id)).toBeGreaterThan(0);
  });

  it('POST /api/tasks with an invalid recurrence_rule is a 422', async () => {
    const { status } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'bad', recurrence_rule: 'FREQ=HOURLY' },
    });
    expect(status).toBe(422);
  });

  it('POST /api/tasks/:id/skip skips an instance (200) and 400s on a non-instance', async () => {
    const { body } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Stretch', recurrence_rule: 'FREQ=DAILY' },
    });
    const tplId = body.task.id;
    const inst = sqlite
      .prepare(`SELECT id, occurrence_date FROM tasks WHERE recurrence_parent_id = ? ORDER BY occurrence_date LIMIT 1`)
      .get(tplId) as { id: string; occurrence_date: string };

    const ok = await api(srv.url, `/api/tasks/${inst.id}/skip`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(statusOf(inst.id)).toBe('skipped');
    expect(exdatesOf(tplId)).toContain(inst.occurrence_date);

    const bad = await api(srv.url, `/api/tasks/${tplId}/skip`, { method: 'POST' });
    expect(bad.status).toBe(400);
  });

  it('GET /api/tasks/:id/streak returns a streak for recurring, 404 otherwise', async () => {
    const { body } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Run', recurrence_rule: 'FREQ=DAILY', is_habit: true },
    });
    const streak = await api(srv.url, `/api/tasks/${body.task.id}/streak`);
    expect(streak.status).toBe(200);
    expect(streak.body).toHaveProperty('current');
    expect(Array.isArray(streak.body.recent)).toBe(true);

    const normal = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'one-off' } });
    const s2 = await api(srv.url, `/api/tasks/${normal.body.task.id}/streak`);
    expect(s2.status).toBe(404);
  });

  it('PATCH ?scope=series changes the rule + regenerates; scope=instance edits one row', async () => {
    const { body } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Journal', recurrence_rule: 'FREQ=DAILY' },
    });
    const tplId = body.task.id;
    const beforeOpen = countInstances(tplId, 'open');
    expect(beforeOpen).toBeGreaterThan(1);

    const series = await api(srv.url, `/api/tasks/${tplId}?scope=series`, {
      method: 'PATCH',
      json: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' },
    });
    expect(series.status).toBe(200);
    expect(series.body.generated).toBeTruthy();
    expect((sqlite.prepare(`SELECT recurrence_rule r FROM tasks WHERE id = ?`).get(tplId) as { r: string }).r).toMatch(/WEEKLY/);
    expect(countInstances(tplId, 'open')).toBeLessThan(beforeOpen); // weekly < daily over the horizon

    // Instance-scoped edit touches only the one row, not the template.
    const inst = sqlite
      .prepare(`SELECT id FROM tasks WHERE recurrence_parent_id = ? AND status = 'open' ORDER BY occurrence_date LIMIT 1`)
      .get(tplId) as { id: string };
    const ie = await api(srv.url, `/api/tasks/${inst.id}?scope=instance`, {
      method: 'PATCH',
      json: { title: 'Journal (just today)' },
    });
    expect(ie.status).toBe(200);
    expect(ie.body.task.title).toBe('Journal (just today)');
    expect((sqlite.prepare(`SELECT title t FROM tasks WHERE id = ?`).get(tplId) as { t: string }).t).toBe('Journal');
  });
});
