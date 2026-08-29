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
 * The single "expanded" Planner entity — a Task (a task chip) OR a Block (a
 * Time-Block / meeting / focus chip). Clicking an entity on the Planner expands it
 * into the `PlannerEntityCard` overlay (details + actions) instead of the old
 * header strip (tasks) or pop-up menu (blocks). Only one entity is expanded at a
 * time, so setting one clears the other.
 *
 * `activeTask` is kept as the task-focused accessor (T-CORE-3) the rest of the app
 * already reads; `activeBlock` is its block-side sibling.
 */
const [activeTask, setActiveTaskId] = createSignal<string | null>(null);
const [activeBlock, setActiveBlockId] = createSignal<string | null>(null);

/**
 * Non-task/block entities the details drawer can describe (drawer layout, Phase W
 * of the UI work): tags, tag groups, calendar days, jobs, life dimensions, and
 * unpromoted email suggestions. Kept in the same store as activeTask/activeBlock so
 * there is still exactly one answer to "what is selected?" — setting any one of the
 * three clears the other two.
 * `id` is the tag id for 'tag', the group NAME for direction/category, the ISO
 * date for 'day', the job id for 'job', the category key for 'dimension', the
 * possible_tasks id for 'suggestion', and the objective id for 'objective'.
 */
export type EntityKind = 'tag' | 'direction' | 'category' | 'day' | 'job' | 'dimension' | 'suggestion' | 'objective';
export interface ActiveEntity { kind: EntityKind; id: string }
const [activeEntity, setActiveEntitySignal] = createSignal<ActiveEntity | null>(null);

export { activeTask, activeBlock, activeEntity };

export function setActiveTask(id: string | null): void {
  setActiveBlockId(null);
  setActiveEntitySignal(null);
  setActiveTaskId(id);
}
export function setActiveBlock(id: string | null): void {
  setActiveTaskId(null);
  setActiveEntitySignal(null);
  setActiveBlockId(id);
}
export function setActiveEntity(kind: EntityKind, id: string): void {
  setActiveTaskId(null);
  setActiveBlockId(null);
  setActiveEntitySignal({ kind, id });
}
export function clearActiveTask(): void {
  if (activeTask() !== null) setActiveTaskId(null);
}
/** Close the expanded card whichever kind of entity it holds. */
export function clearActiveEntity(): void {
  if (activeTask() !== null) setActiveTaskId(null);
  if (activeBlock() !== null) setActiveBlockId(null);
  if (activeEntity() !== null) setActiveEntitySignal(null);
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
