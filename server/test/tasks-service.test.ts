import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  createTask,
  createRecurringTask,
  updateTask,
  recallTask,
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

    stampTaskCompletionReflection(OWNER, task.task.id, '2026-07-03T12:00:00.000Z');
    const first = (sqlite
      .prepare(`SELECT done_at FROM reflections WHERE owner_id = ? AND kind = 'today_goal' AND period_key = '2026-07-03'`)
      .get(OWNER) as { done_at: string | null }).done_at;
    expect(first).toBeTruthy();

    stampTaskCompletionReflection(OWNER, task.task.id, '2026-07-03T18:00:00.000Z');
    const second = (sqlite
      .prepare(`SELECT done_at FROM reflections WHERE owner_id = ? AND kind = 'today_goal' AND period_key = '2026-07-03'`)
      .get(OWNER) as { done_at: string | null }).done_at;
    expect(second).toBe(first);
  });
});
