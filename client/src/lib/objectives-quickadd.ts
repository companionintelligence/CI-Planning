/**
 * AF-5 — pure helpers for the Objectives-tab leaf-task list + "+" quick-add.
 *
 * Deliberately Solid-free (no signals, no DOM) so leaf detection, row-visibility
 * filtering and the create-vs-create-then-link sequencing are unit-testable
 * without jsdom. The component (ObjectivesPanel) supplies the API calls as
 * injected deps.
 */

// ── Leaf detection ────────────────────────────────────────────────────────────

/** Only leaf objectives (level 'objective') hold tasks; the server 422s otherwise. */
export function isLeafObjective(o: { level: string }): boolean {
  return o.level === 'objective';
}

// ── Row visibility ────────────────────────────────────────────────────────────

export interface QuickAddTaskRow {
  status: string;
  completed_at: string | null;
}

/**
 * Which linked tasks to render under a leaf: open/scheduled/etc. always;
 * 'done' only when completed today (shown checked, so a just-completed row
 * doesn't vanish under the cursor); 'cancelled' never (the server already
 * filters these — kept here defensively). `completedLocalDate` converts a
 * stored completed_at timestamp to a local YYYY-MM-DD for the comparison.
 */
export function visibleLeafTasks<T extends QuickAddTaskRow>(
  tasks: readonly T[],
  todayISO: string,
  completedLocalDate: (completedAt: string) => string,
): T[] {
  return tasks.filter((t) => {
    if (t.status === 'cancelled') return false;
    if (t.status === 'done') {
      return t.completed_at != null && completedLocalDate(t.completed_at) === todayISO;
    }
    return true;
  });
}

// ── Quick-add sequencing ──────────────────────────────────────────────────────

export interface QuickAddObjective {
  id: string;
  level: string;
  source_task_id?: string | null;
}

/**
 * How a title-only quick-add on a leaf objective must be executed:
 * - `subtask`      — the objective was auto-promoted from a task (`source_task_id`
 *                    set): create the task with `parent_id = source_task_id`; the
 *                    server's task-promotion auto-links it to this objective AND
 *                    it nests under the parent task on the Tasks tab.
 * - `create-then-link` — manually created objective: create the bare task, then
 *                    `POST /objectives/:id/tasks` to link it.
 */
export type QuickAddPlan =
  | { kind: 'subtask'; parentTaskId: string }
  | { kind: 'create-then-link'; objectiveId: string };

export function planQuickAdd(o: QuickAddObjective): QuickAddPlan {
  if (!isLeafObjective(o)) {
    // Guard: callers must never quick-add on a non-leaf (the UI hides the affordance).
    throw new Error('quick-add is only available on leaf objectives');
  }
  return o.source_task_id
    ? { kind: 'subtask', parentTaskId: o.source_task_id }
    : { kind: 'create-then-link', objectiveId: o.id };
}

export interface QuickAddDeps {
  createTask: (input: { title: string; parent_id?: string }) => Promise<{ task: { id: string } }>;
  linkTask: (objectiveId: string, taskId: string) => Promise<unknown>;
}

/**
 * Run a quick-add plan for a trimmed title. Rejects empty titles. Returns the
 * new task id so the caller can (optionally) hand it to the edit wizard.
 */
export async function executeQuickAdd(
  o: QuickAddObjective,
  rawTitle: string,
  deps: QuickAddDeps,
): Promise<{ taskId: string }> {
  const title = rawTitle.trim();
  if (!title) throw new Error('Title is required');
  const plan = planQuickAdd(o);
  if (plan.kind === 'subtask') {
    const { task } = await deps.createTask({ title, parent_id: plan.parentTaskId });
    return { taskId: task.id };
  }
  const { task } = await deps.createTask({ title });
  await deps.linkTask(plan.objectiveId, task.id);
  return { taskId: task.id };
}
