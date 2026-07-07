import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { resetRoutineTasks } from '../src/jobs/reset-routines.js';
import { resetDb } from './helpers.js';

/**
 * Routine tasks are a repeatable checklist — never archived on completion; the midnight
 * `reset_routines` job flips completed routine members back to open. Covers: only members
 * of a Routine-type pattern reset; non-routine done tasks and members of other pattern
 * types (Habit/Ritual) are left alone; owner isolation.
 */
const OWNER = SYSTEM_OWNER;
const run = <T,>(fn: () => T) => runWithOwner(OWNER, ALL_SCOPES, fn);

function patternType(name: string, owner = OWNER): string {
  const existing = sqlite.prepare(`SELECT id FROM pattern_types WHERE owner_id = ? AND name = ? LIMIT 1`).get(owner, name) as { id: string } | undefined;
  if (existing) return existing.id;
  return (sqlite
    .prepare(`INSERT INTO pattern_types (id, owner_id, name, icon_shape, is_builtin) VALUES (uuid7(), ?, ?, 'circle', 1) RETURNING id`)
    .get(owner, name) as { id: string }).id;
}

function pattern(typeId: string, name: string, owner = OWNER): string {
  return (sqlite
    .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(owner, typeId, name) as { id: string }).id;
}

function doneTask(title: string, owner = OWNER): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, completed_at) VALUES (uuid7(), ?, ?, 'done', '2026-01-01T12:00:00.000Z') RETURNING id`)
    .get(title, owner) as { id: string }).id;
}

function addMember(patternId: string, taskId: string): void {
  sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id) VALUES (?, ?)`).run(patternId, taskId);
}

const taskRow = (id: string) =>
  sqlite.prepare(`SELECT status, completed_at FROM tasks WHERE id = ?`).get(id) as { status: string; completed_at: string | null };

beforeEach(() => resetDb());

describe('resetRoutineTasks', () => {
  it('flips a completed Routine member back to open and clears completed_at', () => {
    const p = pattern(patternType('Routine'), 'Morning');
    const task = doneTask('Make the bed');
    addMember(p, task);

    const r = run(() => resetRoutineTasks());
    expect(r.reset).toBe(1);
    expect(taskRow(task)).toEqual({ status: 'open', completed_at: null });
  });

  it('leaves a completed NON-routine task untouched (it archives normally)', () => {
    const loose = doneTask('One-off done task'); // no pattern membership
    run(() => resetRoutineTasks());
    expect(taskRow(loose).status).toBe('done');
  });

  it('does not reset members of a non-Routine pattern (Habit/Ritual keep their lifecycle)', () => {
    const p = pattern(patternType('Habit'), 'Meditate');
    const task = doneTask('Meditate 10m');
    addMember(p, task);

    const r = run(() => resetRoutineTasks());
    expect(r.reset).toBe(0);
    expect(taskRow(task).status).toBe('done');
  });

  it('is owner-scoped — another owner’s completed routine task is not reset', () => {
    const other = 'owner-other-reset';
    sqlite.prepare(`INSERT OR IGNORE INTO owners (id, name) VALUES (?, 'Other')`).run(other);
    const p = pattern(patternType('Routine', other), 'Their routine', other);
    const task = doneTask('Their task', other);
    addMember(p, task);

    run(() => resetRoutineTasks()); // runs as OWNER
    expect(taskRow(task).status).toBe('done'); // untouched — different owner
  });
});
