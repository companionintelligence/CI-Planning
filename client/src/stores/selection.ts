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
export interface Selection { kind: SelectableKind; id: number }

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
 * Resolve the selection to a deduped, ordered list of task ids — what the
 * `POST /api/patterns/promote-from-tasks` endpoint expects. The caller passes
 * in the current `blocks` list so the block→task_id lookup works.
 *
 *  - block:id → looks up `blocks[id].task_id` (skipped if NULL).
 *  - flight-plan-task:id → IS the task id.
 */
export function selectedTaskIds(blocks: { id: number; task_id?: number }[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const s of selection().values()) {
    let tid: number | undefined;
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
  blocks: { id: number; title: string }[],
  tasks: { id: number; title: string }[],
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
