import { createSignal, createResource } from 'solid-js';
import { api, type TimeEntry } from '../lib/api.js';
import { on } from '../lib/sse.js';
import { localISODate, dayRangeUTC } from '../lib/dates.js';
import { liveClockFor, liveMinutesFor } from '../lib/elapsed.js';

// ── Tasks ────────────────────────────────────────────────────────────────────
export const [taskFilter, setTaskFilter] = createSignal<Record<string, string>>({});

export const [tasks, { refetch: refetchTasks }] = createResource(taskFilter, (f) =>
  api.tasks.list(f).then((r) => r.tasks)
);

on('task:created', () => refetchTasks());
on('task:updated', () => refetchTasks());

// ── Running timer ──────────────────────────────────────────────────────────────
// At most one entry per owner. Hydrated by GET /api/timer on load, then kept in
// sync by owner-scoped timer:started / timer:stopped SSE events. A single global
// 1s ticker (`now`) drives every live elapsed display — no per-card intervals.
const [runningEntry, setRunningEntry] = createSignal<TimeEntry | null>(null);
export { runningEntry };

// Hydrate the running entry once at startup (survives reload / server restart).
void api.timer.current().then((r) => setRunningEntry(r.entry)).catch(() => {});

on('timer:started', (data) => setRunningEntry(data as TimeEntry));
on('timer:stopped', (data) => {
  // Clear only if the stopped entry is the one we think is running (a superseded
  // entry's stop arrives just before the new one's start; both are id-tagged).
  const stopped = data as TimeEntry;
  setRunningEntry((cur) => (cur && cur.id === stopped.id ? null : cur));
});

const [now, setNow] = createSignal(Date.now());
export { now };
// One interval for the whole app; only running cards read `now()` so the rest
// stay inert. Module-scoped so it lives for the app's lifetime.
setInterval(() => setNow(Date.now()), 1000);

/** Live elapsed minutes for a task if it is the running one, else null. */
export const liveElapsedMinutes = (taskId: number): number | null =>
  liveMinutesFor(runningEntry(), taskId, now());

/** Live elapsed as `m:ss` for a task if it is the running one, else null. */
export const liveElapsedClock = (taskId: number): string | null =>
  liveClockFor(runningEntry(), taskId, now());

// ── Blocks ───────────────────────────────────────────────────────────────────
export const [blockRange, setBlockRange] = createSignal(dayRangeUTC(localISODate()));
export const [blocks, { refetch: refetchBlocks }] = createResource(blockRange, (r) =>
  api.blocks.list(r.from, r.to).then((res) => res.blocks)
);

on('block:created', () => refetchBlocks());
on('block:updated', () => refetchBlocks());
on('block:deleted', () => refetchBlocks());
on('schedule:done',  () => refetchBlocks());

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
