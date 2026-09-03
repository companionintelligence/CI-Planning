import { describe, it, expect, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  createTask,
  createRecurringTask,
  updateTask,
  deleteTask,
  promoteToHabit,
  recallTask,
  skipRecurringInstance,
  stampTaskCompletionReflection,
} from '../src/services/tasks.js';
import { resetDb, createOwner, SECOND_OWNER_ID } from './helpers.js';

/**
 * Phase W step 3.1 — direct service-level tests for services/tasks.ts.
 *
 * The REST route tests remain the behavioral lock (these handlers went through
 * them unchanged); this file only pins the service *contract* the coming GraphQL
 * resolvers will consume: discriminated result shapes, the dependency-cycle
 * mapping, and the recall clone transaction.
 */

const OWNER = SYSTEM_OWNER;

beforeEach(() => {
  resetDb();
});

/** Narrow an `ok` result or fail the test — keeps the assertions type-safe. */
function unwrap<T extends { ok: boolean }>(res: T): Extract<T, { ok: true }> {
  expect(res.ok).toBe(true);
  return res as Extract<T, { ok: true }>;
}

/** Insert a bare task row directly (bypassing the service) under an explicit owner. */
function insertTask(ownerId: string, title: string): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id`)
    .get(title, ownerId) as { id: string }).id;
}

/** Insert a recurring template + one materialized instance under an explicit owner. */
function insertRecurringInstance(ownerId: string, date = '2026-07-03'): { templateId: string; instanceId: string } {
  const templateId = (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, recurrence_rule) VALUES (uuid7(), 'tpl', ?, 'recurring', 'FREQ=DAILY') RETURNING id`,
    )
    .get(ownerId) as { id: string }).id;
  const instanceId = (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, recurrence_parent_id, occurrence_date) VALUES (uuid7(), 'inst', ?, 'open', ?, ?) RETURNING id`,
    )
    .get(ownerId, templateId, date) as { id: string }).id;
  return { templateId, instanceId };
}

describe('createTask', () => {
  it('returns the inserted drizzle row (camelCase, defaults applied) and writes tags + audit', async () => {
    const res = unwrap(await createTask(OWNER, { title: '  Service create  ', tags: ['svc-tag'] }));
    expect(res.task.title).toBe('Service create');
    expect(res.task.priority).toBe(3);
    expect(res.task.status).toBe('open');
    expect(res.task.ownerId).toBe(OWNER);

    const tagNames = (sqlite
      .prepare(
        `SELECT t.name FROM tags t JOIN entity_tags et ON et.tag_id = t.id
          WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1`,
      )
      .all(res.task.id) as { name: string }[]).map((r) => r.name);
    expect(tagNames).toEqual(['svc-tag']);

    await flushAudits();
    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'create' AND entity = ?`)
      .get(`task:${res.task.id}`) as { n: number };
    expect(audit.n).toBe(1); // audit lives IN the service now — exactly one row per op
  });

  it('rejects a blank title', async () => {
    expect(await createTask(OWNER, { title: '   ' })).toEqual({ ok: false, error: 'title_required' });
  });
});

describe('createRecurringTask', () => {
  it('rejects an invalid rule with the parser message', async () => {
    const res = await createRecurringTask(OWNER, { title: 'Bad rule', recurrence_rule: 'not a rule' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('invalid_rule');
    expect((res as { message: string }).message).toBeTruthy();
  });

  it('creates a template and materializes its instances', async () => {
    const res = unwrap(await createRecurringTask(OWNER, { title: 'Daily thing', recurrence_rule: 'FREQ=DAILY' }));
    expect(res.template.status).toBe('recurring');
    expect(res.template.recurrenceRule).toContain('FREQ=DAILY');
    expect(res.generated.created).toBeGreaterThan(0);
    const instances = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE recurrence_parent_id = ?`)
      .get(res.template.id) as { n: number };
    expect(instances.n).toBe(res.generated.created);
  });
});

describe('updateTask — dependency cycle', () => {
  it('maps DependencyCycleError to a discriminated error carrying the stamp info', async () => {
    const a = unwrap(await createTask(OWNER, { title: 'A' }));
    const b = unwrap(await createTask(OWNER, { title: 'B', depends_on: [a.task.id] }));

    const res = await updateTask(OWNER, a.task.id, { title: 'A renamed', depends_on: [b.task.id] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('dependency_cycle');
    if (res.error !== 'dependency_cycle') return;
    // Pre-extraction semantics preserved: the column UPDATE already applied before the
    // dependency change was rejected — targetId/updatedFields let the route stamp it.
    expect(res.targetId).toBe(a.task.id);
    expect(res.updatedFields).toEqual(['title']);
    const row = sqlite.prepare(`SELECT title FROM tasks WHERE id = ?`).get(a.task.id) as { title: string };
    expect(row.title).toBe('A renamed');
    // ...and the cyclic edge was NOT written.
    const edges = sqlite.prepare(`SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ?`).get(a.task.id) as { n: number };
    expect(edges.n).toBe(0);
  });
});

describe('recallTask', () => {
  it('clones the subtree atomically: fresh ids, open status, tags carried', async () => {
    const parent = unwrap(await createTask(OWNER, { title: 'Recall me', tags: ['carried'] }));
    unwrap(await createTask(OWNER, { title: 'Sub step', parent_id: parent.task.id }));

    const res = unwrap(await recallTask(OWNER, parent.task.id));
    expect(res.task.id).not.toBe(parent.task.id);
    expect(res.task.status).toBe('open');
    expect(res.task.parentId).toBeNull();

    const kids = sqlite
      .prepare(`SELECT title, status FROM tasks WHERE parent_id = ?`)
      .all(res.task.id) as { title: string; status: string }[];
    expect(kids).toEqual([{ title: 'Sub step', status: 'open' }]);

    const tagNames = (sqlite
      .prepare(
        `SELECT t.name FROM tags t JOIN entity_tags et ON et.tag_id = t.id
          WHERE et.entity_kind = 'task' AND et.entity_id = ?`,
      )
      .all(res.task.id) as { name: string }[]).map((r) => r.name);
    expect(tagNames).toEqual(['carried']);
  });

  it("is owner-scoped: another owner's task recalls as not_found", async () => {
    createOwner();
    const foreignId = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'Foreign', ?, 'open') RETURNING id`)
      .get(SECOND_OWNER_ID) as { id: string }).id;
    expect(await recallTask(OWNER, foreignId)).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('stampTaskCompletionReflection', () => {
  it('stamps the linked today-intention once; COALESCE preserves an earlier done_at', async () => {
    const task = unwrap(await createTask(OWNER, { title: 'Focus task' }));
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO reflections (owner_id, kind, period_key, position, body, source_kind, source_ref, created_at, updated_at)
         VALUES (?, 'today_goal', '2026-07-03', 0, 'do the thing', 'task', ?, ?, ?)`,
      )
      .run(OWNER, task.task.id, now, now);

    await stampTaskCompletionReflection(OWNER, task.task.id, '2026-07-03T12:00:00.000Z');
    const first = (sqlite
      .prepare(`SELECT done_at FROM reflections WHERE owner_id = ? AND kind = 'today_goal' AND period_key = '2026-07-03'`)
      .get(OWNER) as { done_at: string | null }).done_at;
    expect(first).toBeTruthy();

    await stampTaskCompletionReflection(OWNER, task.task.id, '2026-07-03T18:00:00.000Z');
    const second = (sqlite
      .prepare(`SELECT done_at FROM reflections WHERE owner_id = ? AND kind = 'today_goal' AND period_key = '2026-07-03'`)
      .get(OWNER) as { done_at: string | null }).done_at;
    expect(second).toBe(first);
  });
});

/**
 * W3.1a — cross-owner IDOR regression. Before this fix `updateTask` / `deleteTask` /
 * `promoteToHabit` mutated by id ALONE, and `skipRecurringInstance` delegated to an
 * engine that keys by id alone — so any authenticated owner could PATCH / cancel /
 * promote / skip another owner's task by guessing (or leaking) its id. The route
 * suites all run as the single SYSTEM_OWNER and never exercised a second owner, so
 * these service-level tests are the lock: a foreign id must 404 with NO mutation.
 * (See docs/W-step3-extraction-audit.md §"Owner-scoping finding".)
 */
describe('owner-scoping (W3.1a) — a cross-owner id is rejected with no mutation', () => {
  it('updateTask: 404s and leaves the foreign task untouched', async () => {
    createOwner();
    const foreignId = insertTask(SECOND_OWNER_ID, 'Foreign update');
    expect(await updateTask(OWNER, foreignId, { title: 'Hijacked', priority: 1 })).toEqual({
      ok: false,
      error: 'not_found',
    });
    const row = sqlite.prepare(`SELECT title, priority FROM tasks WHERE id = ?`).get(foreignId) as {
      title: string;
      priority: number;
    };
    expect(row).toEqual({ title: 'Foreign update', priority: 3 }); // unchanged (default priority)
  });

  it('updateTask (tags-only PATCH): 404s before touching the foreign task’s tags', async () => {
    createOwner();
    const foreignId = insertTask(SECOND_OWNER_ID, 'Foreign tags');
    // A tags-only PATCH has no column changes → hits the SELECT branch, which is also scoped.
    expect(await updateTask(OWNER, foreignId, { tags: ['hijack-tag'] })).toEqual({ ok: false, error: 'not_found' });
    const tagCount = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ?`)
      .get(foreignId) as { n: number };
    expect(tagCount.n).toBe(0);
  });

  it('deleteTask: 404s and leaves the foreign task open (not cancelled)', async () => {
    createOwner();
    const foreignId = insertTask(SECOND_OWNER_ID, 'Foreign delete');
    expect(await deleteTask(OWNER, foreignId)).toEqual({ ok: false, error: 'not_found' });
    const row = sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(foreignId) as { status: string };
    expect(row.status).toBe('open');
  });

  it('promoteToHabit: 404s and leaves the foreign task standard (no habit pattern)', async () => {
    createOwner();
    const foreignId = insertTask(SECOND_OWNER_ID, 'Foreign promote');
    expect(await promoteToHabit(OWNER, foreignId)).toEqual({ ok: false, error: 'not_found' });
    const row = sqlite.prepare(`SELECT subtype FROM tasks WHERE id = ?`).get(foreignId) as { subtype: string | null };
    expect(row.subtype).toBe('standard');
    const pat = sqlite.prepare(`SELECT COUNT(*) AS n FROM pattern_tasks WHERE task_id = ?`).get(foreignId) as { n: number };
    expect(pat.n).toBe(0);
  });

  it('skipRecurringInstance: 404s, leaves the foreign instance open and its template EXDATE-free', async () => {
    createOwner();
    const { templateId, instanceId } = insertRecurringInstance(SECOND_OWNER_ID);
    expect(await skipRecurringInstance(OWNER, instanceId)).toEqual({ ok: false, error: 'not_found' });
    const inst = sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(instanceId) as { status: string };
    expect(inst.status).toBe('open');
    const tpl = sqlite.prepare(`SELECT recurrence_exdates FROM tasks WHERE id = ?`).get(templateId) as {
      recurrence_exdates: string | null;
    };
    expect(tpl.recurrence_exdates).toBeNull();
  });

  it('skipRecurringInstance: the legit-owner path still skips + records the EXDATE', async () => {
    // Proves the new ownership pre-check doesn't regress the happy path.
    const { templateId, instanceId } = insertRecurringInstance(OWNER);
    const res = unwrap(await skipRecurringInstance(OWNER, instanceId));
    expect(res.skipped).toBe('2026-07-03');
    const inst = sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(instanceId) as { status: string };
    expect(inst.status).toBe('skipped');
    const tpl = sqlite.prepare(`SELECT recurrence_exdates FROM tasks WHERE id = ?`).get(templateId) as {
      recurrence_exdates: string | null;
    };
    expect(JSON.parse(tpl.recurrence_exdates ?? '[]')).toContain('2026-07-03');
  });
});

/**
 * Cancelling is the app's soft delete, and it has to settle EVERY surface the task was
 * on. The flight plan was the one it did not: `listFlightPlan` joins tasks without
 * filtering status, so a cancelled task left staged kept presenting itself as work
 * waiting to be scheduled — the single place it must not reappear, since cancelling is
 * the owner saying they are not going to do it.
 */
describe('deleteTask — the task leaves every surface, including the flight plan', () => {
  beforeEach(() => resetDb());

  // source_kind is NOT NULL in the DB without a usable default, so it is spelled out —
  // omitting it makes the INSERT OR IGNORE silently no-op rather than stage anything.
  const stage = (taskId: string, owner: string = OWNER) =>
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO flight_plan (owner_id, task_id, source_kind, selected, position)
         VALUES (?, ?, 'manual', 1, 0)`,
      )
      .run(owner, taskId);
  const staged = (taskId: string) =>
    !!sqlite.prepare(`SELECT 1 FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(OWNER, taskId);

  it('unstages a staged task when it is cancelled', async () => {
    const t = unwrap(await createTask(OWNER, { title: 'give up on this' })).task;
    stage(t.id);
    expect(staged(t.id)).toBe(true);

    const res = await deleteTask(OWNER, t.id);
    expect(res.ok).toBe(true);
    expect(staged(t.id)).toBe(false);
    expect(
      (sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(t.id) as { status: string }).status,
    ).toBe('cancelled');
  });

  it('is fine when the task was never staged', async () => {
    const t = unwrap(await createTask(OWNER, { title: 'never staged' })).task;
    await expect(deleteTask(OWNER, t.id)).resolves.toMatchObject({ ok: true });
    expect(staged(t.id)).toBe(false);
  });

  it('writes the unstage audit row only when something was actually staged', async () => {
    const wasStaged = unwrap(await createTask(OWNER, { title: 'staged' })).task;
    stage(wasStaged.id);
    await deleteTask(OWNER, wasStaged.id);
    const never = unwrap(await createTask(OWNER, { title: 'not staged' })).task;
    await deleteTask(OWNER, never.id);
    await flushAudits();

    const rows = sqlite
      .prepare(`SELECT entity FROM audit_log WHERE owner_id = ? AND action = 'remove' AND entity LIKE 'flight-plan:%'`)
      .all(OWNER) as { entity: string }[];
    expect(rows.map((r) => r.entity)).toEqual([`flight-plan:${wasStaged.id}`]);
  });

  it("does not touch another owner's identically-keyed flight-plan row", async () => {
    // The DELETE is owner-scoped like every other write in this path (W3.1a).
    await createOwner(SECOND_OWNER_ID);
    const t = unwrap(await createTask(OWNER, { title: 'shared id space' })).task;
    stage(t.id);
    stage(t.id, SECOND_OWNER_ID);

    await deleteTask(OWNER, t.id);

    expect(staged(t.id)).toBe(false);
    expect(
      !!sqlite.prepare(`SELECT 1 FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(SECOND_OWNER_ID, t.id),
    ).toBe(true);
  });
});

/**
 * `status: 'done'` has to stamp completed_at the same way the `completed: true`
 * shortcut does.
 *
 * `status` is an accepted PATCH field, so a task could be moved to 'done' with
 * completed_at left null — finished, and simultaneously invisible to every completion
 * count, because `taskMetrics` windows completions on that column. Nothing rejected it
 * and nothing looked broken, which is the worst way for a number to be wrong.
 */
describe('updateTask — a direct status:done stamps completed_at', () => {
  beforeEach(() => resetDb());

  const mk = async (title: string) => unwrap(await createTask(OWNER, { title })).task;
  const read = (id: string) =>
    sqlite.prepare(`SELECT status, completed_at FROM tasks WHERE id = ?`).get(id) as
      { status: string; completed_at: string | null };

  it('stamps completed_at when status is set to done directly', async () => {
    const t = await mk('via status');
    await updateTask(OWNER, t.id, { status: 'done' });
    const row = read(t.id);
    expect(row.status).toBe('done');
    expect(row.completed_at).toBeTruthy();
  });

  it('matches what the `completed: true` shortcut produces', async () => {
    // The two spellings of "this is finished" must not disagree about whether the task
    // is countable — that divergence is the whole bug.
    const viaStatus = await mk('a'); await updateTask(OWNER, viaStatus.id, { status: 'done' });
    const viaFlag = await mk('b'); await updateTask(OWNER, viaFlag.id, { completed: true });
    expect(!!read(viaStatus.id).completed_at).toBe(!!read(viaFlag.id).completed_at);
  });

  it('does not clobber the original completion time when done is re-stated', async () => {
    const t = await mk('re-stated');
    await updateTask(OWNER, t.id, { completed: true });
    const first = read(t.id).completed_at;
    await new Promise((r) => setTimeout(r, 5));
    await updateTask(OWNER, t.id, { status: 'done' });
    expect(read(t.id).completed_at).toBe(first);
  });

  it('lets an explicit completed_at in the same PATCH win', async () => {
    // Import/sync paths set the real completion time deliberately; overwriting it with
    // "now" would silently relocate historical work into the current window.
    const t = await mk('imported');
    await updateTask(OWNER, t.id, { status: 'done', completed_at: '2026-01-02T03:04:05.000Z' });
    expect(read(t.id).completed_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('stamps once when a PATCH carries both completed:true and status:done', async () => {
    const t = await mk('both');
    const res = await updateTask(OWNER, t.id, { completed: true, status: 'done' });
    expect(res.ok).toBe(true);
    expect(read(t.id).completed_at).toBeTruthy();
  });

  it('does not stamp for any other status', async () => {
    for (const status of ['open', 'in_progress', 'cancelled', 'missed']) {
      const t = await mk(`status ${status}`);
      await updateTask(OWNER, t.id, { status });
      expect(read(t.id).completed_at, status).toBeNull();
    }
  });

  it('leaves completed_at alone when a done task is moved to another status', async () => {
    // Deliberately not symmetric: `completed: false` clears it explicitly, but plain
    // `status` writes drive machine transitions (the review sweep revives stuck
    // one-offs), and erasing a real completion time as a side effect of one is worse
    // than a stale timestamp on a reopened task.
    const t = await mk('reopened');
    await updateTask(OWNER, t.id, { completed: true });
    const stamped = read(t.id).completed_at;
    await updateTask(OWNER, t.id, { status: 'open' });
    expect(read(t.id)).toMatchObject({ status: 'open', completed_at: stamped });
  });
});
