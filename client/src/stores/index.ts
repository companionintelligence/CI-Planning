import { createSignal, createMemo, createResource } from 'solid-js';
import { api } from '../lib/api.js';
import type { Block, Task, Pattern, PatternType } from '../lib/api.js';
import { on } from '../lib/sse.js';
import { localISODate, dayRangeUTC } from '../lib/dates.js';
import { effectiveBlock } from '../lib/drag.js';
import { blockPasses } from '../lib/overlay.js';
import { replanToastMessage } from '../lib/replan.js';

// ── Tasks ────────────────────────────────────────────────────────────────────
export const [taskFilter, setTaskFilter] = createSignal<Record<string, string>>({});

export const [tasks, { refetch: refetchTasks }] = createResource(taskFilter, (f) =>
  api.tasks.list(f).then((r) => r.tasks)
);

on('task:created', () => refetchTasks());
on('task:updated', () => refetchTasks());

// ── Blocks ───────────────────────────────────────────────────────────────────
// `selectedDay` is the day the cockpit is viewing (cockpit-v2 Phase 1). The Planner,
// blocks fetch, header lane, and Day Overview all read it instead of calling
// localISODate() directly; `blockRange` derives from it.
export const [selectedDay, setSelectedDay] = createSignal(localISODate());
// Multi-day override for the standalone /calendar view. When that page is mounted it
// sets a wide range here; null (the default) falls back to the single selected day, so
// the Planner is unaffected. The Calendar resets this to null on unmount.
export const [calendarRange, setCalendarRange] = createSignal<{ from: string; to: string } | null>(null);
export const blockRange = createMemo(() => calendarRange() ?? dayRangeUTC(selectedDay()));
export const [blocks, { refetch: refetchBlocks }] = createResource(blockRange, (r) =>
  api.blocks.list(r.from, r.to).then((res) => res.blocks)
);

on('block:created', () => refetchBlocks());
on('block:updated', () => refetchBlocks());
on('block:deleted', () => refetchBlocks());
on('schedule:done',  () => refetchBlocks());
// Phase M B3: a reactive reflow (auto-defense) emits schedule:done with a diff.
// The refetch above repaints the day; this surfaces a low-noise toast ONLY when
// something actually moved, so background reflows aren't silent but aren't noisy.
on('schedule:done', (data) => {
  const msg = replanToastMessage(data);
  if (msg) showToast(msg, 'default');
});

// ── Replan suggestion (Phase M B4) ──────────────────────────────────────────────
// A big-disruption reflow surfaces a nudge: a persistent Today banner (ReplanBanner
// reads this signal) PLUS a transient actionable toast. Accepting calls the LLM
// re-author; dismissing clears it. The server clears it server-side too, broadcasting
// 'replan:dismissed' so other tabs drop the banner.
export interface ReplanSuggestion { date: string; reason?: string; summary?: string }
export const [replanSuggestion, setReplanSuggestion] = createSignal<ReplanSuggestion | null>(null);

on('replan:suggested', (data) => {
  const s = data as ReplanSuggestion;
  setReplanSuggestion(s);
  showToast(s.summary ? `${s.summary} — re-plan with AI?` : 'Re-plan your day with AI?', 'default', 8000, {
    label: 'Re-plan',
    run: () => { void api.plan.reauthor(s.date).then(() => setReplanSuggestion(null)).catch(() => {}); },
  });
});
on('replan:dismissed', () => setReplanSuggestion(null));

// ── Concepts (Phase G, Step 2b) ────────────────────────────────────────────────
// Unscheduled goal Time-Blocks — owner-scoped, off the minute grid (a goal day +
// duration, no fixed time). Fetched separately from the dated range since they have
// no real time; the horizon lane + the PLANNER's goal-day header chip read them here.
export const [concepts, { refetch: refetchConcepts }] = createResource(() =>
  api.blocks.listConcepts().then((r) => r.blocks)
);
on('block:created', () => refetchConcepts());
on('block:updated', () => refetchConcepts());
on('block:deleted', () => refetchConcepts());

// ── Overlays (tag AND priority, combinable) ────────────────────────────────────
// Tag/priority live on the linked *task*, not the block. The filter is client-side
// over the already-fetched range — no new endpoint. Both filters AND-combine; an
// empty filter means "all". A block with no task_id (break/buffer) passes only when
// no filter is set.
export const [overlayTags, setOverlayTags] = createSignal<string[]>([]); // tag names; empty = all
export const [overlayPrio, setOverlayPrio] = createSignal<number[]>([]); // priorities 1–5; empty = all

/** Build a task lookup by id from the current tasks resource. */
const taskById = createMemo<Map<string, Task>>(() => {
  const m = new Map<string, Task>();
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
export function taskOf(taskId?: string): Task | undefined {
  return taskId ? taskById().get(taskId) : undefined;
}

// ── Possibles ────────────────────────────────────────────────────────────────
export const [possibles, { refetch: refetchPossibles }] = createResource(() =>
  api.possibles.list().then((r) => r.possibles)
);

on('possible:promoted',  () => { refetchPossibles(); refetchTasks(); });
on('possible:dismissed', () => refetchPossibles());

// ── Phase G: flight-plan, patterns, pattern types ──────────────────────────────
// The flight-plan is the persisted, owner-scoped staging area the two-step Auto
// runs over. It survives reloads; Reset clears it. SSE keeps every device in sync.
export const [flightPlan, { refetch: refetchFlightPlan }] = createResource(() =>
  api.flightPlan.list().then((r) => r.flight_plan)
);

on('flight_plan:updated', () => refetchFlightPlan());
on('flight_plan:filled',  () => refetchFlightPlan());
on('flight_plan:reset',   () => refetchFlightPlan());
// Auto step-2 places staged items into the day as time_blocks → refresh the PLANNER.
on('auto:placed', () => { refetchBlocks(); refetchFlightPlan(); });

export const [patterns, { refetch: refetchPatterns }] = createResource(() =>
  api.patterns.list().then((r) => r.patterns)
);
on('pattern:created', () => refetchPatterns());
on('pattern:updated', () => refetchPatterns());
on('pattern:deleted', () => refetchPatterns());

export const [patternTypes, { refetch: refetchPatternTypes }] = createResource(() =>
  api.patternTypes.list().then((r) => r.pattern_types)
);
on('pattern_type:created', () => refetchPatternTypes());
on('pattern_type:updated', () => refetchPatternTypes());
on('pattern_type:deleted', () => refetchPatternTypes());

/** Pattern types keyed by id — for resolving a pattern's icon shape. */
const patternTypeById = createMemo<Map<string, PatternType>>(() => {
  const m = new Map<string, PatternType>();
  for (const t of patternTypes() ?? []) m.set(t.id, t);
  return m;
});

/**
 * The pattern a task belongs to (first by lowest position), for texture rendering.
 * Membership is many-to-many; V1 picks one pattern per task to choose the texture.
 */
const patternByTaskId = createMemo<Map<string, Pattern>>(() => {
  const m = new Map<string, Pattern>();
  for (const p of patterns() ?? []) {
    for (const tid of p.task_ids) if (!m.has(tid)) m.set(tid, p);
  }
  return m;
});

/** The pattern + its type for a task, if any — drives the PLANNER's pattern texture. */
export function patternForTask(taskId?: string): { pattern: Pattern; type?: PatternType } | undefined {
  if (taskId == null) return undefined;
  const pattern = patternByTaskId().get(taskId);
  if (!pattern) return undefined;
  return { pattern, type: pattern.type_id != null ? patternTypeById().get(pattern.type_id) : undefined };
}

// ── Tags ─────────────────────────────────────────────────────────────────────
export const [tags, { refetch: refetchTags }] = createResource(() =>
  api.tags.list().then((r) => r.tags)
);

// ── Prefs ────────────────────────────────────────────────────────────────────
export const [prefs, { refetch: refetchPrefs }] = createResource(() =>
  api.prefs.get().then((r) => r.prefs)
);

// ── Pattern-blocks ────────────────────────────────────────────────────────────
export const [patternBlocks, { refetch: refetchPatternBlocks }] = createResource(() =>
  api.patternBlocks.list()
);

// ── Pattern-prefs (T5) ───────────────────────────────────────────────────────
export const [patternPrefs, { refetch: refetchPatternPrefs }] = createResource(() =>
  api.patternPrefs.list()
);

// ── Jobs ─────────────────────────────────────────────────────────────────────
export const [jobs, { refetch: refetchJobs }] = createResource(() =>
  api.jobs.list().then((r) => r.jobs)
);

on('job:run', () => refetchJobs());

// A full import replaces all owner data — refetch every core resource.
on('data:imported', () => {
  refetchTasks(); refetchBlocks(); refetchConcepts(); refetchPossibles();
  refetchFlightPlan(); refetchPatterns(); refetchPatternTypes();
  refetchTags(); refetchPrefs(); refetchPatternBlocks(); refetchPatternPrefs(); refetchJobs();
});

// ── Toast ─────────────────────────────────────────────────────────────────────
export type ToastKind = 'default' | 'success' | 'error';
export interface ToastAction { label: string; run: () => void; }
export interface Toast { id: number; message: string; kind: ToastKind; action?: ToastAction; }

const [_toasts, setToasts] = createSignal<Toast[]>([]);
export const toasts = _toasts;

let _tid = 0;
export function showToast(message: string, kind: ToastKind = 'default', durationMs = 3000, action?: ToastAction) {
  const id = ++_tid;
  setToasts((prev) => [...prev, { id, message, kind, action }]);
  setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs);
}

// ── Reminders (Phase H) — surface a fired reminder in-app with a quick snooze. The
// server delivers via SSE first (push is the backgrounded channel), so this always runs.
on('reminder:fire', (data) => {
  const d = data as { id: string; taskId: string | null };
  const title = (d.taskId ? (tasks() ?? []).find((t) => t.id === d.taskId)?.title : undefined) ?? 'Reminder';
  showToast(`⏰ ${title}`, 'default', 8000, { label: 'Snooze 10m', run: () => void api.reminders.snooze(d.id, 10) });
});
on('reminder:snoozed', () => showToast('Reminder snoozed for 10 min', 'success'));

// ── Element wizard modal ────────────────────────────────────────────────────────
// The unified Add/Edit wizard for the calendar-addable Entities. "Element" is a
// UI-only union (no DB noun) over Task / Habit / Routine / Time-Block. `kind: null`
// shows the four-button type chooser first (Add mode); Edit mode passes a concrete
// kind + editTarget so it jumps straight to that type's form.
export type ElementKind = 'task' | 'habit' | 'routine' | 'timeblock';
export const [elementModal, setElementModal] = createSignal<{
  open: boolean;
  mode: 'add' | 'edit';
  kind: ElementKind | null;
  prefill?: { day?: string; start?: string; durationMin?: number };
  editTarget?: { kind: ElementKind; id: string };
  parentId?: string; // when adding a subtask
}>({ open: false, mode: 'add', kind: null });
