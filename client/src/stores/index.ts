import { createSignal, createMemo, createResource } from 'solid-js';
import { api } from '../lib/api.js';
import type { Block, Task } from '../lib/api.js';
import { on } from '../lib/sse.js';
import { localISODate, dayRangeUTC } from '../lib/dates.js';
import { effectiveBlock } from '../lib/drag.js';
import { blockPasses } from '../lib/overlay.js';

// ── Tasks ────────────────────────────────────────────────────────────────────
export const [taskFilter, setTaskFilter] = createSignal<Record<string, string>>({});

export const [tasks, { refetch: refetchTasks }] = createResource(taskFilter, (f) =>
  api.tasks.list(f).then((r) => r.tasks)
);

on('task:created', () => refetchTasks());
on('task:updated', () => refetchTasks());

// ── Blocks ───────────────────────────────────────────────────────────────────
export const [blockRange, setBlockRange] = createSignal(dayRangeUTC(localISODate()));
export const [blocks, { refetch: refetchBlocks }] = createResource(blockRange, (r) =>
  api.blocks.list(r.from, r.to).then((res) => res.blocks)
);

on('block:created', () => refetchBlocks());
on('block:updated', () => refetchBlocks());
on('block:deleted', () => refetchBlocks());
on('schedule:done',  () => refetchBlocks());

// ── Overlays (tag AND priority, combinable) ────────────────────────────────────
// Tag/priority live on the linked *task*, not the block. The filter is client-side
// over the already-fetched range — no new endpoint. Both filters AND-combine; an
// empty filter means "all". A block with no task_id (break/buffer) passes only when
// no filter is set.
export const [overlayTags, setOverlayTags] = createSignal<string[]>([]); // tag names; empty = all
export const [overlayPrio, setOverlayPrio] = createSignal<number[]>([]); // priorities 1–5; empty = all

/** Build a task lookup by id from the current tasks resource. */
const taskById = createMemo<Map<number, Task>>(() => {
  const m = new Map<number, Task>();
  for (const t of tasks() ?? []) m.set(t.id, t);
  return m;
});

export { blockPasses };

/**
 * The blocks the grid should actually render: authoritative rows with any
 * optimistic drag override applied, then filtered by the active overlay.
 * Conflict highlighting (in the grid) computes on this visible set.
 */
export const visibleBlocks = createMemo<Block[]>(() => {
  const list = blocks() ?? [];
  const lookup = taskById();
  const tagF = overlayTags();
  const prioF = overlayPrio();
  return list
    .filter((b) => blockPasses(b, b.task_id ? lookup.get(b.task_id) : undefined, tagF, prioF))
    .map(effectiveBlock);
});

/** Lookup the task linked to a block (for chip rendering / overlays). */
export function taskOf(taskId?: number): Task | undefined {
  return taskId ? taskById().get(taskId) : undefined;
}

// ── Possibles ────────────────────────────────────────────────────────────────
export const [possibles, { refetch: refetchPossibles }] = createResource(() =>
  api.possibles.list().then((r) => r.possibles)
);

on('possible:promoted',  () => { refetchPossibles(); refetchTasks(); });
on('possible:dismissed', () => refetchPossibles());

// ── Tags ─────────────────────────────────────────────────────────────────────
export const [tags, { refetch: refetchTags }] = createResource(() =>
  api.tags.list().then((r) => r.tags)
);

// ── Prefs ────────────────────────────────────────────────────────────────────
export const [prefs, { refetch: refetchPrefs }] = createResource(() =>
  api.prefs.get().then((r) => r.prefs)
);

// ── Jobs ─────────────────────────────────────────────────────────────────────
export const [jobs, { refetch: refetchJobs }] = createResource(() =>
  api.jobs.list().then((r) => r.jobs)
);

on('job:run', () => refetchJobs());

// ── Toast ─────────────────────────────────────────────────────────────────────
export type ToastKind = 'default' | 'success' | 'error';
export interface Toast { id: number; message: string; kind: ToastKind; }

const [_toasts, setToasts] = createSignal<Toast[]>([]);
export const toasts = _toasts;

let _tid = 0;
export function showToast(message: string, kind: ToastKind = 'default', durationMs = 3000) {
  const id = ++_tid;
  setToasts((prev) => [...prev, { id, message, kind }]);
  setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs);
}

// ── Task form modal ───────────────────────────────────────────────────────────
export const [taskModal, setTaskModal] = createSignal<{
  open: boolean;
  editTask?: import('../lib/api.js').Task;
  parentId?: number;
}>({ open: false });
