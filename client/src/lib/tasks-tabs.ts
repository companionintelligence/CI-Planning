/**
 * AF-1 — Tasks-view tab ⇄ URL search-param mapping.
 *
 * The /tasks view's tabs are URL-driven (`/tasks?tab=<TasksTab>`) so deep-links and
 * reloads land on the same tab. This module is deliberately pure (no Solid imports)
 * so the validation is unit-testable without jsdom.
 */

/** Tab order as rendered: Tasks · Objectives · Habits · Routines · Timeblock. */
export const TASKS_TABS = ['tasks', 'objectives', 'habits', 'routines', 'timeblocks'] as const;

export type TasksTab = (typeof TASKS_TABS)[number];

const TAB_SET: ReadonlySet<string> = new Set(TASKS_TABS);

/**
 * Coerce a raw `?tab=` search-param value (string | string[] | undefined per
 * @solidjs/router) to a valid tab. Unknown / absent / repeated values fall back
 * to the default `tasks` tab.
 */
export function parseTasksTab(value: unknown): TasksTab {
  return typeof value === 'string' && TAB_SET.has(value) ? (value as TasksTab) : 'tasks';
}
