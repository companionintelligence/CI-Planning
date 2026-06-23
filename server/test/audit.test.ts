import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Phase R1 — Audit foundation smoke tests.
 *
 * Calls each major mutating route and checks that an audit_log row was written
 * with the expected actor/action/entity shape. Does NOT test every variant —
 * one hit per route file is sufficient to verify the hook is wired.
 */

const OWNER = SYSTEM_OWNER;

function auditCount(action: string, entityLike: string): number {
  return (
    sqlite
      .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND entity LIKE ?`)
      .get(action, entityLike) as { c: number }
  ).c;
}

function lastAudit(entityLike: string): { actor: string; action: string; entity: string } | undefined {
  return sqlite
    .prepare(`SELECT actor, action, entity FROM audit_log WHERE entity LIKE ? ORDER BY at DESC LIMIT 1`)
    .get(entityLike) as { actor: string; action: string; entity: string } | undefined;
}

function insertTask(title = 'T'): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id`)
      .get(title, OWNER) as { id: string }
  ).id;
}

function insertBlock(): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, start_at, end_at, owner_id) VALUES (uuid7(), 'B', '2026-01-01T09:00:00Z', '2026-01-01T10:00:00Z', ?) RETURNING id`,
      )
      .get(OWNER) as { id: string }
  ).id;
}

let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  resetDb();
  // Also clear pattern-related tables (not in resetDb base set).
  sqlite.exec(`
    DELETE FROM flight_plan;
    DELETE FROM pattern_tasks;
    DELETE FROM patterns;
    DELETE FROM pattern_types WHERE is_builtin = 0;
    DELETE FROM block_templates;
    DELETE FROM pattern_prefs;
  `);
});

// ── tasks ───────────────────────────────────────────────────────────────────

describe('tasks route', () => {
  it('writes audit row on POST /api/tasks (create)', async () => {
    const before = auditCount('create', 'task:%');
    const { status } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Audit test task' },
    });
    expect(status).toBe(201);
    expect(auditCount('create', 'task:%')).toBe(before + 1);
    const row = lastAudit('task:%');
    expect(row?.actor).toBe('owner');
    expect(row?.action).toBe('create');
  });

  it('writes audit row on PATCH /api/tasks/:id (update)', async () => {
    const id = insertTask('Updatable');
    const before = auditCount('update', `task:${id}`);
    const { status } = await api(srv.url, `/api/tasks/${id}`, {
      method: 'PATCH',
      json: { title: 'Updated' },
    });
    expect(status).toBe(200);
    expect(auditCount('update', `task:${id}`)).toBe(before + 1);
  });

  it('writes audit row on DELETE /api/tasks/:id (soft-delete)', async () => {
    const id = insertTask('To delete');
    await api(srv.url, `/api/tasks/${id}`, { method: 'DELETE' });
    expect(auditCount('delete', `task:${id}`)).toBeGreaterThanOrEqual(1);
    const row = lastAudit(`task:${id}`);
    expect(row?.action).toBe('delete');
  });
});

// ── blocks ──────────────────────────────────────────────────────────────────

describe('blocks route', () => {
  it('writes audit row on POST /api/blocks (create)', async () => {
    const before = auditCount('create', 'block:%');
    const { status } = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Test block', start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T10:00:00Z' },
    });
    expect(status).toBe(201);
    expect(auditCount('create', 'block:%')).toBe(before + 1);
  });

  it('writes audit row on PATCH /api/blocks/:id (update)', async () => {
    // Create a block first via the API so it has a valid id.
    const { body: created } = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Block to patch', start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T10:00:00Z' },
    });
    const blockId = created.block.id;
    const before = auditCount('update', `block:${blockId}`);
    await api(srv.url, `/api/blocks/${blockId}`, {
      method: 'PATCH',
      json: { title: 'Patched block' },
    });
    expect(auditCount('update', `block:${blockId}`)).toBe(before + 1);
  });

  it('writes audit row on DELETE /api/blocks/:id', async () => {
    const { body: created } = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Block to delete', start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T10:00:00Z' },
    });
    const blockId = created.block.id;
    await api(srv.url, `/api/blocks/${blockId}`, { method: 'DELETE' });
    expect(auditCount('delete', `block:${blockId}`)).toBeGreaterThanOrEqual(1);
  });
});

// ── possibles ───────────────────────────────────────────────────────────────

describe('possibles route', () => {
  function insertPossible(): string {
    return (
      sqlite
        .prepare(
          `INSERT INTO possible_tasks (id, raw_title, status, proposed_owner_id) VALUES (uuid7(), 'Possible', 'pending', ?) RETURNING id`,
        )
        .get(OWNER) as { id: string }
    ).id;
  }

  it('writes audit row on POST /api/possible-tasks/:id/promote', async () => {
    const id = insertPossible();
    const { status } = await api(srv.url, `/api/possible-tasks/${id}/promote`, {
      method: 'POST',
      json: {},
    });
    expect(status).toBe(201);
    expect(auditCount('promote', `possible:${id}`)).toBeGreaterThanOrEqual(1);
  });

  it('writes audit row on POST /api/possible-tasks/:id/dismiss', async () => {
    const id = insertPossible();
    await api(srv.url, `/api/possible-tasks/${id}/dismiss`, { method: 'POST', json: {} });
    expect(auditCount('dismiss', `possible:${id}`)).toBeGreaterThanOrEqual(1);
  });
});

// ── tags ────────────────────────────────────────────────────────────────────

describe('tags route', () => {
  it('writes audit row on POST /api/tags (create)', async () => {
    const before = auditCount('create', 'tag:%');
    await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'audit-tag' } });
    expect(auditCount('create', 'tag:%')).toBe(before + 1);
  });

  it('writes audit row on PATCH /api/tags/:id (update)', async () => {
    const { body } = await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'mutable-tag' } });
    const id = body.tag.id;
    await api(srv.url, `/api/tags/${id}`, { method: 'PATCH', json: { muted: true } });
    expect(auditCount('update', `tag:${id}`)).toBeGreaterThanOrEqual(1);
  });
});

// ── prefs ────────────────────────────────────────────────────────────────────

describe('prefs route', () => {
  it('writes audit row on PATCH /api/prefs (update)', async () => {
    const before = auditCount('update', 'prefs:owner');
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { workday_start: '08:00' } });
    expect(auditCount('update', 'prefs:owner')).toBe(before + 1);
    const row = lastAudit('prefs:owner');
    expect(row?.actor).toBe('owner');
    expect(row?.action).toBe('update');
    expect(row?.entity).toBe('prefs:owner');
  });
});

// ── schedule ─────────────────────────────────────────────────────────────────

describe('schedule route', () => {
  it('writes audit row on POST /api/schedule/run', async () => {
    const before = auditCount('run', 'schedule:%');
    await api(srv.url, '/api/schedule/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(auditCount('run', 'schedule:%')).toBe(before + 1);
    const row = lastAudit('schedule:%');
    expect(row?.entity).toBe('schedule:2026-06-22');
  });
});

// ── notifications ─────────────────────────────────────────────────────────────

describe('notifications route', () => {
  it('writes audit row on POST /api/reminders (create)', async () => {
    const taskId = insertTask('Reminder task');
    const before = auditCount('create', 'reminder:%');
    await api(srv.url, '/api/reminders', {
      method: 'POST',
      json: { taskId, fireAt: '2999-01-01T10:00:00.000Z' },
    });
    expect(auditCount('create', 'reminder:%')).toBe(before + 1);
    const row = lastAudit('reminder:%');
    expect(row?.actor).toBe('owner');
    expect(row?.action).toBe('create');
  });

  it('writes audit row on POST /api/reminders/:id/snooze', async () => {
    const taskId = insertTask('Snooze task');
    const { body: created } = await api(srv.url, '/api/reminders', {
      method: 'POST',
      json: { taskId, fireAt: '2999-01-01T10:00:00.000Z' },
    });
    const reminderId = created.reminder.id;
    await api(srv.url, `/api/reminders/${reminderId}/snooze`, { method: 'POST', json: { minutes: 10 } });
    expect(auditCount('snooze', `reminder:${reminderId}`)).toBeGreaterThanOrEqual(1);
  });
});

// ── pattern-prefs ──────────────────────────────────────────────────────────────

describe('pattern-prefs route', () => {
  it('writes audit row on PUT /api/pattern-prefs/:patternTagId (update)', async () => {
    // Need a pattern-kind tag to PUT against.
    const tagId = (
      sqlite
        .prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES (uuid7(), 'test-routine', 'pattern', 0) RETURNING id`)
        .get() as { id: string }
    ).id;
    const before = auditCount('update', `pattern-prefs:${tagId}`);
    await api(srv.url, `/api/pattern-prefs/${tagId}`, {
      method: 'PUT',
      json: { auto_fill: true },
    });
    expect(auditCount('update', `pattern-prefs:${tagId}`)).toBe(before + 1);
  });
});

// ── patterns ──────────────────────────────────────────────────────────────────

describe('patterns route', () => {
  function routineTypeId(): string {
    return (
      sqlite
        .prepare(`SELECT id FROM pattern_types WHERE name = 'Routine' AND owner_id = ?`)
        .get(OWNER) as { id: string }
    ).id;
  }

  it('writes audit row on POST /api/patterns (create)', async () => {
    const typeId = routineTypeId();
    const before = auditCount('create', 'routine:%');
    const { status } = await api(srv.url, '/api/patterns', {
      method: 'POST',
      json: { name: 'My Routine', type_id: typeId },
    });
    expect(status).toBe(201);
    expect(auditCount('create', 'routine:%')).toBe(before + 1);
    const row = lastAudit('routine:%');
    expect(row?.actor).toBe('owner');
    expect(row?.action).toBe('create');
  });

  it('writes audit row on PATCH /api/patterns/:id (update)', async () => {
    const typeId = routineTypeId();
    const { body: created } = await api(srv.url, '/api/patterns', {
      method: 'POST',
      json: { name: 'Patchable Routine', type_id: typeId },
    });
    const patternId = created.pattern.id;
    await api(srv.url, `/api/patterns/${patternId}`, {
      method: 'PATCH',
      json: { name: 'Updated Routine' },
    });
    expect(auditCount('update', `routine:${patternId}`)).toBeGreaterThanOrEqual(1);
  });

  it('writes audit row on DELETE /api/patterns/:id', async () => {
    const typeId = routineTypeId();
    const { body: created } = await api(srv.url, '/api/patterns', {
      method: 'POST',
      json: { name: 'Delete Me', type_id: typeId },
    });
    const patternId = created.pattern.id;
    await api(srv.url, `/api/patterns/${patternId}`, { method: 'DELETE' });
    expect(auditCount('delete', `routine:${patternId}`)).toBeGreaterThanOrEqual(1);
  });
});

// ── flight-plan ───────────────────────────────────────────────────────────────

describe('flight-plan route', () => {
  it('writes audit row on POST /api/flight-plan (stage)', async () => {
    const taskId = insertTask('Flight plan task');
    const before = auditCount('stage', 'flight-plan:%');
    const { status } = await api(srv.url, '/api/flight-plan', {
      method: 'POST',
      json: { task_id: taskId },
    });
    expect(status).toBe(201);
    expect(auditCount('stage', 'flight-plan:%')).toBe(before + 1);
  });

  it('writes audit row on POST /api/flight-plan/reset', async () => {
    const before = auditCount('reset', 'flight-plan:reset');
    await api(srv.url, '/api/flight-plan/reset', { method: 'POST', json: {} });
    expect(auditCount('reset', 'flight-plan:reset')).toBe(before + 1);
  });
});

// ── block-templates ───────────────────────────────────────────────────────────

describe('block-templates route', () => {
  it('writes audit row on POST /api/block-templates (create)', async () => {
    const before = auditCount('create', 'block-template:%');
    const { status } = await api(srv.url, '/api/block-templates', {
      method: 'POST',
      json: { name: 'Morning Plan', default_minutes: 90 },
    });
    expect(status).toBe(201);
    expect(auditCount('create', 'block-template:%')).toBe(before + 1);
    const row = lastAudit('block-template:%');
    expect(row?.actor).toBe('owner');
    expect(row?.action).toBe('create');
  });

  it('writes audit row on DELETE /api/block-templates/:id', async () => {
    const { body: created } = await api(srv.url, '/api/block-templates', {
      method: 'POST',
      json: { name: 'Delete Me Template', default_minutes: 30 },
    });
    const templateId = created.block_template.id;
    await api(srv.url, `/api/block-templates/${templateId}`, { method: 'DELETE' });
    expect(auditCount('delete', `block-template:${templateId}`)).toBeGreaterThanOrEqual(1);
  });
});

// ── actor is always 'owner' for request-driven mutations ──────────────────────

describe('audit actor', () => {
  it('all request-driven audit rows have actor = owner', async () => {
    await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Actor check task' },
    });
    const rows = sqlite
      .prepare(`SELECT DISTINCT actor FROM audit_log`)
      .all() as { actor: string }[];
    // Only 'owner' rows — no 'system' without a cron run.
    for (const r of rows) {
      expect(r.actor).toBe('owner');
    }
  });
});
