import { describe, it, expect, vi } from 'vitest';
import {
  isLeafObjective,
  visibleLeafTasks,
  planQuickAdd,
  executeQuickAdd,
} from './objectives-quickadd.js';

const localDate = (iso: string) => iso.slice(0, 10); // tests pin dates; no tz math needed

describe('isLeafObjective', () => {
  it('only level "objective" is a leaf', () => {
    expect(isLeafObjective({ level: 'objective' })).toBe(true);
    expect(isLeafObjective({ level: 'project' })).toBe(false);
    expect(isLeafObjective({ level: 'goal' })).toBe(false);
  });
});

describe('visibleLeafTasks', () => {
  const today = '2026-07-11';
  it('keeps open/scheduled tasks, hides cancelled', () => {
    const rows = [
      { status: 'open', completed_at: null },
      { status: 'scheduled', completed_at: null },
      { status: 'cancelled', completed_at: null },
    ];
    expect(visibleLeafTasks(rows, today, localDate).map((r) => r.status)).toEqual([
      'open',
      'scheduled',
    ]);
  });

  it('shows done-today (checked), hides done-before-today and done-without-timestamp', () => {
    const doneToday = { status: 'done', completed_at: '2026-07-11T09:30:00.000Z' };
    const doneYesterday = { status: 'done', completed_at: '2026-07-10T22:00:00.000Z' };
    const doneNoStamp = { status: 'done', completed_at: null };
    expect(visibleLeafTasks([doneToday, doneYesterday, doneNoStamp], today, localDate)).toEqual([
      doneToday,
    ]);
  });

  it('uses the injected local-date conversion (tz-shifted completed_at)', () => {
    // completed_at is 2026-07-10T23:30Z but the owner's local date is the 11th.
    const shifted = { status: 'done', completed_at: '2026-07-10T23:30:00.000Z' };
    const localPlus1 = () => '2026-07-11';
    expect(visibleLeafTasks([shifted], today, localPlus1)).toEqual([shifted]);
  });
});

describe('planQuickAdd', () => {
  it('source_task_id set → subtask plan (parent_id = source task; auto-promotion links)', () => {
    expect(planQuickAdd({ id: 'o1', level: 'objective', source_task_id: 't9' })).toEqual({
      kind: 'subtask',
      parentTaskId: 't9',
    });
  });

  it('no source_task_id → create-then-link plan', () => {
    expect(planQuickAdd({ id: 'o1', level: 'objective', source_task_id: null })).toEqual({
      kind: 'create-then-link',
      objectiveId: 'o1',
    });
    expect(planQuickAdd({ id: 'o2', level: 'objective' })).toEqual({
      kind: 'create-then-link',
      objectiveId: 'o2',
    });
  });

  it('throws on non-leaf objectives (UI must hide the affordance)', () => {
    expect(() => planQuickAdd({ id: 'o1', level: 'project' })).toThrow(/leaf/);
    expect(() => planQuickAdd({ id: 'o1', level: 'goal' })).toThrow(/leaf/);
  });
});

describe('executeQuickAdd', () => {
  it('subtask branch: creates with parent_id and never calls linkTask', async () => {
    const createTask = vi.fn().mockResolvedValue({ task: { id: 'new1' } });
    const linkTask = vi.fn();
    const res = await executeQuickAdd(
      { id: 'o1', level: 'objective', source_task_id: 'parent-task' },
      '  Buy sandpaper  ',
      { createTask, linkTask },
    );
    expect(res).toEqual({ taskId: 'new1' });
    expect(createTask).toHaveBeenCalledWith({ title: 'Buy sandpaper', parent_id: 'parent-task' });
    expect(linkTask).not.toHaveBeenCalled();
  });

  it('create-then-link branch: creates bare task THEN links to the objective', async () => {
    const calls: string[] = [];
    const createTask = vi.fn().mockImplementation(async () => {
      calls.push('create');
      return { task: { id: 'new2' } };
    });
    const linkTask = vi.fn().mockImplementation(async () => {
      calls.push('link');
      return { ok: true };
    });
    const res = await executeQuickAdd({ id: 'obj-7', level: 'objective' }, 'Write intro', {
      createTask,
      linkTask,
    });
    expect(res).toEqual({ taskId: 'new2' });
    expect(createTask).toHaveBeenCalledWith({ title: 'Write intro' });
    expect(linkTask).toHaveBeenCalledWith('obj-7', 'new2');
    expect(calls).toEqual(['create', 'link']); // strict sequencing: link needs the created id
  });

  it('rejects empty / whitespace-only titles without calling the API', async () => {
    const createTask = vi.fn();
    const linkTask = vi.fn();
    await expect(
      executeQuickAdd({ id: 'o1', level: 'objective' }, '   ', { createTask, linkTask }),
    ).rejects.toThrow(/title/i);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('propagates a linkTask failure (e.g. non_leaf 422) after the task was created', async () => {
    const createTask = vi.fn().mockResolvedValue({ task: { id: 'new3' } });
    const linkTask = vi.fn().mockRejectedValue(new Error('tasks can only be linked to a leaf objective, not a project or goal'));
    await expect(
      executeQuickAdd({ id: 'o1', level: 'objective' }, 'X', { createTask, linkTask }),
    ).rejects.toThrow(/leaf objective/);
    expect(createTask).toHaveBeenCalledOnce();
  });
});
