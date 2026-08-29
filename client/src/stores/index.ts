import { createSignal, createMemo, createResource, createEffect } from 'solid-js';
import { api, type RecurringScope } from '../lib/api.js';
import type { Block, Task, Pattern, PatternType, ReplanSuggestion, RunNowOutcome } from '../lib/api.js';
import { on } from '../lib/sse.js';
import { localISODate, dayRangeUTC } from '../lib/dates.js';
import { effectiveBlock } from '../lib/drag.js';
import { blockPassesAxes, emptyAxisDeselected, TAG_AXES } from '../lib/overlay.js';
import { objectiveOfBlock, type ObjectiveAccent } from '../lib/objective-accent.js';
import type { AxisDeselected, TagAxis, TagKindLookup } from '../lib/overlay.js';
import { DEFAULT_AXIS_STATE } from '../lib/day-axis.js';
import type { AxisState } from '../lib/day-axis.js';
import {
  buildCalendarViewPrefs,
  deserializeEventsOnly,
  buildPlannerViewPrefs,
  deserializeAxisState,
  deserializeDeselected,
  deserializePrio,
} from '../lib/view-prefs.js';
import { replanToastMessage } from '../lib/replan.js';
import { hasConnectedSource as pureHasConnectedSource } from '../lib/onboarding.js';

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

// Phase 7 — the day's stranded tasks. Keyed on the selected day so the banner and the
// red treatment always describe the day being looked at. Refetched alongside blocks:
// a day-type change, a move, or a reflow all change the answer.
export const [dayConflicts, { refetch: refetchDayConflicts }] = createResource(
  selectedDay,
  (date: string) => api.dayReflow.conflicts(date).then((r) => r.conflicts),
);

/** Block ids the L01 windows no longer accommodate — drives the alert-red treatment. */
export const conflictedBlockIds = createMemo(
  () => new Set((dayConflicts() ?? []).map((c) => c.block_id)),
);

on('block:created', () => { refetchBlocks(); refetchDayConflicts(); });
on('block:updated', () => { refetchBlocks(); refetchDayConflicts(); });
on('block:deleted', () => { refetchBlocks(); refetchDayConflicts(); });
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
  // The banner's only action is an AI re-author (api.plan.reauthor → Ollama). With no
  // reachable Ollama that offer is a dead end — the server already reflowed
  // deterministically — so drop the nudge entirely rather than dangle a failing button.
  if (!aiAvailable()) return;
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

// ── Objectives (shared store — #386 objective accent) ──────────────────────────
// The live tree, shared so the Planner can join objective → task → block for the
// per-objective chip accent. Mirrors the concepts idiom above. ObjectivesPanel
// keeps its own local resource for now (migrating it here is a separate cleanup).
// objective_task:updated is included alongside the recipe's three: link/unlink
// changes membership, which is exactly what the accent join reads.
export const [objectives, { refetch: refetchObjectives }] = createResource(() =>
  api.objectives.list().then((r) => r.objectives)
);
on('objective:created', () => refetchObjectives());
on('objective:updated', () => refetchObjectives());
on('objective:deleted', () => refetchObjectives());
on('objective_task:updated', () => refetchObjectives());

// blockId → owning leaf-objective accent. Declared AFTER the `objectives` and
// `blocks` resources it reads — module-scope memos evaluate eagerly at init
// (see the ordering note at taskById below).
export const objectiveAccentByBlock = createMemo<Map<string, ObjectiveAccent>>(() =>
  objectiveOfBlock(objectives() ?? [], blocks() ?? [])
);

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

// Events-only ("free time") calendar view: hide movable task blocks so only real
// commitments — external events + anything locked — remain. Persisted with the rest of
// the calendar view prefs so the mode survives a reload.
export const [calendarEventsOnly, setCalendarEventsOnly] = createSignal(false);
export function toggleCalendarTop() {
  setCalendarAxisState((s) => ({ ...s, topExpanded: !s.topExpanded }));
}
export function toggleCalendarBottom() {
  setCalendarAxisState((s) => ({ ...s, bottomExpanded: !s.bottomExpanded }));
}

// ── Planner night-hour collapse (persisted 0111, view_prefs.planner) ────────────
// Same store-based hydrate/persist path as the calendar; independent toggle state.
export const [plannerAxisState, setPlannerAxisState] = createSignal<AxisState>({ ...DEFAULT_AXIS_STATE });
export function togglePlannerTop() {
  setPlannerAxisState((s) => ({ ...s, topExpanded: !s.topExpanded }));
}
export function togglePlannerBottom() {
  setPlannerAxisState((s) => ({ ...s, bottomExpanded: !s.bottomExpanded }));
}
/** Set the planner's configurable night-collapse boundaries (minutes-of-day; the
 *  Settings selects call this). Persistence rides the view_prefs effect below. */
export function setPlannerCollapseBounds(topEndMin: number, bottomStartMin: number) {
  setPlannerAxisState((s) => ({ ...s, topEndMin, bottomStartMin }));
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

// ── Suggestions (AF-3 / AF-7, + the email review gate) ─────────────────────────
// Most producers still auto-promote: a suggestion becomes a real task that lands in the
// Tasks tab's "New Today" section, so `possible:promoted` refetches tasks.
//
// Email is review-gated server-side (services/review-gate.ts) and waits for the owner,
// so it DOES have a surface again — the suggestions section at the top of the Tasks tab.
// `possible:suggested` fires on each ingest tick that produced something.
export const [suggestions, { refetch: refetchSuggestions, mutate: mutateSuggestions }] = createResource(() =>
  api.possibles.list().then((r) => r.possibles),
);

on('possible:suggested', () => refetchSuggestions());
on('possible:promoted', () => { refetchTasks(); refetchSuggestions(); });
on('possible:dismissed', () => refetchSuggestions());

// A suggestion can be acted on from two surfaces at once — the "Suggested from
// email" row (SuggestionsSection) and the Details Drawer (SuggestionPanel), opened
// on the same suggestion — and promote/dismiss aren't idempotent server-side, so an
// in-flight action on one surface must disable the other. ONE shared set, not a
// local signal per component, so both read the same answer to "is this busy?".
const [suggestionsBusy, setSuggestionsBusy] = createSignal<Set<string>>(new Set());
export { suggestionsBusy };
export function isSuggestionBusy(id: string): boolean {
  return suggestionsBusy().has(id);
}
export function setSuggestionBusy(id: string, on: boolean): void {
  setSuggestionsBusy((prev) => {
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
}

// ── Phase G: flight-plan, patterns, pattern types ──────────────────────────────
// The flight-plan is the persisted, owner-scoped staging area the two-step Auto
// runs over. It survives reloads; Reset clears it. SSE keeps every device in sync.
/** Is the last Auto placement run still undoable? Rides the flight-plan read so the
 *  Undo button reflects server state instead of "did THIS tab just run Auto" — the
 *  latter vanished on every reload while the run stayed undoable. */
const [canUndoAuto, setCanUndoAuto] = createSignal(false);
export { canUndoAuto };

export const [flightPlan, { refetch: refetchFlightPlan }] = createResource(() =>
  api.flightPlan.list().then((r) => {
    setCanUndoAuto(r.can_undo ?? false);
    return r.flight_plan;
  })
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

// ── Integrations / AI availability ─────────────────────────────────────────────
// GET /api/integrations aggregates per-integration availability (Ollama, Google, push).
// It's the single source of truth for whether the "intelligent half" of the app is
// usable: every AI surface gates on `aiAvailable()`. Fail-closed — while the resource
// loads or if it errors, `aiAvailable()` is false, so AI controls stay hidden rather
// than dangling as no-ops. Ollama can come up AFTER boot, so `refetchIntegrations` is
// exposed for a "recheck" affordance (Settings → Integrations) without a full reload.
export const [integrations, { refetch: refetchIntegrations }] = createResource(() =>
  api.llm.integrations()
);

/**
 * The "Re-check" affordance. `/api/integrations` reads a probe the server caches for 30s,
 * which is right for polling and wrong for exactly this: an operator who just started
 * Ollama and wants to know NOW. So bust the cache first (`/api/llm/status?fresh=1`), then
 * re-read. A plain refetch would faithfully return the stale probe and read as broken.
 *
 * The bust is best-effort — if it fails we still refetch, and the poll heals it within
 * the TTL. Returns the refetch so the button can await the whole round trip.
 */
export function recheckIntegrations() {
  return api.llm.recheck().catch(() => undefined).then(() => refetchIntegrations());
}

/**
 * True when AI features can actually run. Everything AI gates on this.
 *
 * Keys on `ready`, not `available`: `available` only means Ollama answered, and the
 * built-in default model tags aren't pulled on most machines — so this used to report
 * true while every call failed with `model '…' not found`, leaving AI controls visible
 * as silent no-ops. `ready` additionally requires the models that will actually be used
 * to be installed. Older servers don't send it, so fall back to `available`.
 */
export const aiAvailable = () => integrations()?.ollama.ready ?? integrations()?.ollama.available ?? false;

// ── Connections (T13 #349) ─────────────────────────────────────────────────────
// Provider-agnostic list of the owner's stored connections in the one ConnectionRecord
// shape, backing the Settings → Connections "Connected accounts" card. Same shape as
// `integrations().google.connections`, different reach: this is mode-blind and covers
// every provider (so a user whose Google is `off` still sees — and can drop — a stored
// token), while the integrations copy is google-only and pays for a decrypt to resolve
// the token expiry.
export const [connections, { refetch: refetchConnections }] = createResource(() =>
  // .catch(() => null) mirrors the failure-closed convention of the other Settings
  // resources (me/gcfg/accounts): a 500/transient drop degrades to the card's "No
  // accounts connected." fallback instead of re-throwing on read (no ErrorBoundary).
  api.connections.list().then((r) => r.connections).catch(() => null)
);

// ── Life priorities (0127) — the Priorities Wizard writes; the Balance view reads. ──
export const [priorities, { refetch: refetchPriorities }] = createResource(() =>
  api.priorities.list().then((r) => r.priorities)
);

// ── Prefs ────────────────────────────────────────────────────────────────────
export const [prefs, { refetch: refetchPrefs }] = createResource(() =>
  api.prefs.get().then((r) => r.prefs)
);

// ── Appearance: direction/routine background textures (view_prefs.appearance) ──
// Reactive getter — absent/malformed blob = ON (the pre-toggle behavior). The
// setter writes straight through (merge-over-existing so calendar/planner blobs
// survive) and refetches so every card re-renders from the server truth.
export const texturesEnabled = () => prefs()?.view_prefs?.appearance?.direction_textures !== false;
export function setTexturesEnabled(v: boolean) {
  const existing = prefs()?.view_prefs ?? {};
  const appearance = { ...(existing.appearance ?? {}), direction_textures: v };
  void api.prefs.update({ view_prefs: { ...existing, appearance } })
    .then(() => refetchPrefs())
    .catch((err) => showToast((err as Error).message, 'error'));
}

// ── Timezone auto-adopt (FTUE) ───────────────────────────────────────────────
// A Docker install seeds scheduling_prefs.timezone from the container clock — UTC —
// which silently shifts what counts as "today" for the planner and the nightly jobs.
// When the server still sits on that un-chosen UTC default and this browser knows a
// real zone, adopt the browser zone once. The localStorage marker makes it once per
// browser, so a user who deliberately sets UTC in Settings afterwards is respected.
const TZ_ADOPT_KEY = 'cp-tz-auto-adopted';
createEffect(() => {
  const p = prefs();
  if (!p) return;
  let browserTz = '';
  try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* keep '' */ }
  if (!browserTz || browserTz === 'UTC') return;
  if (p.timezone !== 'UTC') return; // a real zone is set — nothing to adopt
  try {
    if (localStorage.getItem(TZ_ADOPT_KEY)) return;
    localStorage.setItem(TZ_ADOPT_KEY, browserTz);
  } catch { /* storage unavailable → still adopt, just without the once-guard */ }
  void api.prefs.update({ timezone: browserTz }).then(() => refetchPrefs()).catch(() => {});
});

// ── Calendar view-state persistence (0111) ─────────────────────────────────────
// HYDRATE the overlay filter + night-hour collapse from the server once prefs
// resolve (arrays → Sets), then PERSIST every subsequent change back via PATCH
// /api/prefs (optimistic + fire-and-forget — never blocks the UI, a debounce
// coalesces bursts of chip toggles). A malformed/missing blob degrades to the
// built-in defaults (the deserializers are forgiving), so hydration can't crash.
let _viewPrefsHydrated = false;
let _viewPrefsPersistArmed = false;

createEffect(() => {
  const p = prefs();
  if (_viewPrefsHydrated) return; // hydrate exactly once, the first time prefs land
  if (!p) return; // resource still loading
  const cal = p.view_prefs?.calendar;
  setOverlayAxes(deserializeDeselected(cal));
  setOverlayPrio(deserializePrio(cal));
  setCalendarAxisState(deserializeAxisState(cal));
  setCalendarEventsOnly(deserializeEventsOnly(cal));
  setPlannerAxisState(deserializeAxisState(p.view_prefs?.planner));
  _viewPrefsHydrated = true;
});

let _viewPrefsTimer: ReturnType<typeof setTimeout> | undefined;
function persistViewPrefs() {
  const calendar = buildCalendarViewPrefs(overlayAxes(), overlayPrio(), calendarAxisState(), calendarEventsOnly());
  const planner = buildPlannerViewPrefs(plannerAxisState());
  clearTimeout(_viewPrefsTimer);
  _viewPrefsTimer = setTimeout(() => {
    // Merge both sections over whatever's stored so neither clobbers the other (and
    // any future sibling is preserved). Fire-and-forget: a failed save just means it
    // doesn't sync — the in-memory state (this session's source of truth) is applied.
    const existing = prefs()?.view_prefs ?? {};
    void api.prefs.update({ view_prefs: { ...existing, calendar, planner } }).catch(() => {});
  }, 400);
}

// Persist on any change to the filter or collapse state — but only after hydration,
// so restoring saved state doesn't immediately echo it back (and the initial
// all-on defaults don't overwrite a saved override before it loads).
createEffect(() => {
  // Track all four so the effect re-runs on any of them.
  overlayAxes();
  overlayPrio();
  calendarAxisState();
  calendarEventsOnly();
  plannerAxisState();
  if (!_viewPrefsHydrated) return;
  // The hydration setters above re-trigger this effect once; that first post-hydration
  // run is just echoing the values we loaded, so arm-and-skip it (no PATCH on load).
  if (!_viewPrefsPersistArmed) { _viewPrefsPersistArmed = true; return; }
  persistViewPrefs();
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

// ── Connection-prefs (0145): per-source colour + stripe texture on synced events ──
export const [connectionPrefs, { refetch: refetchConnectionPrefs }] = createResource(() =>
  api.connectionPrefs.list()
);

// ── Jobs ─────────────────────────────────────────────────────────────────────
export const [jobs, { refetch: refetchJobs }] = createResource(() =>
  api.jobs.list().then((r) => r.jobs)
);

on('job:run', () => refetchJobs());

// A full import replaces all owner data — refetch every core resource.
on('data:imported', () => {
  refetchTasks(); refetchBlocks(); refetchConcepts();
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

// #388 — the reminders list (Focus card). listReminders returns non-cancelled rows
// ordered by fire_at; the four events below are every server-side reminder mutation
// (routes + GraphQL broadcast created/cancelled/snoozed; the engine broadcasts fire),
// so the card stays live without polling.
export const [reminders, { refetch: refetchReminders }] = createResource(() =>
  api.reminders.list().then((r) => r.reminders)
);
on('reminder:created', () => refetchReminders());
on('reminder:cancelled', () => refetchReminders());
on('reminder:snoozed', () => refetchReminders());
on('reminder:fire', () => refetchReminders());

// ── Element wizard modal ────────────────────────────────────────────────────────
// The unified Add/Edit wizard for the calendar-addable Entities. "Element" is a
// UI-only union (no DB noun) over Task / Habit / Routine / Time-Block. `kind: null`
// shows the four-button type chooser first (Add mode); Edit mode passes a concrete
// kind + editTarget so it jumps straight to that type's form.
export type ElementKind = 'task' | 'habit' | 'routine' | 'timeblock';
/**
 * The close ritual's QUEUE. APP-LEVEL on purpose (same reason as elementModal): completing
 * a task refetches, the task leaves the open list, and the TaskCard that triggered the
 * ritual UNMOUNTS — taking any card-local modal state with it. Measured: the sheet flashed
 * and vanished. Task objects are carried here (not just ids) so the sheet can still show a
 * title/estimate/placement for a task no longer in `tasks()`.
 *
 * A QUEUE rather than a single slot (0161) because the ritual now fires on every completion
 * path, habits included, and habits get ticked in bursts. With one slot the second tick of
 * a burst either steals the sheet mid-answer or is dropped silently; either way a
 * completion the user meant to rate goes unrated. The queue shows them in order ("1 of 3")
 * and the sheet's "skip the rest" empties the backlog in one tap, so the burst case costs
 * one gesture rather than N.
 *
 * Ordering is FIFO — the first thing you completed is the first you are asked about, which
 * is the order you remember doing them in.
 */
export interface CloseRitualEntry {
  task: Task;
  /** The block the completion came from, when the call site knows it — the Planner chip and
   *  the Focus ritual both do. Pins the duration default to the span actually worked
   *  instead of the task's earliest placement, which differs for multi-session tasks. */
  blockId?: string | null;
}

export const [closeRitualQueue, setCloseRitualQueue] = createSignal<CloseRitualEntry[]>([]);

/** The sheet's current subject: the head of the queue, or null when there is nothing to rate. */
export const closeRitualTask = (): CloseRitualEntry | null => closeRitualQueue()[0] ?? null;

/**
 * Enqueue a completed task for rating. Idempotent per task id: double-firing paths (a
 * block PATCH that mirrors onto its task AND the task refetch that follows) must not ask
 * about the same task twice.
 */
export function openCloseRitual(task: Task | null | undefined, blockId?: string | null): void {
  if (!task) return;
  setCloseRitualQueue((q) => (q.some((e) => e.task.id === task.id) ? q : [...q, { task, blockId }]));
}

/** Drop the head — the user rated it or skipped it. The next task surfaces immediately. */
export function advanceCloseRitual(): void {
  setCloseRitualQueue((q) => q.slice(1));
}

/** "Skip the rest": empty the backlog, head included. */
export function clearCloseRitual(): void {
  setCloseRitualQueue([]);
}

export const [elementModal, setElementModal] = createSignal<{
  open: boolean;
  mode: 'add' | 'edit';
  kind: ElementKind | null;
  prefill?: { day?: string; start?: string; durationMin?: number };
  editTarget?: { kind: ElementKind; id: string };
  parentId?: string; // when adding a subtask
}>({ open: false, mode: 'add', kind: null });

// ── Plan-my-week assistant modal (FTUE · T2) ────────────────────────────────────
// Same once-mounted, signal-self-driven idiom as elementModal above: the shell reads
// this and renders nothing when closed. Minimal shape — the assistant owns its own
// step state internally, so nothing but open/closed belongs here.
export const [planWeekModal, setPlanWeekModal] = createSignal<{ open: boolean }>({ open: false });

// ── Onboarding wizard step (FTUE · T11 shell / T12 external open) ──────────────
// T11's wizard originally kept `step` as a component-local signal (nothing outside
// it needed to move it). T12 adds the empty-state "Connect a source" CTA, which lives
// in Focus/Today/AllTasks — siblings of the wizard, not descendants — so the step
// needs to be store-level for `openOnboardingAt` to reach the already-mounted wizard
// and jump it to the Connect step. 5 steps: 1 identity, 2 time+place, 3 connect a
// source (T12), 4 trust dial, 5 run first sync (T12).
export const [onboardingStep, setOnboardingStep] = createSignal<1 | 2 | 3 | 4 | 5>(1);
// The wizard's own gate is `prefs().onboarded_at == null` — true only pre-completion.
// By the time a user can SEE an empty Focus/Today/Tasks view, onboarding has almost
// always already finished (any Skip, from any step, sets `onboarded_at`), so the
// gate alone can't reopen it. This flag lets `openOnboardingAt` force it back open
// regardless of `onboarded_at`; `completeOnboarding` clears it again on Finish/Skip.
export const [onboardingForceOpen, setOnboardingForceOpen] = createSignal(false);
// "Try with sample data" (ConnectSourceStep) should only appear during a genuine FTUE
// walkthrough — a real first run, or an explicit restart from Settings — not when a
// returning owner hits the empty-state "Connect" shortcut mid-usage. Both paths reuse
// the same wizard/step, so this needs its own signal rather than overloading
// `onboardingForceOpen`. Defaults true: a real first run (no forceOpen involved at all)
// and `openOnboardingAt` (restart) both want it visible.
export const [onboardingSampleDataAllowed, setOnboardingSampleDataAllowed] = createSignal(true);
/** Jump the (already-mounted, self-gating) onboarding wizard to `step`, reopening it
 *  if onboarding already completed — used by Settings' "Restart the First-Time
 *  Experience" (step 1). Sample data stays available; use `openQuickConnect` for the
 *  empty-state shortcut instead. */
export function openOnboardingAt(step: 1 | 2 | 3 | 4 | 5): void {
  setOnboardingStep(step);
  setOnboardingForceOpen(true);
}

/** Reopen the wizard straight at Connect (3), for the empty-state CTA in Today/Focus/
 *  AllTasks. Unlike `openOnboardingAt`, this is not a real FTUE run — it's a returning
 *  owner reconnecting a source mid-usage — so it hides "Try with sample data". */
export function openQuickConnect(): void {
  setOnboardingStep(3);
  setOnboardingForceOpen(true);
  setOnboardingSampleDataAllowed(false);
}

/** Delegates to the pure helper (client/src/lib/onboarding.ts) so callers don't have
 *  to import `integrations()` themselves just to ask "is there a source connected?" */
export const hasConnectedSource = () => pureHasConnectedSource(integrations());

/** FTUE · T12 — trigger the owner's ingest now and refresh everything it can fill.
 *  Shared by ConnectSourceStep's "Try with sample data" and RunFirstSyncStep's "Run
 *  my first sync now" — both are "run ingest, then show its effects" and nothing else. */
export async function runIngestNowAndRefetch(): Promise<RunNowOutcome[]> {
  const { ran } = await api.jobs.runNow();
  await Promise.all([refetchTasks(), refetchBlocks(), refetchFlightPlan(), refetchIntegrations()]);
  return ran;
}

// ── Repeating-item scope prompt ────────────────────────────────────────────────
// Changing or deleting ONE occurrence of a repeating item is ambiguous — the user may
// mean just that day, or that day and everything after it. Guessing is the one thing we
// must not do: guessing "just this" makes a series edit look like it silently failed,
// and guessing "following" destroys occurrences the user never mentioned. So we ask.
//
// Promise-shaped so a call site reads as a normal await in the middle of its handler,
// rather than being turned inside out into modal callbacks. The dialog itself is mounted
// once (App.tsx) and driven by this signal.

export interface RecurringScopeAsk {
  open: boolean;
  /** The item's title, shown so the user knows exactly what they're about to change. */
  title: string;
  /** Drives the wording — 'delete' reads very differently from 'change'. */
  verb: 'delete' | 'change';
  resolve?: (v: RecurringScope | null) => void;
}

export const [recurringScopeAsk, setRecurringScopeAsk] = createSignal<RecurringScopeAsk>({
  open: false,
  title: '',
  verb: 'change',
});

/** Ask which occurrences to act on. Resolves null when the user backs out. */
export function askRecurringScope(opts: { title: string; verb: 'delete' | 'change' }): Promise<RecurringScope | null> {
  return new Promise((resolve) => {
    setRecurringScopeAsk({ open: true, title: opts.title, verb: opts.verb, resolve });
  });
}

/** Answer the open prompt (or dismiss it with null). */
export function answerRecurringScope(v: RecurringScope | null): void {
  const cur = recurringScopeAsk();
  cur.resolve?.(v);
  setRecurringScopeAsk({ open: false, title: '', verb: 'change' });
}

/**
 * True when this row is one occurrence of a repeating series the app owns — the only
 * case where the question is meaningful.
 *
 * Calendar events mirrored from Google are deliberately NOT included: every occurrence
 * arrives as an independent block with no recurrence link, and they are read-only
 * server-side (updateBlock rejects them with `inbound_readonly`). Offering a series
 * choice for them would promise something the sync cannot deliver.
 */
export function isRecurringOccurrence(row: { recurrence_parent_id?: string | null }): boolean {
  return !!row.recurrence_parent_id;
}
