import { createSignal, createMemo, createResource, createEffect } from 'solid-js';
import { api } from '../lib/api.js';
import type { Block, Task, Pattern, PatternType, ReplanSuggestion } from '../lib/api.js';
import { on } from '../lib/sse.js';
import { localISODate, dayRangeUTC } from '../lib/dates.js';
import { effectiveBlock } from '../lib/drag.js';
import { blockPassesAxes, emptyAxisDeselected, TAG_AXES } from '../lib/overlay.js';
import type { AxisDeselected, TagAxis, TagKindLookup } from '../lib/overlay.js';
import { DEFAULT_AXIS_STATE } from '../lib/day-axis.js';
import type { AxisState } from '../lib/day-axis.js';
import {
  buildCalendarViewPrefs,
  deserializeAxisState,
  deserializeDeselected,
  deserializePrio,
} from '../lib/view-prefs.js';
import { replanToastMessage } from '../lib/replan.js';

// ── Tasks ────────────────────────────────────────────────────────────────────
export const [taskFilter, setTaskFilter] = createSignal<Record<string, string>>({});

export const [tasks, { refetch: refetchTasks, mutate: mutateTasks }] = createResource(taskFilter, (f) =>
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
export const [blocks, { refetch: refetchBlocks, mutate: mutateBlocks }] = createResource(blockRange, (r) =>
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

// ── Overlays (three tag axes AND priority, combinable) ──────────────────────────
// Tag/priority live on the linked *task*, not the block. The filter is client-side
// over the already-fetched range — no new endpoint. The tag filter is split into three
// independent axes by tag KIND — Direction / Intention / Category — each holding the set
// of DESELECTED (hidden) tag names; empty set = every chip on = no filtering on that
// axis. OR within an axis, AND across the three axes AND priority. A block with no tag
// on an axis always passes that axis (untagged-on-axis is never hidden); a block with no
// task_id (break/buffer) carries no tags/priority, so it passes every tag axis but is
// hidden the moment a priority filter is set. See lib/overlay.ts for the pure predicate.
export const [overlayAxes, setOverlayAxes] = createSignal<AxisDeselected>(emptyAxisDeselected());
export const [overlayPrio, setOverlayPrio] = createSignal<number[]>([]); // priorities 1–5; empty = all

// ── Calendar night-hour collapse (Wave-3 item 6; persisted 0111) ────────────────
// Lifted out of CalendarGrid so it shares the same cross-device persistence path as
// the overlay filter. Default = BOTH collapsed (DEFAULT_AXIS_STATE). CalendarGrid
// reads/toggles these; the view_prefs effect below hydrates + persists them.
export const [calendarAxisState, setCalendarAxisState] = createSignal<AxisState>({ ...DEFAULT_AXIS_STATE });
export function toggleCalendarTop() {
  setCalendarAxisState((s) => ({ ...s, topExpanded: !s.topExpanded }));
}
export function toggleCalendarBottom() {
  setCalendarAxisState((s) => ({ ...s, bottomExpanded: !s.bottomExpanded }));
}

/** Toggle one chip on an axis (deselect if selected, re-select if deselected). */
export function toggleAxisTag(axis: TagAxis, name: string) {
  setOverlayAxes((prev) => {
    const next: AxisDeselected = { ...prev, [axis]: new Set(prev[axis]) };
    if (next[axis].has(name)) next[axis].delete(name);
    else next[axis].add(name);
    return next;
  });
}

/** Reset all three axes back to all-on (nothing hidden). */
export function resetOverlayAxes() {
  setOverlayAxes(emptyAxisDeselected());
}

/** Count of deselected chips across all axes — drives the "active filters" badge. */
export function overlayAxesCount(deselected: AxisDeselected): number {
  return TAG_AXES.reduce((n, axis) => n + deselected[axis].size, 0);
}

// ── Tags ─────────────────────────────────────────────────────────────────────
// Defined here — above the memos that read it (tagKindLookup / visibleBlocks) —
// because createMemo evaluates eagerly at module init: a memo that calls tags()
// before this const initializes would throw a TDZ error and abort the module.
export const [tags, { refetch: refetchTags }] = createResource(() =>
  api.tags.list().then((r) => r.tags)
);

/** Build a task lookup by id from the current tasks resource. */
const taskById = createMemo<Map<string, Task>>(() => {
  const m = new Map<string, Task>();
  for (const t of tasks() ?? []) m.set(t.id, t);
  return m;
});

/** tag-name → axis (kind) lookup, so the predicate can bucket a task's tag names. */
export const tagKindLookup = createMemo<TagKindLookup>(() => {
  const m = new Map<string, TagAxis>();
  for (const t of tags() ?? []) m.set(t.name, t.kind);
  return m;
});

/**
 * The blocks the grid should actually render: authoritative rows with any
 * optimistic drag override applied, then filtered by the active overlay.
 * Conflict highlighting (in the grid) computes on this visible set.
 */
export const visibleBlocks = createMemo<Block[]>(() => {
  const list = blocks() ?? [];
  const lookup = taskById();
  const kindOf = tagKindLookup();
  const axes = overlayAxes();
  const prioF = overlayPrio();
  return list
    .filter((b) => blockPassesAxes(b, b.task_id ? lookup.get(b.task_id) : undefined, kindOf, axes, prioF))
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

/** Task ids currently staged in the flight-plan — O(1) membership for the task list
 * (mirrors the patternByTaskId memo idiom; avoids a per-card .some() scan). */
export const flightPlanTaskIds = createMemo<Set<string>>(() => {
  const s = new Set<string>();
  for (const it of flightPlan() ?? []) s.add(it.task_id);
  return s;
});

/**
 * A task's placement (earliest task-block) in the currently-loaded blocks range,
 * as local date/time. Lets the task list treat "on the planner" as scheduled —
 * regardless of which engine placed it or whether the DB `status` was flipped —
 * so the calendar icon + Scheduled section stay honest and self-healing (a task
 * whose block is later cleared simply drops out of this map). Range-scoped: covers
 * the loaded day/week; out-of-range placements fall back to the task's own status.
 */
export const scheduledByTaskId = createMemo<Map<string, { date: string; time: string }>>(() => {
  const m = new Map<string, { date: string; time: string; start: string }>();
  for (const b of blocks() ?? []) {
    if (b.block_kind !== 'task' || !b.task_id) continue;
    const prev = m.get(b.task_id);
    if (prev && prev.start <= b.start_at) continue; // keep the earliest placement
    const d = new Date(b.start_at);
    const time = b.all_day ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    m.set(b.task_id, { date: localISODate(d), time, start: b.start_at });
  }
  const out = new Map<string, { date: string; time: string }>();
  for (const [id, v] of m) out.set(id, { date: v.date, time: v.time });
  return out;
});

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

/** Whether a task belongs to a Routine-type pattern — drives the task card's routine
 * texture background + the Tasks-view Routine section. (Habit/Ritual patterns don't
 * count; those subtypes have their own surfaces.) */
export function isRoutineTask(taskId?: string): boolean {
  return patternForTask(taskId)?.type?.name === 'Routine';
}

// ── Prefs ────────────────────────────────────────────────────────────────────
export const [prefs, { refetch: refetchPrefs }] = createResource(() =>
  api.prefs.get().then((r) => r.prefs)
);

// ── Calendar view-state persistence (0111) ─────────────────────────────────────
// HYDRATE the overlay filter + night-hour collapse from the server once prefs
// resolve (arrays → Sets), then PERSIST every subsequent change back via PATCH
// /api/prefs (optimistic + fire-and-forget — never blocks the UI, a debounce
// coalesces bursts of chip toggles). A malformed/missing blob degrades to the
// built-in defaults (the deserializers are forgiving), so hydration can't crash.
let _viewPrefsHydrated = false;

createEffect(() => {
  const p = prefs();
  if (_viewPrefsHydrated) return; // hydrate exactly once, the first time prefs land
  if (!p) return; // resource still loading
  const cal = p.view_prefs?.calendar;
  setOverlayAxes(deserializeDeselected(cal));
  setOverlayPrio(deserializePrio(cal));
  setCalendarAxisState(deserializeAxisState(cal));
  _viewPrefsHydrated = true;
});

let _viewPrefsTimer: ReturnType<typeof setTimeout> | undefined;
function persistCalendarViewPrefs() {
  const calendar = buildCalendarViewPrefs(overlayAxes(), overlayPrio(), calendarAxisState());
  clearTimeout(_viewPrefsTimer);
  _viewPrefsTimer = setTimeout(() => {
    // Merge under `calendar` so a future `planner` sibling (deferred follow-up) is
    // preserved. Fire-and-forget: a failed save just means it doesn't sync — the
    // in-memory state (the source of truth for this session) is already applied.
    const existing = prefs()?.view_prefs ?? {};
    void api.prefs.update({ view_prefs: { ...existing, calendar } }).catch(() => {});
  }, 400);
}

// Persist on any change to the filter or collapse state — but only after hydration,
// so restoring saved state doesn't immediately echo it back (and the initial
// all-on defaults don't overwrite a saved override before it loads).
createEffect(() => {
  // Track all three so the effect re-runs on any of them.
  overlayAxes();
  overlayPrio();
  calendarAxisState();
  if (!_viewPrefsHydrated) return;
  persistCalendarViewPrefs();
});

// ── Pattern-blocks ────────────────────────────────────────────────────────────
export const [patternBlocks, { refetch: refetchPatternBlocks }] = createResource(() =>
  api.patternBlocks.list()
);

// ── Block templates — reusable Plan contents, applied/swapped from the block edit menu.
export const [blockTemplates, { refetch: refetchBlockTemplates }] = createResource(() =>
  api.blockTemplates.list().then((r) => r.block_templates)
);
on('block_template:created', () => refetchBlockTemplates());
on('block_template:updated', () => refetchBlockTemplates());
on('block_template:deleted', () => refetchBlockTemplates());

// ── Pattern-prefs (T5) ───────────────────────────────────────────────────────
export const [patternPrefs, { refetch: refetchPatternPrefs }] = createResource(() =>
  api.patternPrefs.list()
);

// ── Category-prefs (0069): per-(Time Block Category) color + default block length ──
export const [categoryPrefs, { refetch: refetchCategoryPrefs }] = createResource(() =>
  api.categoryPrefs.list()
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
  refetchTags(); refetchPrefs(); refetchPatternBlocks(); refetchPatternPrefs(); refetchCategoryPrefs(); refetchJobs();
});

// Phase L: server tells the client it missed too many events (> REPLAY_LIMIT=500) —
// do a full refetch so local state is guaranteed consistent.
on('sync:resync', () => {
  refetchTasks(); refetchBlocks(); refetchConcepts();
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
