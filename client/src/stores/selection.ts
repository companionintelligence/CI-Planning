/**
 * Multi-select state shared by the Planner chips and the Flight-plan rows
 * (PR-C+, Phase F). Cmd/Ctrl-click toggles; Shift++ (the literal Shift + key
 * combo) opens "Create Routine from selection". Selection lives globally so a
 * mixed selection (planner chip + flight-plan row) works.
 *
 * Keyed by `${kind}:${id}` because a block id and a task id can collide. Pure
 * store; resolve-to-task-id mapping happens at the call site where the blocks
 * and tasks resources are already in scope.
 */
import { createSignal } from 'solid-js';

export type SelectableKind = 'block' | 'flight-plan-task';
export interface Selection { kind: SelectableKind; id: string }

const keyOf = (s: Selection) => `${s.kind}:${s.id}`;
const [selection, setSelection] = createSignal<Map<string, Selection>>(new Map());

export { selection };

export function isSelected(s: Selection): boolean {
  return selection().has(keyOf(s));
}
export function toggleSelection(s: Selection): void {
  const next = new Map(selection());
  const k = keyOf(s);
  if (next.has(k)) next.delete(k);
  else next.set(k, s);
  setSelection(next);
}
export function clearSelection(): void {
  if (selection().size > 0) setSelection(new Map());
}

/**
 * The single "focused" Task (T-CORE-3) — independent of the multi-select `Map`
 * above. A plain task id, or null when nothing is focused. Drives the Selected
 * Task Summary panel under the Planner header (T-PLAN-3/4); a Planner block click
 * sets it instead of opening the old pop-up menu.
 */
const [activeTask, setActiveTaskId] = createSignal<string | null>(null);

export { activeTask };

export function setActiveTask(id: string | null): void {
  setActiveTaskId(id);
}
export function clearActiveTask(): void {
  if (activeTask() !== null) setActiveTaskId(null);
}

/**
 * "Create Routine from selection" modal state. Shared so it can be opened both by
 * the Shift++ chord (Today) and the Planner header "+ Routine" button that appears
 * once ≥2 items are selected (so the chord isn't the only way in). Today owns the
 * modal markup + the create handler; both entry points just flip this open.
 */
export const [routineModal, setRoutineModal] = createSignal<{ open: boolean; name: string }>({ open: false, name: '' });

/**
 * Resolve the selection to a deduped, ordered list of task ids — what the
 * `POST /api/patterns/promote-from-tasks` endpoint expects. The caller passes
 * in the current `blocks` list so the block→task_id lookup works.
 *
 *  - block:id → looks up `blocks[id].task_id` (skipped if NULL).
 *  - flight-plan-task:id → IS the task id.
 */
export function selectedTaskIds(blocks: { id: string; task_id?: string }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of selection().values()) {
    let tid: string | undefined;
    if (s.kind === 'flight-plan-task') {
      tid = s.id;
    } else {
      const b = blocks.find((b) => b.id === s.id);
      tid = b?.task_id;
    }
    if (tid != null && !seen.has(tid)) {
      seen.add(tid);
      out.push(tid);
    }
  }
  return out;
}

/** A human label for the selected items (for the modal preview). */
export function selectedTitles(
  blocks: { id: string; title: string }[],
  tasks: { id: string; title: string }[],
): string[] {
  const out: string[] = [];
  for (const s of selection().values()) {
    if (s.kind === 'block') {
      const b = blocks.find((b) => b.id === s.id);
      if (b) out.push(b.title);
    } else {
      const t = tasks.find((t) => t.id === s.id);
      if (t) out.push(t.title);
    }
  }
  return out;
}
