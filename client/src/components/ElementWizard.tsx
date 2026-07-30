import { createSignal, createEffect, createMemo, createResource, onMount, onCleanup, Show, For } from 'solid-js';
import {
  X, ChevronDown, ChevronLeft, ChevronRight, Plus, ListTodo, Flame, Boxes, Clock,
  Calendar, Timer, Flag, Lock, Repeat as RepeatIcon, Link2, Square, Sparkles, AlertTriangle, Search,
  Check as CheckIcon,
} from 'lucide-solid';
import { MicButton } from './MicButton.js';
import {
  elementModal, setElementModal, tags, blocks, concepts, tasks, patterns, patternTypes, categoryPrefs, prefs, showToast,
  refetchBlocks, refetchTasks, refetchFlightPlan,
  type ElementKind,
} from '../stores/index.js';
import {
  patternTagList, patternDefaultMinutes, rankedSecondaryTags,
  nextHalfHour, saveElement, splitBlockTag, mergeTagNames, isoAt, type ElementForm,
} from '../lib/element.js';
import { sortCategories, displayTag } from '../lib/tag-tax.js';
import { PATTERN_COLORS, colorVar } from '../lib/pattern-meta.js';
import { localISODate, shortDate, clockLabel, addDays, monthGridOf } from '../lib/dates.js';
import { buildRule, rulePreset, describeRule, WEEKDAYS, DAY_INITIAL, type RepeatPreset } from '../lib/recurrence.js';
import { proposeSlot, narrowToBand } from '../lib/propose-slot.js';
import { findSimilarTasks } from '../lib/similar-tasks.js';
import { inheritedBlockTag } from '../lib/planner.js';
import { api, type Task } from '../lib/api.js';

const TB_REPEAT: RepeatPreset[] = ['none', 'daily', 'weekly', 'custom'];
const TASK_REPEAT: RepeatPreset[] = ['none', 'daily', 'weekly', 'custom'];
const HABIT_REPEAT: RepeatPreset[] = ['daily', 'weekly', 'custom'];
const repeatLabel = (p: RepeatPreset) => (p === 'none' ? 'Once' : p[0].toUpperCase() + p.slice(1));

// ── Wall-clock helpers (HH:MM ↔ minutes-of-day) ────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const hhmmToMin = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const minToHHMM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const fmtDur = (min: number) => {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

// ── Timeline geometry — 5:00–23:00 with the working window (9:00–18:00) zoomed 3×
// so a drag lands on quarter-hours where scheduling actually happens. Positions are
// FRACTIONS of the container height (render as %), so the same math serves the
// desktop and mobile heights; drags convert back through the container rect.
const DAY_START = 300, WORK_START = 540, WORK_END = 1080, DAY_END = 1380, TL_ZOOM = 3;
const TL_TOTAL = (WORK_START - DAY_START) + (DAY_END - WORK_END) + (WORK_END - WORK_START) * TL_ZOOM;
function minutesToFrac(m: number): number {
  m = Math.max(DAY_START, Math.min(DAY_END, m));
  const u = 1 / TL_TOTAL;
  if (m <= WORK_START) return (m - DAY_START) * u;
  if (m <= WORK_END) return (WORK_START - DAY_START) * u + (m - WORK_START) * u * TL_ZOOM;
  return (WORK_START - DAY_START) * u + (WORK_END - WORK_START) * u * TL_ZOOM + (m - WORK_END) * u;
}
function fracToMinutes(f: number): number {
  const u = 1 / TL_TOTAL;
  const seg1 = (WORK_START - DAY_START) * u;
  const seg2 = (WORK_END - WORK_START) * u * TL_ZOOM;
  f = Math.max(0, Math.min(1, f));
  if (f <= seg1) return DAY_START + f / u;
  if (f <= seg1 + seg2) return WORK_START + (f - seg1) / (u * TL_ZOOM);
  return WORK_END + (f - seg1 - seg2) / u;
}
const HOUR_LINES = [6, 8, 10, 12, 14, 16, 18, 20, 22].map((h) => ({
  frac: minutesToFrac(h * 60),
  label: h === 12 ? '12p' : h > 12 ? `${h - 12}p` : `${h}a`,
}));
const TIME_SLOTS: number[] = []; for (let t = 360; t <= 1320; t += 30) TIME_SLOTS.push(t);
const DURATION_SLOTS: number[] = []; for (let d = 15; d <= 120; d += 15) DURATION_SLOTS.push(d);
const snap15 = (m: number) => Math.round(m / 15) * 15;
const clampDay = (m: number) => Math.max(DAY_START, Math.min(DAY_END - 15, m));

type PopoverName =
  | 'defer' | 'depends' | 'repeat' | 'routine'      // task utility row
  | 'due'                                           // due-flag popover (day row)
  | 'time' | 'duration'                             // chip dropdowns
  | null;

/**
 * The unified Add/Edit Element modal (redesign, July 2026). Segmented Task /
 * Time Block (/ Routine, flag-gated) tabs replace the Stage-0 type chooser;
 * identity sits in the left pane and scheduling in the right (stacked on
 * mobile). Utility fields are icon-first chips opening popovers that close on
 * outside click, and the right pane carries day chips + a month calendar, a
 * due flag whose value always reacts to the start day, time/duration chips
 * with quick-nudge presets and slot dropdowns (plus native "Custom…" escapes),
 * and a draggable timeline over the day's real blocks. Driven by the global
 * `elementModal` signal.
 */
export function ElementWizard() {
  const m = elementModal;
  const open = () => m().open;
  // The store's kind ('habit' folds into the Task tab; null defaults to Task).
  const kind = (): ElementKind => m().kind ?? 'task';
  const tab = (): 'task' | 'timeblock' | 'routine' => (kind() === 'habit' ? 'task' : (kind() as 'task' | 'timeblock' | 'routine'));
  const isEdit = () => m().mode === 'edit';

  // ── Shared form state ──────────────────────────────────────────────────────
  const [title, setTitle] = createSignal('');
  const [primary, setPrimary] = createSignal('');
  const [intentions, setIntentions] = createSignal<string[]>([]);
  const [tagDraft, setTagDraft] = createSignal('');
  const [llm, setLlm] = createSignal<string[]>([]);
  // scheduling / type-specific
  const [day, setDay] = createSignal(localISODate());
  const [start, setStart] = createSignal(nextHalfHour());
  const [durMin, setDurMin] = createSignal(60);
  const [someday, setSomeday] = createSignal(false);
  const [goalDay, setGoalDay] = createSignal(localISODate());
  const [scheduledFor, setScheduledFor] = createSignal(localISODate());
  const [estimate, setEstimate] = createSignal(30);
  const [dueAt, setDueAt] = createSignal('');
  // AD3 — default Due = Start. Until the user edits Due, it mirrors Start; once edited,
  // it stays put. Reset on each open (in the seed effect) AND whenever the user picks a
  // new start day (redesign: "due always reacts to the start selection").
  const [dueEdited, setDueEdited] = createSignal(false);
  const [priority, setPriority] = createSignal(3);
  // task/habit recurrence + extras
  const [taskRepeat, setTaskRepeat] = createSignal<RepeatPreset>('none');
  const [taskWeekdays, setTaskWeekdays] = createSignal<string[]>([]);
  const [taskCustomRule, setTaskCustomRule] = createSignal('');
  const [taskTime, setTaskTime] = createSignal('');
  const [deferUntil, setDeferUntil] = createSignal('');
  const [dependsOn, setDependsOn] = createSignal<string[]>([]);
  const [editScope, setEditScope] = createSignal<'instance' | 'series'>('instance');
  const [wasRecurring, setWasRecurring] = createSignal(false);
  // time-block: note + recurrence (AF-9: secondary tags round-trip through the
  // shared `intentions` chips — no separate blind-preserve signal anymore)
  const [note, setNote] = createSignal('');
  const [noteExpanded, setNoteExpanded] = createSignal(false);
  const [tbRepeat, setTbRepeat] = createSignal<RepeatPreset>('none');
  const [tbWeekdays, setTbWeekdays] = createSignal<string[]>([]);
  const [tbCustomRule, setTbCustomRule] = createSignal('');
  // Phase B (0134): 1–3 categories, tasks AND blocks; array order = stripe order.
  const [categoryIds, setCategoryIds] = createSignal<string[]>([]);
  // Phase B (0135): per-element texture override (on by default; null colour = derive).
  const [textureEnabled, setTextureEnabled] = createSignal(true);
  const [textureColorToken, setTextureColorToken] = createSignal<string | null>(null);
  // Motivation (0141, §3b): who the work is for. `motivationTouched` is the testimony
  // gate — only a user interaction sends the field on save, so an unrelated edit never
  // re-stamps a machine ('llm') label as user's. Source is display-only ("suggested").
  const [motivation, setMotivation] = createSignal<'me' | 'us' | 'them' | null>(null);
  const [motivationSource, setMotivationSource] = createSignal<'user' | 'llm' | null>(null);
  const [motivationTouched, setMotivationTouched] = createSignal(false);
  const [locked, setLocked] = createSignal(false);
  const [allDay, setAllDay] = createSignal(false);
  const [depDraft, setDepDraft] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [makeHabit, setMakeHabit] = createSignal(false);
  // T14 (#350) — the header NL quick line (see parseNl below).
  const [nlText, setNlText] = createSignal('');
  const [nlBusy, setNlBusy] = createSignal(false);
  const [nlLlm, setNlLlm] = createSignal(false);
  const [nlError, setNlError] = createSignal<string | null>(null);

  // D5 — suggest-only subtask brainstorm. `ideas` is what the model offered; `picked` is
  // what the USER tapped. Only `picked` is ever created (saveElement → subtaskTitles), so
  // an ignored suggestion leaves no trace. Both reset with the modal.
  const [subtaskIdeas, setSubtaskIdeas] = createSignal<string[]>([]);
  const [pickedSubtasks, setPickedSubtasks] = createSignal<string[]>([]);
  const [subtaskBusy, setSubtaskBusy] = createSignal(false);
  const [timeHint, setTimeHint] = createSignal<string | null>(null);
  const togglePicked = (t: string) =>
    setPickedSubtasks((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  // Search-existing-tasks mode (calendar-click ask): the "Describe it" line toggles
  // into a task search bar. Picking a result schedules that EXISTING task at the
  // wizard's current day/time instead of composing a new one — same placement the
  // flight-plan drag-to-grid path uses (api.blocks.create with task_id set), just
  // reachable without a drag gesture.
  const [taskSearchMode, setTaskSearchMode] = createSignal(false);
  const [taskQuery, setTaskQuery] = createSignal('');
  const [schedulingId, setSchedulingId] = createSignal<string | null>(null);
  // Routine chip — single-select membership (add + edit).
  const [routineId, setRoutineId] = createSignal('');
  const [initialRoutineId, setInitialRoutineId] = createSignal('');
  // time-block membership: search-to-add tasks/habits/routines + staged removals (edit)
  const [attachDraft, setAttachDraft] = createSignal('');
  const [attachItems, setAttachItems] = createSignal<{ kind: 'task' | 'habit' | 'routine'; id: string; label: string }[]>([]);
  const [removedMemberIds, setRemovedMemberIds] = createSignal<string[]>([]);
  // popover machinery
  const [popover, setPopover] = createSignal<PopoverName>(null);
  const [calendarOpen, setCalendarOpen] = createSignal(false);
  const [calTarget, setCalTarget] = createSignal<'start' | 'due'>('start');
  const [calMonth, setCalMonth] = createSignal(localISODate().slice(0, 8) + '01');
  const [dragging, setDragging] = createSignal(false);

  const togglePopover = (name: Exclude<PopoverName, null>) => setPopover(popover() === name ? null : name);

  // Habit implies recurrence — default a freshly-chosen habit to daily.
  createEffect(() => { if (kind() === 'habit' && taskRepeat() === 'none') setTaskRepeat('daily'); });
  // Reset makeHabit when repeat is cleared.
  createEffect(() => { if (taskRepeat() === 'none') setMakeHabit(false); });
  // AD3 — mirror Start → Due until the user edits Due. Reads scheduledFor so it re-runs
  // on every Start change; guarded by dueEdited() so a user-set Due is never overwritten.
  createEffect(() => { const s = scheduledFor(); if (!dueEdited()) setDueAt(s); });
  const currentTaskRule = () => buildRule(taskRepeat(), taskWeekdays(), taskCustomRule());
  const toggleWeekday = (d: string) => setTaskWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]));
  // T-TB-1: Time-Block weekly recurrence — its own weekday set, mirroring the task path.
  const currentTbRule = () => buildRule(tbRepeat(), tbWeekdays(), tbCustomRule());
  const toggleTbWeekday = (d: string) => setTbWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]));
  // Category picker (Phase B): 1–3 multi-select on BOTH tabs (was single, block-only).
  // Selection order is preserved — it becomes entity_categories.position (stripe order).
  const categoryOptions = () => sortCategories((tags() ?? []).filter((t) => t.kind === 'category'));
  function toggleCategory(id: string) {
    const cur = categoryIds();
    if (cur.includes(id)) { setCategoryIds(cur.filter((x) => x !== id)); return; }
    if (cur.length >= 3) return; // cap 3 — mirrors setEntityCategories
    setCategoryIds([...cur, id]);
    // First pick prefills the block length from the category's default (0069 behavior).
    if (cur.length === 0) {
      const p = categoryPrefs()?.prefs?.[id];
      if (p?.default_minutes) setDurMin(p.default_minutes);
    }
  }
  /** Selected category ids → names (position order) for the save payload. */
  const categoryNames = () =>
    categoryIds().map((id) => (tags() ?? []).find((t) => t.id === id)?.name).filter((n): n is string => !!n);
  const candidateTasks = () => (tasks() ?? []).filter((t) => t.status === 'open' && t.id !== m().editTarget?.id);

  // T-DEP-1: "Depends on" task search — typeahead over open tasks (excludes self +
  // anything already picked); selections render as removable chips.
  const taskById = (id: string) => (tasks() ?? []).find((t) => t.id === id);
  const depSuggestions = () => {
    const q = depDraft().trim().toLowerCase();
    if (!q) return [];
    const taken = new Set(dependsOn());
    return candidateTasks().filter((t) => !taken.has(t.id) && t.title.toLowerCase().includes(q)).slice(0, 6);
  };
  const addDep = (id: string) => { if (!dependsOn().includes(id)) setDependsOn([...dependsOn(), id]); setDepDraft(''); };
  const removeDep = (id: string) => setDependsOn(dependsOn().filter((x) => x !== id));

  // Phase Z · Z6 — suggest-only estimate nudge. Fetch once when editing an
  // existing task/habit with Time-Sense on; the endpoint 404s (→ null) when the
  // flag is off, so no chip ever shows in the default build. Accept sets the
  // estimate field (the human write happens on Save); dismiss clears it.
  const [estimateSuggestion, { mutate: mutateSuggestion }] = createResource(
    () =>
      open() && m().mode === 'edit' && !!prefs()?.time_sense_enabled &&
      prefs()?.calibration_loop_enabled !== false && // Z5: the calibration nudge has its own channel gate
      (m().editTarget?.kind === 'task' || m().editTarget?.kind === 'habit') && m().editTarget?.id
        ? m().editTarget!.id
        : null,
    (taskId) => api.calibration.suggest(taskId).then((r) => r.suggestion).catch(() => null),
  );

  // ── Time-block membership: add existing tasks/habits/routines, manage current ones ──
  const enableRoutines = () => !!prefs()?.enable_routines;
  const routineTypeId = () => (patternTypes() ?? []).find((t) => t.name === 'Routine')?.id;
  const routineList = () => {
    const rid = routineTypeId();
    return rid ? (patterns() ?? []).filter((p) => p.type_id === rid) : [];
  };
  // The block being edited's current child blocks, minus anything staged for removal.
  const existingMembers = () => {
    const tid = m().editTarget?.id;
    if (m().mode !== 'edit' || !tid) return [];
    const removed = new Set(removedMemberIds());
    return (blocks() ?? []).filter((b) => b.parent_block_id === tid && !removed.has(b.id));
  };
  // Typeahead over open tasks + habit templates, and (when enabled) Routine patterns;
  // excludes self, already-staged, and tasks already inside the block.
  const attachSuggestions = () => {
    const q = attachDraft().trim().toLowerCase();
    if (!q) return [];
    const takenTasks = new Set(attachItems().filter((i) => i.kind !== 'routine').map((i) => i.id));
    const takenRoutines = new Set(attachItems().filter((i) => i.kind === 'routine').map((i) => i.id));
    const memberTaskIds = new Set(existingMembers().map((b) => b.task_id).filter(Boolean) as string[]);
    // Non-terminal tasks + habit templates (not instances/subtasks). Mirrors the server's
    // skip rule so we never offer something `placeTasksInBlock` would reject.
    const taskHits = (tasks() ?? [])
      .filter((t) => !t.parent_id && !t.recurrence_parent_id
        && !['done', 'completed', 'skipped', 'cancelled', 'missed'].includes(t.status)
        && !takenTasks.has(t.id) && !memberTaskIds.has(t.id) && t.title.toLowerCase().includes(q))
      .map((t) => ({ kind: (t.is_habit ? 'habit' : 'task') as 'habit' | 'task', id: t.id, label: t.title }));
    const rid = routineTypeId();
    const routineHits = enableRoutines() && rid
      ? (patterns() ?? []).filter((p) => p.type_id === rid && !takenRoutines.has(p.id) && p.name.toLowerCase().includes(q))
          .map((p) => ({ kind: 'routine' as const, id: p.id, label: p.name }))
      : [];
    return [...taskHits, ...routineHits].slice(0, 8);
  };
  const addAttach = (item: { kind: 'task' | 'habit' | 'routine'; id: string; label: string }) => {
    if (!attachItems().some((i) => i.kind === item.kind && i.id === item.id)) setAttachItems([...attachItems(), item]);
    setAttachDraft('');
  };
  const removeAttach = (id: string) => setAttachItems(attachItems().filter((i) => i.id !== id));
  const removeMember = (id: string) => setRemovedMemberIds([...removedMemberIds(), id]);
  const attachIcon = (k: 'task' | 'habit' | 'routine') => (k === 'routine' ? Boxes : k === 'habit' ? Flame : ListTodo);

  function close() {
    setElementModal({ open: false, mode: 'add', kind: null });
  }

  // ── Popover dismissal: outside click + Escape ──────────────────────────────
  let utilityEl: HTMLDivElement | undefined;
  let dayEl: HTMLDivElement | undefined;
  let timeEl: HTMLDivElement | undefined;
  let durEl: HTMLDivElement | undefined;
  const regionFor = (p: Exclude<PopoverName, null>): HTMLElement | undefined =>
    p === 'due' ? dayEl
    : p === 'time' ? timeEl
    : p === 'duration' ? durEl
    : utilityEl;
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (!open()) return;
      const t = e.target as Node;
      const p = popover();
      if (p && !regionFor(p)?.contains(t)) setPopover(null);
      if (calendarOpen() && !dayEl?.contains(t)) setCalendarOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!open() || e.key !== 'Escape') return;
      if (popover() || calendarOpen()) { setPopover(null); setCalendarOpen(false); }
      else close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    });
  });

  // ── Seed on the closed→open edge (not on kind change, so shared fields persist
  //    when the user switches tabs). ────────────────────────────────────────────
  let wasOpen = false;
  createEffect(() => {
    const st = m();
    if (st.open && !wasOpen) {
      const pf = st.prefill ?? {};
      setTitle(''); setPrimary(''); setIntentions([]); setTagDraft(''); setLlm([]);
      setNlText(''); setNlBusy(false); setNlLlm(false); setNlError(null);
      setSubtaskIdeas([]); setPickedSubtasks([]); setSubtaskBusy(false); setTimeHint(null);
      setDay(pf.day || localISODate());
      setStart(pf.start || nextHalfHour());
      setDurMin(pf.durationMin ?? 60);
      setSomeday(false); setGoalDay(localISODate());
      // A calendar empty-slot click prefills day+time; for a TASK those map to its own
      // schedule fields (scheduled_for / task_time) so Save places it at that instant.
      // Add-mode only — Edit seeds from the target below.
      setScheduledFor(pf.day || localISODate()); setTaskTime(pf.start || '');
      // AD3 — default Due = Start on open; mirror until the user edits Due.
      setEstimate(30); setDueAt(pf.day || localISODate()); setDueEdited(false); setPriority(3);
      setTaskRepeat('none'); setTaskWeekdays([]); setTaskCustomRule('');
      setDeferUntil(''); setDependsOn([]); setDepDraft(''); setEditScope('instance'); setWasRecurring(false);
      setNote(''); setNoteExpanded(false); setTbRepeat('none'); setTbWeekdays([]); setTbCustomRule(''); setCategoryIds([]); setMakeHabit(false);
      setTextureEnabled(true); setTextureColorToken(null);
      setMotivation(null); setMotivationSource(null); setMotivationTouched(false);
      setLocked(false); setAllDay(false); setRoutineId(''); setInitialRoutineId('');
      setAttachDraft(''); setAttachItems([]); setRemovedMemberIds([]);
      setPopover(null); setCalendarOpen(false); setCalTarget('start');
      setCalMonth((pf.day || localISODate()).slice(0, 8) + '01');
      if (st.mode === 'edit' && st.editTarget) loadForEdit(st.editTarget.kind, st.editTarget.id);
    }
    wasOpen = st.open;
  });

  function loadForEdit(k: ElementKind, id: string) {
    if (k === 'timeblock') {
      const b = (blocks() ?? []).find((x) => x.id === id) ?? (concepts() ?? []).find((x) => x.id === id);
      if (!b) return;
      setTitle(b.title);
      // AF-9: primary = FIRST segment of the stored tag (legacy rows may be
      // comma-joined); remaining segments + the block's existing level-2
      // secondary_tags round-trip into the chips. Write-time normalization:
      // the next save sends tag=primary + secondary_tags (no data migration).
      const { primary: prim, secondary } = splitBlockTag(b.tag);
      setPrimary(prim);
      setIntentions(mergeTagNames(secondary, b.secondary_tags).filter((n) => n.toLowerCase() !== prim.toLowerCase()));
      setNote(b.note ?? ''); setNoteExpanded(!!b.note);
      seedCategories(b.categories ?? []);
      setTextureEnabled(b.texture_enabled ?? true);
      setTextureColorToken(b.texture_color_token ?? null);
      setLocked(!!b.is_locked);
      const ps = rulePreset(b.recurrence_rule);
      setTbRepeat(TB_REPEAT.includes(ps.preset) ? ps.preset : 'custom');
      setTbWeekdays(ps.weekdays);
      setTbCustomRule(b.recurrence_rule ?? '');
      if (b.block_type === 'someday') {
        setSomeday(true); setGoalDay(b.goal_start_date ?? localISODate());
        setDurMin(b.duration_minutes ?? 60);
      } else {
        setAllDay(!!b.all_day);
        const s = new Date(b.start_at);
        setDay(localISODate(s)); setStart(`${pad(s.getHours())}:${pad(s.getMinutes())}`);
        setDurMin(Math.max(Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000), 15));
        setCalMonth(localISODate(s).slice(0, 8) + '01');
      }
    } else if (k === 'task' || k === 'habit') {
      const t = (tasks() ?? []).find((x) => x.id === id);
      if (!t) return;
      setTitle(t.title);
      seedTags(t.tags ?? [], t.secondary_tags ?? []);
      seedCategories(t.categories ?? []);
      setTextureEnabled(t.texture_enabled ?? true);
      setTextureColorToken(t.texture_color_token ?? null);
      setMotivation(t.motivation ?? null);
      setMotivationSource(t.motivation_source ?? null);
      setMotivationTouched(false); // seeded, not testimony — only a tap makes it send
      setNote(t.notes ?? ''); setNoteExpanded(!!t.notes);
      setScheduledFor(t.scheduled_for ?? localISODate());
      setTaskTime(t.task_time ?? '');
      setEstimate(t.estimated_minutes ?? 30);
      setDueAt(t.due_at ? t.due_at.slice(0, 10) : '');
      setDueEdited(true); // edit: keep the saved Due; don't let the Start→Due mirror clobber it
      setPriority(t.priority ?? 3);
      setDeferUntil(t.defer_until ? t.defer_until.slice(0, 10) : '');
      setDependsOn(t.depends_on ?? []);
      const ps = rulePreset(t.recurrence_rule);
      setTaskRepeat(ps.preset); setTaskWeekdays(ps.weekdays); setTaskCustomRule(ps.custom);
      setWasRecurring(!!(t.recurrence_rule || t.recurrence_parent_id));
      setEditScope('instance');
      setCalMonth((t.scheduled_for ?? localISODate()).slice(0, 8) + '01');
      // Routine chip seed: first Routine pattern containing this task.
      const r = routineList().find((p) => p.task_ids.includes(id));
      setRoutineId(r?.id ?? ''); setInitialRoutineId(r?.id ?? '');
    }
  }
  // Seed primary + intention chips from a task's saved tags. AF-11: `names` is the
  // level-1 list (post-split: just the direction; legacy rows: the old flat set) and
  // `secondary` is the level-2 intentions — fold BOTH into the chips so an edit
  // round-trips them (an unseeded chip set would save secondary_tags: [] and wipe L2).
  /** Seed the category picker from the server's `categories` names (position order). */
  function seedCategories(names: string[]) {
    const all = tags() ?? [];
    setCategoryIds(names
      .map((n) => all.find((t) => t.kind === 'category' && t.name.toLowerCase() === n.toLowerCase())?.id)
      .filter((id): id is string => !!id));
  }
  function seedTags(names: string[], secondary: string[] = []) {
    const patternNames = new Set(patternTagList().map((p) => p.name.toLowerCase()));
    const prim = names.find((n) => patternNames.has(n.toLowerCase()));
    setPrimary(prim ?? '');
    setIntentions(mergeTagNames(names.filter((n) => n !== prim), secondary)
      .filter((n) => n.toLowerCase() !== (prim ?? '').toLowerCase()));
  }

  // ── Tag interactions ────────────────────────────────────────────────────────
  function pickPrimary(name: string) {
    const next = primary().toLowerCase() === name.toLowerCase() ? '' : name;
    setPrimary(next);
    // Direction drives the default duration (redesign): estimate + block length.
    if (next) { setDurMin(patternDefaultMinutes(next)); setEstimate(patternDefaultMinutes(next)); }
  }

  // ── T14 (#350) — NL quick line (type or speak) → parse-only PREVIEW ──────────
  // Moved here from the Today view's top-of-page QuickAdd (UI-comments 2026-07-20):
  // the FAB modal is now the one add surface. Unlike the old QuickAdd this NEVER
  // creates on Enter — it calls the zero-write /tasks/quick/parse twin and hydrates
  // the wizard's own fields, so the populated form IS the preview and the Add button
  // is the approval (same preview→confirm doctrine as InstructBox / #387). Works
  // without Ollama (deterministic parse; `llm` truthfully marks AI enrichment).
  //
  // Tab-aware: the same task grammar (chrono + tags + ~Nm) drives a Time Block too —
  // title, day, START (block start vs task_time), duration (durMin vs estimate), and
  // direction map cleanly; priority is task-only.
  async function parseNl(raw?: string) {
    const value = (raw ?? nlText()).trim();
    if (!value || nlBusy()) return;
    setNlError(null);
    setNlBusy(true);
    const isBlock = tab() === 'timeblock';
    try {
      const { parsed, llm } = await api.tasks.quickParse(value);
      setNlLlm(llm);
      // Hydrate the form fields — every value below is visible in the wizard for
      // review/correction before Add.
      setTitle(parsed.title);
      if (parsed.scheduledFor) { if (isBlock) setDay(parsed.scheduledFor); else setScheduledFor(parsed.scheduledFor); }
      if (parsed.taskTime) { if (isBlock) setStart(parsed.taskTime); else setTaskTime(parsed.taskTime); }
      // Priority: task only — the parse/enrichment value, else P1 (owner rule: a
      // captured task is important until the user says otherwise — never a silent P3).
      if (!isBlock) setPriority(parsed.priority ?? 1);
      // Known direction names land on the primary axis, first one wins (mirrors the
      // /tasks/quick route's splitNamesByDirection); the rest become intention chips.
      const dirNames = new Set(patternTagList().map((t) => t.name.toLowerCase()));
      const dirs = parsed.tags.filter((t) => dirNames.has(t.toLowerCase()));
      const others = parsed.tags.filter((t) => !dirNames.has(t.toLowerCase()));
      if (dirs.length) {
        setPrimary(dirs[0]);
        const def = patternDefaultMinutes(dirs[0]);
        if (isBlock) setDurMin(def); else { setDurMin(def); setEstimate(def); }
      }
      if (others.length || dirs.length > 1) setIntentions([...new Set([...dirs.slice(1), ...others])]);
      // Phase B: the classifier's best-guess categories seed the picker (best fit
      // first = position 0 = first stripe) — reviewable chips, like every NL field.
      if (parsed.categories?.length) seedCategories(parsed.categories);
      // Motivation (0141): the overlay's pick seeds as SUGGESTED (source 'llm', not
      // touched) — the user's Add is approval of the task, not testimony about who
      // it's for; only tapping the control itself makes it user's.
      if (parsed.motivation) { setMotivation(parsed.motivation); setMotivationSource('llm'); setMotivationTouched(false); }
      // An explicit ~Nm beats the direction's default duration (applied after).
      if (parsed.estimatedMinutes != null) { if (isBlock) setDurMin(parsed.estimatedMinutes); else setEstimate(parsed.estimatedMinutes); }
      // dueAt: untouched — the Due=Start mirror keeps it on the scheduled day, which
      // matches the parse (AD1 dueAt is only ever the same timed day).

      // No explicit time → PROPOSE one: the first open workday gap on the target day
      // lands in the START field + mini timeline for approval (drag/nudge to change,
      // Add to accept). Preview-only — nothing is written until Add. The busy list
      // comes from the loaded blocks store, which may not cover a far-off day; the
      // server re-validates placement at create time anyway.
      if (!parsed.taskTime) {
        const targetDay = parsed.scheduledFor ?? (isBlock ? day() : scheduledFor());
        const dur = parsed.estimatedMinutes ?? (dirs.length ? patternDefaultMinutes(dirs[0]) : (isBlock ? durMin() : estimate()));
        const busy = (blocks() ?? [])
          .filter((b) => b.block_type !== 'someday' && !b.all_day && b.status !== 'cancelled'
            && localISODate(new Date(b.start_at)) === targetDay)
          .map((b) => {
            const s = new Date(b.start_at);
            const startMin = s.getHours() * 60 + s.getMinutes();
            return { startMin, endMin: startMin + Math.max(Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000), 15) };
          });
        const now = new Date();
        const isToday = targetDay === localISODate();
        const nowMin = isToday ? now.getHours() * 60 + now.getMinutes() : null;
        const workStartMin = hhmmToMin(prefs()?.workday_start ?? '09:00') ?? 540;
        const workEndMin = hhmmToMin(prefs()?.workday_end ?? '18:00') ?? 1080;
        // D3: bias the search to the enrichment's best-time band. narrowToBand hands the
        // full window back when the band can't fit, so a hint never costs a proposal.
        const band = narrowToBand({ startMin: workStartMin, endMin: workEndMin }, parsed.timeOfDay === 'any' ? undefined : parsed.timeOfDay, dur);
        const slot =
          proposeSlot({ busy, durationMin: dur, workStartMin: band.startMin, workEndMin: band.endMin, nowMin }) ??
          // Band came up empty against real busy spans — retry the whole workday before
          // giving up, so the preference degrades to "any open slot", not "No time".
          proposeSlot({ busy, durationMin: dur, workStartMin, workEndMin, nowMin }) ??
          // Evening capture: today's workday window is already over (or full), but the
          // day isn't — still propose the next open quarter-hour before midnight, so an
          // 8pm "call mom" previews 8:15pm instead of "No time".
          (isToday ? proposeSlot({ busy, durationMin: dur, workStartMin, workEndMin: 24 * 60 - 5, nowMin }) : null);
        if (slot) { if (isBlock) setStart(slot); else setTaskTime(slot); }
      }

      // D3 — show WHY that band was chosen, so the proposed time reads as a suggestion
      // with a reason rather than an unexplained jump. Display-only; never persisted.
      setTimeHint(
        parsed.timeOfDay && parsed.timeOfDay !== 'any'
          ? `Best ${parsed.timeOfDay}${parsed.timeOfDayReason ? ` — ${parsed.timeOfDayReason}` : ''}`
          : null,
      );

      // D5 — brainstorm subtasks ONLY when the classifier called the task complex, and
      // only for a new task. Fire-and-forget: the chips arrive when they arrive, and a
      // failure leaves the wizard exactly as it was.
      setSubtaskIdeas([]); setPickedSubtasks([]);
      if (!isBlock && !isEdit() && parsed.isComplex) {
        setSubtaskBusy(true);
        api.tasks
          .suggestSubtasks(parsed.title, nlText())
          .then(({ subtasks }) => { if (title() === parsed.title) setSubtaskIdeas(subtasks); })
          .catch(() => { /* offline → no chips, no error surfaced */ })
          .finally(() => setSubtaskBusy(false));
      }
    } catch (err) {
      setNlError((err as Error).message);
    } finally {
      setNlBusy(false);
    }
  }

  // Duplicate guard (UI-comments 2026-07-20): existing tasks whose title is close to
  // the one being composed. Task add-mode only; a tap opens the match instead of
  // creating a near-dup. Reactive on the title so it tracks typing + a parse.
  const similarTasks = createMemo(() =>
    tab() === 'task' && !isEdit() ? findSimilarTasks(title(), tasks() ?? []) : [],
  );
  function openSimilar(id: string) {
    // Close then reopen on the next tick so the seed effect's closed→open edge fires
    // and loadForEdit hydrates the tapped task — switching editTarget on an already-open
    // modal would keep the composed add-mode values (the effect guards on !wasOpen).
    setElementModal({ open: false, mode: 'add', kind: null });
    queueMicrotask(() => setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id } }));
  }

  // Task-search results — client-side over the already-loaded list (same approach as
  // the Tasks view's always-visible search), title + tag names, archived excluded (an
  // existing done/cancelled task isn't something you'd schedule). Capped so the popover
  // stays a glance, not a second Tasks list.
  const taskSearchResults = createMemo(() => {
    const q = taskQuery().trim().toLowerCase();
    if (!q) return [];
    const archived = new Set(['done', 'cancelled']);
    return (tasks() ?? [])
      .filter((t) => !archived.has(t.status))
      .filter((t) => t.title.toLowerCase().includes(q)
        || [...(t.tags ?? []), ...(t.secondary_tags ?? [])].some((n) => n.toLowerCase().includes(q)))
      .slice(0, 8);
  });

  /** Schedule an EXISTING task at the wizard's current day/time — mirrors the
   *  flight-plan drag-to-grid placement (Planner.tsx createBlockAt): a real block
   *  bound to task_id, never a new task. Closes the wizard on success, same as
   *  picking a similar-task match does. */
  async function scheduleExisting(t: Task) {
    if (schedulingId()) return;
    setSchedulingId(t.id);
    try {
      const startMin = barStartMin() ?? hhmmToMin(nextHalfHour()) ?? 540;
      const dur = t.estimated_minutes || barDurMin() || 30;
      const startAt = isoAt(selDay(), minToHHMM(startMin));
      const endAt = new Date(Date.parse(startAt) + dur * 60_000).toISOString();
      const tag = inheritedBlockTag(t);
      await api.blocks.create({
        title: t.title, block_kind: 'task', task_id: t.id,
        ...(tag ? { tag } : {}), start_at: startAt, end_at: endAt,
      });
      try { await api.flightPlan.remove(t.id); refetchFlightPlan(); } catch { /* wasn't staged — fine */ }
      refetchBlocks(); refetchTasks();
      showToast(`Scheduled "${t.title}"`, 'success');
      close();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSchedulingId(null);
    }
  }
  function addIntention(name: string) {
    const n = name.replace(/^#/, '').trim();
    if (!n || n.toLowerCase() === primary().toLowerCase()) return;
    if (intentions().some((x) => x.toLowerCase() === n.toLowerCase())) return;
    setIntentions([...intentions(), n]);
    setTagDraft('');
  }
  const removeIntention = (name: string) => setIntentions(intentions().filter((x) => x !== name));

  const secondarySuggestions = () =>
    rankedSecondaryTags(title(), primary(), llm()).filter(
      (t) => !intentions().some((x) => x.toLowerCase() === t.name.toLowerCase()),
    );
  const tagSuggestions = () => {
    const q = tagDraft().trim().toLowerCase().replace(/^#/, '');
    if (!q) return [];
    const taken = new Set([primary().toLowerCase(), ...intentions().map((s) => s.toLowerCase())]);
    return (tags() ?? [])
      .filter((t) => t.kind === 'intention' && t.name.toLowerCase().includes(q) && !taken.has(t.name.toLowerCase()))
      .slice(0, 6);
  };

  // Debounced LLM tag refine — feeds the ranking; degrades to heuristic when down.
  let llmTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const t = title();
    clearTimeout(llmTimer);
    if (!t.trim() || !primary()) { setLlm([]); return; }
    llmTimer = setTimeout(async () => {
      try {
        const { tags: out } = await api.tasks.suggestTags(t);
        if (title() === t) setLlm(out);
      } catch { /* offline → heuristic only */ }
    }, 600);
  });

  // ── Day / due / calendar ────────────────────────────────────────────────────
  const dayOptions = () => {
    const today = localISODate();
    return [0, 1, 2, 3].map((i) => {
      const date = addDays(today, i);
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
        : new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      return { date, label };
    });
  };
  const fmtDayLabel = (date: string) => {
    const opt = dayOptions().find((o) => o.date === date);
    return opt ? opt.label : shortDate(date);
  };
  const selDay = () => (tab() === 'timeblock' ? day() : scheduledFor());
  const setSelDay = (d: string) => {
    if (tab() === 'timeblock') setDay(d);
    else {
      setScheduledFor(d);
      // Due reacts to the start date: a new start day clears any custom due
      // override so due falls back to "same as start" until re-picked.
      setDueEdited(false);
    }
  };
  const dayIsCustom = () => !dayOptions().some((o) => o.date === selDay());
  const dueDiffers = () => tab() === 'task' && dueEdited() && !!dueAt() && dueAt() !== scheduledFor();
  const pickDue = (d: string) => { setDueEdited(true); setDueAt(d); setPopover(null); };

  const calGrid = () => monthGridOf(calMonth());
  const calMonthLabel = () => new Date(calMonth() + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const moveCalMonth = (n: number) => {
    const [y, mo] = calMonth().split('-').map(Number);
    const d = new Date(y, mo - 1 + n, 1);
    setCalMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`);
  };
  const pickCalDate = (d: string) => {
    if (calTarget() === 'due') { setDueEdited(true); setDueAt(d); }
    else setSelDay(d);
    setCalendarOpen(false);
  };

  // Defer quick options (task).
  const deferOptions = () => {
    const today = localISODate();
    const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0=Sun
    const toSat = (6 - dow + 7) % 7 || 7;
    const toMon = (1 - dow + 7) % 7 || 7;
    return [
      { label: 'Tomorrow', date: addDays(today, 1) },
      { label: 'This weekend', date: addDays(today, toSat) },
      { label: 'Next week', date: addDays(today, toMon) },
    ];
  };

  // Someday-block target week chips → goal day.
  const targetWeekOptions = () => {
    const today = localISODate();
    const dow = new Date(today + 'T12:00:00Z').getUTCDay();
    const toMon = (1 - dow + 7) % 7 || 7;
    return [
      { label: 'This week', date: today },
      { label: 'Next week', date: addDays(today, toMon) },
      { label: 'Later', date: addDays(today, 28) },
    ];
  };

  // ── Time / duration (bar = the draggable timeline representation) ──────────
  const barStartMin = (): number | null =>
    tab() === 'timeblock' ? hhmmToMin(start()) : hhmmToMin(taskTime());
  const barDurMin = () => (tab() === 'timeblock' ? durMin() : estimate());
  const setBarStart = (min: number) => {
    const v = minToHHMM(clampDay(min));
    if (tab() === 'timeblock') setStart(v); else setTaskTime(v);
  };
  // Time blocks are clamped to a 15-minute floor on save (saveElement); tasks
  // (estimated_minutes) are not, so their floor is 5. Enforce the same floor HERE
  // so the displayed value never disagrees with what persists.
  const minDur = () => (tab() === 'timeblock' ? 15 : 5);
  const setBarDur = (min: number) => {
    const v = Math.max(minDur(), min);
    if (tab() === 'timeblock') setDurMin(v); else setEstimate(v);
  };
  const nudgeTime = (delta: number) => setBarStart((barStartMin() ?? hhmmToMin(nextHalfHour())!) + delta);
  const nudgeDur = (delta: number) => setBarDur(barDurMin() + delta);
  const timeChipLabel = () => {
    const b = barStartMin();
    return b === null ? 'No time' : clockLabel(minToHHMM(b));
  };

  // Ghost events — the selected day's real scheduled blocks (excluding the block
  // being edited and its members), so a drag lands relative to actual commitments.
  const ghostBlocks = () => {
    const d = selDay();
    const editingId = m().editTarget?.id;
    return (blocks() ?? [])
      .filter((b) => b.block_type !== 'someday' && !b.all_day
        && b.id !== editingId && b.parent_block_id !== editingId
        && b.status !== 'cancelled'
        && localISODate(new Date(b.start_at)) === d)
      .map((b) => {
        const s = new Date(b.start_at);
        const sMin = s.getHours() * 60 + s.getMinutes();
        const eMin = sMin + Math.max(Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000), 15);
        return { id: b.id, title: b.title, startMin: sMin, endMin: eMin };
      });
  };
  const barConflicts = (g: { startMin: number; endMin: number }) => {
    const s = barStartMin();
    if (s === null) return false;
    return g.startMin < s + barDurMin() && g.endMin > s;
  };

  let timelineEl: HTMLDivElement | undefined;
  const dragToMinutes = (clientY: number, grabOffsetPx: number) => {
    const rect = timelineEl!.getBoundingClientRect();
    return snap15(fracToMinutes((clientY - rect.top - grabOffsetPx) / rect.height));
  };
  const onBarPointerDown = (e: PointerEvent) => {
    if (!timelineEl) return;
    e.preventDefault(); e.stopPropagation();
    const rect = timelineEl.getBoundingClientRect();
    const s = barStartMin() ?? hhmmToMin(nextHalfHour())!;
    const grabOffset = e.clientY - (rect.top + minutesToFrac(s) * rect.height);
    setDragging(true);
    const move = (ev: PointerEvent) => setBarStart(dragToMinutes(ev.clientY, grabOffset));
    const up = () => { setDragging(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const onResizePointerDown = (e: PointerEvent) => {
    if (!timelineEl) return;
    e.preventDefault(); e.stopPropagation();
    const s = barStartMin() ?? hhmmToMin(nextHalfHour())!;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const endMin = dragToMinutes(ev.clientY, 0);
      setBarDur(Math.max(15, snap15(endMin - s)));
    };
    const up = () => { setDragging(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  // Click an empty timeline slot to place the bar there (gives no-time tasks a
  // one-click way in), then the same drag session continues.
  const onTimelinePointerDown = (e: PointerEvent) => {
    if (!timelineEl || e.target !== timelineEl) return;
    const rect = timelineEl.getBoundingClientRect();
    setBarStart(snap15(fracToMinutes((e.clientY - rect.top) / rect.height)));
  };

  const taskIsSomeday = () => tab() === 'task' && someday();
  const taskDeferred = () => tab() === 'task' && !!deferUntil();
  const timePaneMuted = () => taskIsSomeday() || taskDeferred();
  const timeMuteLabel = () => (taskIsSomeday() ? 'Someday — no schedule yet' : 'Deferred — hidden until later');
  const dimRightPane = () => taskIsSomeday() || taskDeferred() || (tab() === 'timeblock' && someday());
  const blockAllDayView = () => tab() === 'timeblock' && allDay() && !someday();

  // Progressive disclosure, add mode only: name the thing before configuring it.
  // Left pane needs a title; the right pane also needs a direction. Edit is exempt —
  // an existing task may legitimately have no direction, and gating would strand it.
  // A gated pane sets `inert` (blocks focus + keyboard, drops it from the a11y tree);
  // pointer-events-none is the mouse-only fallback for browsers without inert.
  const gateLeft = () => !isEdit() && tab() !== 'routine' && title().trim() === '';
  const gateRight = () => !isEdit() && tab() !== 'routine' && (title().trim() === '' || !primary());

  // ── Summary line ────────────────────────────────────────────────────────────
  const summaryText = () => {
    if (tab() === 'routine') return 'A named, reusable bundle of tasks';
    const dir = primary() || displayTag(categoryNames()[0] ?? '') || (tab() === 'task' ? 'Task' : 'Block');
    if (taskIsSomeday()) return `${dir} · Someday${intentions().length ? ' · ' + intentions().join(', ') : ''}`;
    if (tab() === 'timeblock' && someday()) return `${dir} · Someday · ${fmtDayLabel(goalDay())} · ${fmtDur(durMin())}`;
    if (blockAllDayView()) return `${dir} · ${fmtDayLabel(day())} · All-day`;
    const t = barStartMin();
    const dueBit = dueDiffers() ? ` · due ${fmtDayLabel(dueAt())}` : '';
    return `${dir} · ${fmtDayLabel(selDay())}${t !== null ? ' · ' + clockLabel(minToHHMM(t)) : ''} · ${fmtDur(barDurMin())}${dueBit}`;
  };

  async function doSave() {
    const k = kind();
    const effectiveKind = k === 'task' && makeHabit() ? 'habit' : k;
    setSaving(true);
    try {
      const form: ElementForm = {
        title: title(), primary: primary(), intentions: intentions(),
        note: note() || undefined,
        day: day(), start: start(), durationMin: durMin(), someday: someday(), goalDay: goalDay(),
        locked: locked(), allDay: allDay(),
        // AF-9: time-block secondary tags live in `intentions` (round-tripped on
        // edit), so no separate blind-preserve set is passed.
        // Phase B: 1–3 category names (picker order = stripe order) + texture override.
        categories: categoryNames(),
        textureEnabled: textureEnabled(),
        textureColorToken: textureColorToken(),
        // Motivation (0141): only when the user touched the control this session.
        ...(motivationTouched() ? { motivation: motivation() } : {}),
        scheduledFor: scheduledFor(), taskTime: taskTime() || undefined, estimatedMinutes: estimate(),
        dueAt: dueAt() || undefined, priority: priority(),
        deferUntil: deferUntil() || undefined, dependsOn: dependsOn(),
        editScope: editScope(), parentId: m().parentId,
        routineAddId: routineId() && routineId() !== initialRoutineId() ? routineId() : undefined,
        routineRemoveId: initialRoutineId() && routineId() !== initialRoutineId() ? initialRoutineId() : undefined,
        recurrenceRule:
          (effectiveKind === 'task' || effectiveKind === 'habit') ? (currentTaskRule() || null)
          : (effectiveKind === 'timeblock' && !someday()) ? (currentTbRule() || null)
          : undefined,
        // Time-block membership (applied by saveElement only for scheduled time-blocks).
        attachTaskIds: attachItems().filter((i) => i.kind !== 'routine').map((i) => i.id),
        attachRoutineIds: attachItems().filter((i) => i.kind === 'routine').map((i) => i.id),
        detachBlockIds: removedMemberIds(),
        // D5 — only the chips the user tapped; an untouched suggestion never gets here.
        subtaskTitles: pickedSubtasks(),
      };
      const msg = await saveElement(effectiveKind, m().mode, form, m().editTarget?.id);
      showToast(msg, 'success');
      close();
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setSaving(false); }
  }

  // ── Shared style atoms ──────────────────────────────────────────────────────
  const chipOn = 'border-primary text-primary bg-primary/10';
  const chipOff = 'border-border text-muted-foreground hover:text-foreground';
  const pill = 'text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap';
  const utilChip = 'inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap';
  const seg = 'flex-1 py-1 rounded-md text-xs border transition-colors';
  const popCard = 'absolute top-full left-0 mt-1 z-50 rounded-lg border border-border bg-popover shadow-xl p-2.5';
  const popLabel = 'text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5';
  const popItem = 'w-full text-left text-sm px-2 py-1.5 rounded-md hover:bg-sidebar-accent text-foreground';
  const sectionLabel = 'text-[10px] uppercase tracking-wider text-muted-foreground';

  // ── Shared sub-views ──────────────────────────────────────────────────────
  const PrimaryPicker = (p: { label: string; empty: string }) => (
    <div class="flex flex-col gap-1.5">
      <div class={sectionLabel}>{p.label}</div>
      <div class="flex flex-wrap gap-1.5">
        <For each={patternTagList()}>
          {(pt) => (
            <button type="button" onClick={() => pickPrimary(pt.name)}
              class={`${pill} capitalize`}
              classList={{
                [chipOn]: primary().toLowerCase() === pt.name.toLowerCase(),
                [chipOff]: primary().toLowerCase() !== pt.name.toLowerCase(),
              }}>
              {pt.name}
            </button>
          )}
        </For>
        <Show when={patternTagList().length === 0}>
          <span class="text-xs text-muted-foreground">{p.empty}</span>
        </Show>
      </div>
    </div>
  );

  // Tags — selected chips + up to 3 ranked "likely" dashed suggestions inline,
  // then the small "+ tag" input with typeahead.
  const TagSection = () => (
    <div class="flex flex-col gap-1.5">
      <div class={sectionLabel}>Tags</div>
      <div class="flex flex-wrap gap-1.5">
        <For each={intentions()}>
          {(name) => (
            <span class="text-xs px-2 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary inline-flex items-center gap-1">
              {name}
              <button type="button" onClick={() => removeIntention(name)} class="opacity-60 hover:opacity-100"><X size={10} /></button>
            </span>
          )}
        </For>
        <For each={secondarySuggestions().slice(0, 3)}>
          {(t) => (
            <button type="button" onClick={() => addIntention(t.name)}
              class="text-xs px-2 py-0.5 rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors">
              <Plus size={10} /> {t.name}
            </button>
          )}
        </For>
      </div>
      <div class="relative">
        <input class="w-28 bg-transparent border-0 border-b border-border text-xs text-foreground py-1 px-0.5 outline-none focus:border-ring"
          placeholder="+ tag" value={tagDraft()}
          onInput={(e) => setTagDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && tagDraft().trim()) { e.preventDefault(); addIntention(tagDraft()); } }} />
        <Show when={tagSuggestions().length > 0}>
          <div class="absolute z-50 left-0 mt-1 min-w-40 rounded-md border border-border bg-popover shadow-xl max-h-40 overflow-y-auto">
            <For each={tagSuggestions()}>
              {(t) => (
                <button type="button" onClick={() => addIntention(t.name)}
                  class="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-sidebar-accent">
                  {t.name}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );

  const NoteSection = () => (
    <Show when={noteExpanded()} fallback={
      <button type="button" onClick={() => setNoteExpanded(true)}
        class="text-left text-xs text-muted-foreground hover:text-foreground py-0.5">
        {note() || 'Add a note…'}
      </button>
    }>
      <textarea class="textarea text-sm" rows="2" placeholder="Notes…" value={note()}
        onInput={(e) => setNote(e.currentTarget.value)}
        onBlur={() => { if (!note()) setNoteExpanded(false); }} />
    </Show>
  );

  // Repeat popover body (shared task/block via signals passed in).
  const RepeatPopoverBody = (p: {
    presets: RepeatPreset[]; value: () => RepeatPreset; set: (v: RepeatPreset) => void;
    weekdays: () => string[]; toggle: (d: string) => void;
    custom: () => string; setCustom: (v: string) => void; rule: () => string | undefined | null;
  }) => (
    <>
      <div class={popLabel}>Repeat</div>
      <div class="flex gap-1 mb-1.5">
        <For each={p.presets}>
          {(opt) => (
            <button type="button" onClick={() => p.set(opt)}
              class="flex-1 rounded-md text-[11px] font-medium px-1.5 py-1 border transition-colors"
              classList={{ [chipOn]: p.value() === opt, [chipOff]: p.value() !== opt }}>
              {repeatLabel(opt)}
            </button>
          )}
        </For>
      </div>
      <Show when={p.value() === 'weekly'}>
        <div class="flex gap-1 mb-1.5">
          <For each={WEEKDAYS}>
            {(d) => (
              <button type="button" onClick={() => p.toggle(d)} title={d}
                class="flex-1 h-6 rounded-md text-[10px] font-bold border transition-colors"
                classList={{ [chipOn]: p.weekdays().includes(d), [chipOff]: !p.weekdays().includes(d) }}>
                {DAY_INITIAL[d]}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={p.value() === 'custom'}>
        <input class="input py-1 text-xs font-mono mb-1.5" placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
          value={p.custom()} onInput={(e) => p.setCustom(e.currentTarget.value)} />
      </Show>
      <Show when={p.rule()}>
        <div class="text-[10px] text-muted-foreground">{describeRule(p.rule()!)}</div>
      </Show>
    </>
  );

  // Time chip + presets + slot dropdown (task: taskTime; block: start).
  const TimeRow = () => (
    <div class="flex flex-col gap-1.5">
      <div class={sectionLabel}>Time</div>
      <div ref={timeEl} class="relative flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => togglePopover('time')}
          class={`${utilChip} font-semibold ${chipOn}`}>
          <Clock size={11} /> {timeChipLabel()}
        </button>
        <button type="button" onClick={() => nudgeTime(-5)} class={`${utilChip} ${chipOff}`}>-5m</button>
        <button type="button" onClick={() => nudgeTime(-15)} class={`${utilChip} ${chipOff}`}>-15m</button>
        <span class="text-border text-xs px-0.5">|</span>
        <button type="button" onClick={() => nudgeTime(5)} class={`${utilChip} ${chipOff}`}>+5m</button>
        <button type="button" onClick={() => nudgeTime(15)} class={`${utilChip} ${chipOff}`}>+15m</button>
        <Show when={popover() === 'time'}>
          <div class={`${popCard} w-44 max-h-56 overflow-y-auto`}>
            <Show when={tab() === 'task'}>
              <button type="button" class={popItem} onClick={() => { setTaskTime(''); setPopover(null); }}>No time</button>
            </Show>
            <For each={TIME_SLOTS}>
              {(t) => (
                <button type="button" class={popItem}
                  classList={{ 'text-primary font-semibold': barStartMin() === t }}
                  onClick={() => { setBarStart(t); setPopover(null); }}>
                  {clockLabel(minToHHMM(t))}
                </button>
              )}
            </For>
            <label class="flex items-center gap-2 border-t border-border mt-1 pt-1.5 px-2 pb-0.5 text-xs text-muted-foreground">
              Custom
              <input type="time" class="input py-0.5 text-xs flex-1"
                value={barStartMin() !== null ? minToHHMM(barStartMin()!) : ''}
                onInput={(e) => { const v = e.currentTarget.value; if (v) setBarStart(hhmmToMin(v)!); }} />
            </label>
          </div>
        </Show>
      </div>
    </div>
  );

  // Duration chip + presets + slot dropdown (task: estimate; block: durMin).
  const DurationRow = () => (
    <div class="flex flex-col gap-1.5">
      <div class={sectionLabel}>Duration</div>
      <div ref={durEl} class="relative flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => togglePopover('duration')}
          class={`${utilChip} font-semibold ${chipOn}`}>
          <Timer size={11} /> {fmtDur(barDurMin())}
        </button>
        <button type="button" onClick={() => nudgeDur(-5)} class={`${utilChip} ${chipOff}`}>-5m</button>
        <button type="button" onClick={() => nudgeDur(-60)} class={`${utilChip} ${chipOff}`}>-1h</button>
        <span class="text-border text-xs px-0.5">|</span>
        <button type="button" onClick={() => nudgeDur(5)} class={`${utilChip} ${chipOff}`}>+5m</button>
        <button type="button" onClick={() => nudgeDur(60)} class={`${utilChip} ${chipOff}`}>+1h</button>
        <Show when={popover() === 'duration'}>
          <div class={`${popCard} w-36 max-h-56 overflow-y-auto`}>
            <For each={DURATION_SLOTS}>
              {(d) => (
                <button type="button" class={popItem}
                  classList={{ 'text-primary font-semibold': barDurMin() === d }}
                  onClick={() => { setBarDur(d); setPopover(null); }}>
                  {fmtDur(d)}
                </button>
              )}
            </For>
            <label class="flex items-center gap-2 border-t border-border mt-1 pt-1.5 px-2 pb-0.5 text-xs text-muted-foreground">
              Custom
              <input type="number" min={minDur()} step="5" class="input py-0.5 text-xs w-16"
                value={barDurMin()}
                onInput={(e) => { const v = Number(e.currentTarget.value); if (v > 0) setBarDur(v); }} />
              <span>min</span>
            </label>
          </div>
        </Show>
      </div>
    </div>
  );

  const barGradient = 'linear-gradient(135deg, #abd4d8, #70a6af)';

  return (
    <Show when={open()}>
      <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
        <div class="modal md:max-w-[680px]">
          {/* ── Header: segmented tabs + close, then the borderless title ── */}
          <div class="px-5 pt-4 pb-3 border-b border-border">
            <div class="flex items-center gap-2 mb-3">
              <div class="inline-flex items-center rounded-full border border-border bg-background p-0.5 gap-0.5">
                <For each={([['task', 'Task'], ['timeblock', 'Time Block'], ...(enableRoutines() ? [['routine', 'Routine']] : [])] as [ElementKind, string][])}>
                  {([key, label]) => {
                    const active = () => tab() === key;
                    const disabled = () => isEdit() && !active();
                    return (
                      <button type="button"
                        onClick={() => !disabled() && setElementModal({ ...m(), kind: key })}
                        disabled={disabled()}
                        title={disabled() ? "Can't change type while editing" : undefined}
                        class="px-3 py-1 rounded-full text-[11.5px] font-semibold transition-colors whitespace-nowrap"
                        classList={{
                          'bg-primary text-primary-foreground': active(),
                          'text-muted-foreground hover:text-foreground': !active() && !disabled(),
                          'text-muted-foreground/40 cursor-not-allowed': disabled(),
                        }}>
                        {label}
                      </button>
                    );
                  }}
                </For>
              </div>
              {/* Search-existing-tasks toggle (owner request) — sits beside the type
                  toggle, not buried in the "Describe it" input. Hidden during edit/
                  routine, same scope as the NL line it repurposes. */}
              <Show when={tab() !== 'routine' && !isEdit()}>
                <button
                  type="button"
                  class="btn-icon"
                  classList={{ 'text-primary': taskSearchMode() }}
                  title={taskSearchMode() ? 'Back to describing a new item' : 'Search existing tasks to schedule one here'}
                  onClick={() => { setTaskSearchMode((v) => !v); setTaskQuery(''); }}
                >
                  <Search size={15} />
                </button>
              </Show>
              <span class="text-[11px] text-muted-foreground ml-1">{isEdit() ? 'Editing' : ''}</span>
              <button onClick={close} class="btn-icon ml-auto"><X size={16} /></button>
            </div>

            {/* T14 (#350) — NL quick line: describe the task/block (typed or spoken) and
                the parse PREVIEWS into the fields below for approval; Add creates. Both
                Task and Time Block add-modes (edits keep their loaded values; routines
                are just a name). Sits between the type tabs and the title by design.
                A toggle button (owner request) flips this same line into a search over
                EXISTING tasks — picking a result schedules that task here instead of
                composing a new one, without needing a flight-plan drag gesture. */}
            <Show when={tab() !== 'routine' && !isEdit()}>
              <div class="mb-2">
                <div class="relative">
                  <Show
                    when={taskSearchMode()}
                    fallback={<Plus size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />}
                  >
                    <Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </Show>
                  <input
                    class="input text-sm pl-8 pr-16 w-full"
                    placeholder={taskSearchMode()
                      ? 'Search existing tasks…'
                      : tab() === 'timeblock'
                        ? "Describe it… e.g. 'deep work 2pm ~90m #work'"
                        : "Describe it… e.g. 'pay invoice fri 3pm #finance ~20m'"}
                    value={taskSearchMode() ? taskQuery() : nlText()}
                    disabled={nlBusy() || !!schedulingId()}
                    onInput={(e) => (taskSearchMode() ? setTaskQuery(e.currentTarget.value) : setNlText(e.currentTarget.value))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      if (taskSearchMode()) { const first = taskSearchResults()[0]; if (first) void scheduleExisting(first); }
                      else void parseNl();
                    }}
                  />
                  <div class="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                    <Show when={!taskSearchMode() && nlLlm()}>
                      <span title="Parsed with AI enrichment"><Sparkles size={11} class="text-accent-light" /></span>
                    </Show>
                    <Show when={!taskSearchMode()}>
                      <MicButton
                        onTranscript={(t) => { setNlText(t); void parseNl(t); }}
                        onError={(r) => setNlError(r)}
                        disabled={nlBusy()}
                        class="btn-icon p-1"
                      />
                    </Show>
                  </div>
                </div>
                <Show when={!taskSearchMode() && nlError()}>
                  <p class="text-[11px] text-destructive mt-1">{nlError()}</p>
                </Show>

                {/* D3 — why the proposed time landed where it did. Display-only. */}
                <Show when={!taskSearchMode() && timeHint()}>
                  <p class="text-[11px] text-muted-foreground mt-1 px-1">{timeHint()}</p>
                </Show>

                {/* D5 — suggest-only subtask chips. Nothing here creates anything: a tap
                    only marks a title for creation WITH the parent on Add, and an
                    untapped suggestion is discarded when the modal closes. */}
                <Show when={!taskSearchMode() && (subtaskBusy() || subtaskIdeas().length > 0)}>
                  <div class="mt-2">
                    <div class="flex items-center gap-1.5 mb-1 px-1">
                      <ListTodo size={11} class="text-muted-foreground" />
                      <span class="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {subtaskBusy() ? 'Thinking about steps…' : 'Suggested steps — tap to add'}
                      </span>
                    </div>
                    <Show when={!subtaskBusy()}>
                      <div class="flex flex-wrap gap-1.5">
                        <For each={subtaskIdeas()}>
                          {(s) => (
                            <button
                              type="button"
                              onClick={() => togglePicked(s)}
                              class={`${pill} ${pickedSubtasks().includes(s) ? chipOn : chipOff}`}
                              title={pickedSubtasks().includes(s) ? 'Will be created as a subtask' : 'Add as a subtask'}
                            >
                              <Show when={pickedSubtasks().includes(s)} fallback={<Plus size={10} class="inline mr-1" />}>
                                <CheckIcon size={10} class="inline mr-1" />
                              </Show>
                              {s}
                            </button>
                          )}
                        </For>
                      </div>
                      <Show when={pickedSubtasks().length > 0}>
                        <p class="text-[10px] text-muted-foreground mt-1 px-1">
                          {pickedSubtasks().length} will be created with this task.
                        </p>
                      </Show>
                    </Show>
                  </div>
                </Show>

                {/* Search results — a real block bound to the picked task, at this
                    wizard's current day/time (selDay/barStartMin below). */}
                <Show when={taskSearchMode() && taskQuery().trim()}>
                  <Show
                    when={taskSearchResults().length > 0}
                    fallback={<p class="text-[11px] text-muted-foreground mt-1.5 px-1">No matching open tasks.</p>}
                  >
                    <div class="mt-1.5 flex flex-col gap-1 rounded-md border border-border bg-popover max-h-48 overflow-auto">
                      <For each={taskSearchResults()}>
                        {(t) => (
                          <button
                            type="button"
                            disabled={!!schedulingId()}
                            onClick={() => void scheduleExisting(t)}
                            class="flex items-center justify-between gap-2 text-left text-xs px-2.5 py-1.5 hover:bg-primary/10 transition-colors disabled:opacity-50"
                          >
                            <span class="truncate text-foreground">{t.title}</span>
                            <span class="text-[10px] text-muted-foreground flex-shrink-0">
                              {schedulingId() === t.id ? 'Scheduling…' : t.estimated_minutes ? `${t.estimated_minutes}m` : ''}
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            </Show>

            <input autofocus
              class="w-full bg-transparent border-none outline-none text-lg font-semibold text-foreground placeholder:text-muted-foreground"
              placeholder={tab() === 'timeblock' ? 'Time block title…' : tab() === 'routine' ? 'Routine name…' : 'Task title…'}
              value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </div>

          {/* ── Body — identity left, time right (stacked on mobile) ── */}
          <div class="flex flex-col md:flex-row max-h-[68vh] overflow-y-auto">

            {/* Routine — simple shell, no panes */}
            <Show when={tab() === 'routine'}>
              <div class="p-5 flex-1">
                <p class="text-xs text-muted-foreground">Creates a named, tagged Routine. Add member tasks &amp; habits on the <span class="text-primary">Routines</span> page or by multi-selecting tasks.</p>
              </div>
            </Show>

            <Show when={tab() !== 'routine'}>
              {/* LEFT PANE — identity */}
              <div class="w-full md:w-[290px] flex-shrink-0 p-4 md:p-5 flex flex-col gap-3.5 md:border-r border-b md:border-b-0 border-border transition-opacity"
                classList={{ 'opacity-50': gateLeft(), 'pointer-events-none': gateLeft() }}
                inert={gateLeft()}
                aria-disabled={gateLeft()}>
                <PrimaryPicker label="Direction" empty="No direction tags yet." />

                {/* Categories — Phase B: 1–3 multi-select on BOTH tabs (was single,
                    block-only). Pick order = stripe order; a chip dot shows the
                    category's colour token; picks past 3 are ignored (server cap). */}
                <div class="flex flex-col gap-1.5">
                  <div class={sectionLabel}>Categories <span class="normal-case tracking-normal">(up to 3)</span></div>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={categoryOptions()}>
                      {(c) => {
                        const on = () => categoryIds().includes(c.id);
                        return (
                          <button type="button" onClick={() => toggleCategory(c.id)}
                            class={`${pill} capitalize inline-flex items-center gap-1.5`}
                            classList={{ [chipOn]: on(), [chipOff]: !on() }}>
                            <span class="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ 'background-color': colorVar(categoryPrefs()?.prefs?.[c.id]?.color_token) }} />
                            {displayTag(c.name)}
                          </button>
                        );
                      }}
                    </For>
                    <Show when={categoryOptions().length === 0}>
                      <span class="text-xs text-muted-foreground">No categories yet.</span>
                    </Show>
                  </div>
                </div>

                {/* Motivation (0141, §3b) — who is this for? Three-way; tapping the
                    active pill again clears back to unset (NULL, distinct from "us").
                    An 'llm' label renders a "suggested" hint until the user confirms
                    or changes it — only a tap sends the field on save. Task tab only:
                    blocks inherit their linked task's motivation (no own column). */}
                <Show when={tab() !== 'timeblock'}>
                  <div class="flex flex-col gap-1.5">
                    <div class={sectionLabel}>Who is this for?
                      <Show when={motivation() && motivationSource() === 'llm' && !motivationTouched()}>
                        <span class="normal-case tracking-normal text-muted-foreground"> (suggested)</span>
                      </Show>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={[['me', '● me'], ['us', '◐ us'], ['them', '○ them']] as const}>
                        {([val, label]) => (
                          <button type="button"
                            onClick={() => { setMotivationTouched(true); setMotivation(motivation() === val ? null : val); }}
                            class={pill}
                            classList={{ [chipOn]: motivation() === val, [chipOff]: motivation() !== val }}>
                            {label}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Texture — Phase B (0135): per-element on/off + colour override.
                    "Auto" (null) derives the colour from the categories above. */}
                <div class="flex flex-col gap-1.5">
                  <div class={sectionLabel}>Texture</div>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <button type="button" onClick={() => setTextureEnabled(!textureEnabled())}
                      class={pill}
                      classList={{ [chipOn]: textureEnabled(), [chipOff]: !textureEnabled() }}>
                      {textureEnabled() ? 'On' : 'Off'}
                    </button>
                    <Show when={textureEnabled()}>
                      <button type="button" onClick={() => setTextureColorToken(null)}
                        class={pill}
                        classList={{ [chipOn]: textureColorToken() === null, [chipOff]: textureColorToken() !== null }}>
                        Auto
                      </button>
                      <For each={PATTERN_COLORS}>
                        {(col) => (
                          <button type="button" title={col.label}
                            onClick={() => setTextureColorToken(col.token)}
                            class="w-5 h-5 rounded-full border-2 transition-transform flex-shrink-0"
                            classList={{
                              'border-foreground scale-110': textureColorToken() === col.token,
                              'border-transparent hover:scale-105': textureColorToken() !== col.token,
                            }}
                            style={{ 'background-color': colorVar(col.token) }} />
                        )}
                      </For>
                    </Show>
                  </div>
                </div>

                <Show when={tab() === 'task' ? !!primary() : true}><TagSection /></Show>

                {/* Priority — tasks */}
                <Show when={tab() === 'task'}>
                  <div class="flex flex-col gap-1.5">
                    <div class={sectionLabel}>Priority</div>
                    <div class="flex gap-1">
                      <For each={[1, 2, 3]}>
                        {(p) => (
                          <button type="button" onClick={() => { setPriority(p); setSomeday(false); }}
                            class={`${seg} font-semibold`}
                            classList={{ [chipOn]: !someday() && priority() === p, [chipOff]: someday() || priority() !== p }}>
                            P{p}
                          </button>
                        )}
                      </For>
                      <Show when={kind() === 'task'}>
                        <button type="button" onClick={() => setSomeday(true)}
                          class={`${seg} font-semibold`}
                          classList={{ [chipOn]: someday(), [chipOff]: !someday() }}>
                          Someday
                        </button>
                      </Show>
                    </div>
                  </div>
                </Show>

                <NoteSection />

                {/* ── Utility chips + popovers ── */}
                <div ref={utilityEl} class="relative flex flex-col gap-2 mt-0.5">
                  <div class="flex flex-wrap gap-1.5">
                    <Show when={tab() === 'task'}>
                      <button type="button" onClick={() => togglePopover('defer')}
                        class={utilChip}
                        classList={{ [chipOn]: !!deferUntil() || popover() === 'defer', [chipOff]: !deferUntil() && popover() !== 'defer' }}>
                        <Clock size={11} /> {deferUntil() ? `Defer · ${shortDate(deferUntil())}` : 'Defer'}
                      </button>
                      <button type="button" onClick={() => togglePopover('depends')}
                        class={utilChip}
                        classList={{ [chipOn]: dependsOn().length > 0 || popover() === 'depends', [chipOff]: dependsOn().length === 0 && popover() !== 'depends' }}>
                        <Link2 size={11} /> {dependsOn().length ? `Depends · ${dependsOn().length}` : 'Depends'}
                      </button>
                    </Show>
                    <button type="button" onClick={() => togglePopover('repeat')}
                      class={utilChip}
                      classList={{
                        [chipOn]: (tab() === 'task' ? taskRepeat() !== 'none' : tbRepeat() !== 'none') || popover() === 'repeat',
                        [chipOff]: (tab() === 'task' ? taskRepeat() === 'none' : tbRepeat() === 'none') && popover() !== 'repeat',
                      }}>
                      <RepeatIcon size={11} /> {(tab() === 'task' ? taskRepeat() : tbRepeat()) === 'none' ? 'Repeat' : repeatLabel(tab() === 'task' ? taskRepeat() : tbRepeat())}
                    </button>
                    <Show when={tab() === 'task' && enableRoutines()}>
                      <button type="button" onClick={() => togglePopover('routine')}
                        class={utilChip}
                        classList={{ [chipOn]: !!routineId() || popover() === 'routine', [chipOff]: !routineId() && popover() !== 'routine' }}>
                        <Boxes size={11} /> {routineId() ? `Routine · ${routineList().find((r) => r.id === routineId())?.name ?? ''}` : 'Routine'}
                      </button>
                    </Show>
                    <Show when={tab() === 'task'}>
                      <button type="button"
                        onClick={() => { if (kind() !== 'habit' && taskRepeat() !== 'none') setMakeHabit(!makeHabit()); }}
                        disabled={kind() !== 'habit' && taskRepeat() === 'none'}
                        title={kind() === 'habit' ? 'This is a habit' : taskRepeat() === 'none' ? 'Set a repeat first' : 'Track a daily streak'}
                        class={utilChip}
                        classList={{
                          [chipOn]: makeHabit() || kind() === 'habit',
                          [chipOff]: !makeHabit() && kind() !== 'habit' && taskRepeat() !== 'none',
                          'border-border text-muted-foreground/40 cursor-not-allowed': kind() !== 'habit' && taskRepeat() === 'none',
                        }}>
                        <Flame size={11} /> Track as habit
                      </button>
                    </Show>
                    <Show when={tab() === 'timeblock'}>
                      <button type="button" onClick={() => setLocked(!locked())}
                        class={utilChip}
                        classList={{ [chipOn]: locked(), [chipOff]: !locked() }}>
                        <Lock size={11} /> Lock
                      </button>
                      <Show when={!someday()}>
                        <button type="button" onClick={() => setAllDay(!allDay())}
                          class={utilChip}
                          classList={{ [chipOn]: allDay(), [chipOff]: !allDay() }}>
                          <Square size={11} /> All-day
                        </button>
                      </Show>
                    </Show>
                  </div>

                  {/* Defer popover */}
                  <Show when={popover() === 'defer'}>
                    <div class={`${popCard} min-w-48`}>
                      <div class={popLabel}>Hide until…</div>
                      <For each={deferOptions()}>
                        {(o) => (
                          <button type="button" class={popItem}
                            onClick={() => { setDeferUntil(o.date); setPopover(null); }}>
                            {o.label}
                          </button>
                        )}
                      </For>
                      <label class="flex items-center gap-2 border-t border-border mt-1 pt-1.5 px-2 text-xs text-muted-foreground">
                        Date
                        <input type="date" class="input py-0.5 text-xs flex-1" value={deferUntil()}
                          onInput={(e) => setDeferUntil(e.currentTarget.value)} />
                      </label>
                      <Show when={deferUntil()}>
                        <button type="button" class={`${popItem} text-muted-foreground`}
                          onClick={() => { setDeferUntil(''); setPopover(null); }}>Clear defer</button>
                      </Show>
                    </div>
                  </Show>

                  {/* Depends popover */}
                  <Show when={popover() === 'depends'}>
                    <div class={`${popCard} w-60`}>
                      <div class={popLabel}>Depends on (won't schedule until done)</div>
                      <Show when={dependsOn().length > 0}>
                        <div class="flex flex-wrap gap-1 mb-1.5">
                          <For each={dependsOn()}>
                            {(id) => (
                              <span class="text-[11px] px-2 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary inline-flex items-center gap-1 max-w-full">
                                <span class="truncate">{taskById(id)?.title ?? id}</span>
                                <button type="button" onClick={() => removeDep(id)} class="flex-shrink-0"><X size={9} /></button>
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>
                      <input class="input py-1 text-xs mb-1" placeholder="Search tasks…" value={depDraft()}
                        onInput={(e) => setDepDraft(e.currentTarget.value)} />
                      <For each={depSuggestions()}>
                        {(t) => (
                          <button type="button" class={`${popItem} truncate`} onClick={() => addDep(t.id)}>
                            {t.title}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Repeat popover */}
                  <Show when={popover() === 'repeat'}>
                    <div class={`${popCard} w-60`}>
                      <Show when={tab() === 'task'} fallback={
                        <RepeatPopoverBody presets={TB_REPEAT} value={tbRepeat} set={setTbRepeat}
                          weekdays={tbWeekdays} toggle={toggleTbWeekday}
                          custom={tbCustomRule} setCustom={setTbCustomRule} rule={currentTbRule} />
                      }>
                        <RepeatPopoverBody presets={kind() === 'habit' ? HABIT_REPEAT : TASK_REPEAT}
                          value={taskRepeat} set={setTaskRepeat}
                          weekdays={taskWeekdays} toggle={toggleWeekday}
                          custom={taskCustomRule} setCustom={setTaskCustomRule} rule={currentTaskRule} />
                      </Show>
                    </div>
                  </Show>

                  {/* Routine popover — single-select membership */}
                  <Show when={popover() === 'routine'}>
                    <div class={`${popCard} min-w-48 max-h-56 overflow-y-auto`}>
                      <div class={popLabel}>Add to routine</div>
                      <For each={routineList()}>
                        {(r) => (
                          <button type="button" class={popItem}
                            classList={{ 'text-primary': routineId() === r.id }}
                            onClick={() => { setRoutineId(r.id); setPopover(null); }}>
                            {r.name}
                          </button>
                        )}
                      </For>
                      <Show when={routineList().length === 0}>
                        <div class="text-xs text-muted-foreground px-2 py-1">No routines yet.</div>
                      </Show>
                      <Show when={routineId()}>
                        <button type="button"
                          class="w-full text-left text-xs px-2 py-1.5 mt-1 border-t border-border text-muted-foreground hover:text-foreground"
                          onClick={() => { setRoutineId(''); setPopover(null); }}>
                          Remove from routine
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>

                {/* Similar-task notice (UI-comments 2026-07-20): existing tasks whose
                    title is close to the one being composed. Tapping one OPENS it —
                    it does NOT create a new task — so near-duplicates get merged into
                    the real thing. Task add-mode only. */}
                <Show when={similarTasks().length > 0}>
                  <div class="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2">
                    <div class="flex items-center gap-1.5 text-[11px] text-amber-400">
                      <AlertTriangle size={11} />
                      <span>You may already have {similarTasks().length === 1 ? 'this' : 'these'} — open instead of adding?</span>
                    </div>
                    <For each={similarTasks()}>
                      {(s) => (
                        <button type="button" onClick={() => openSimilar(s.id)}
                          class="flex items-center justify-between gap-2 text-left text-xs rounded px-1.5 py-1 hover:bg-amber-500/10 transition-colors">
                          <span class="truncate text-foreground">{s.title}</span>
                          <span class="text-[10px] text-muted-foreground capitalize flex-shrink-0">{s.status}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Edit scope — recurring task edits */}
                <Show when={tab() === 'task' && isEdit() && wasRecurring()}>
                  <div class="flex flex-col gap-1.5 border-t border-border pt-2.5">
                    <div class={sectionLabel}>Applies to</div>
                    <div class="flex gap-1">
                      <For each={['instance', 'series'] as const}>
                        {(s) => (
                          <button type="button" onClick={() => setEditScope(s)}
                            class={seg}
                            classList={{ [chipOn]: editScope() === s, [chipOff]: editScope() !== s }}>
                            {s === 'instance' ? 'This task' : 'This & future'}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Block contents — scheduled blocks only */}
                <Show when={tab() === 'timeblock' && !someday()}>
                  <div class="flex flex-col gap-1.5 border-t border-border pt-2.5">
                    <div class={sectionLabel}>In this block</div>
                    <Show when={existingMembers().length > 0 || attachItems().length > 0}>
                      <div class="flex flex-wrap gap-1.5">
                        <For each={existingMembers()}>
                          {(b) => (
                            <span class="text-xs px-2 py-0.5 rounded-full border border-border text-foreground inline-flex items-center gap-1 max-w-full">
                              <ListTodo size={11} class="flex-shrink-0 text-muted-foreground" />
                              <span class="truncate">{b.title}</span>
                              <button type="button" title="Remove from block" onClick={() => removeMember(b.id)} class="hover:text-destructive flex-shrink-0"><X size={11} /></button>
                            </span>
                          )}
                        </For>
                        <For each={attachItems()}>
                          {(it) => {
                            const Icon = attachIcon(it.kind);
                            return (
                              <span class="text-xs px-2 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary inline-flex items-center gap-1 max-w-full">
                                <Icon size={11} class="flex-shrink-0" />
                                <span class="truncate">{it.label}</span>
                                <button type="button" onClick={() => removeAttach(it.id)} class="hover:text-destructive flex-shrink-0"><X size={11} /></button>
                              </span>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                    <div class="relative">
                      <input class="w-full bg-transparent border-0 border-b border-border text-xs text-foreground py-1 px-0.5 outline-none focus:border-ring"
                        placeholder={enableRoutines() ? '+ add task, habit, or routine…' : '+ add task or habit…'}
                        value={attachDraft()} onInput={(e) => setAttachDraft(e.currentTarget.value)} />
                      <Show when={attachSuggestions().length > 0}>
                        <div class="absolute z-50 left-0 right-0 mt-1 rounded-md border border-border bg-popover shadow-xl max-h-44 overflow-y-auto">
                          <For each={attachSuggestions()}>
                            {(s) => {
                              const Icon = attachIcon(s.kind);
                              return (
                                <button type="button" onClick={() => addAttach(s)}
                                  class="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-foreground hover:bg-sidebar-accent">
                                  <Icon size={12} class="flex-shrink-0 text-muted-foreground" />
                                  <span class="truncate flex-1">{s.label}</span>
                                  <span class="text-[10px] text-muted-foreground capitalize flex-shrink-0">{s.kind}</span>
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>
              </div>

              {/* RIGHT PANE — scheduling */}
              <div class="flex-1 min-w-0 p-4 md:p-5 flex flex-col gap-3 transition-opacity"
                classList={{ 'opacity-50': dimRightPane() || gateRight(), 'pointer-events-none': gateRight() }}
                inert={gateRight()}
                aria-disabled={gateRight()}>

                {/* Day chips + calendar + due flag */}
                <div ref={dayEl} class="flex flex-col gap-1.5">
                  <div class={sectionLabel}>Day</div>
                  <div class="relative flex flex-wrap items-center gap-1.5">
                    <For each={dayOptions()}>
                      {(o) => (
                        <button type="button" onClick={() => setSelDay(o.date)}
                          class={`${pill} relative font-medium`}
                          classList={{ [chipOn]: selDay() === o.date, [chipOff]: selDay() !== o.date }}>
                          {o.label}
                          <Show when={dueDiffers() && dueAt() === o.date}>
                            <Flag size={9} class="absolute -top-1 -right-1 text-orange-500 fill-orange-500" />
                          </Show>
                        </button>
                      )}
                    </For>
                    <button type="button" title="Pick a date"
                      onClick={() => { setCalTarget('start'); setCalMonth(selDay().slice(0, 8) + '01'); setCalendarOpen(!calendarOpen()); }}
                      class="rounded-md border px-2 py-1.5 transition-colors"
                      classList={{ [chipOn]: dayIsCustom() || calendarOpen(), [chipOff]: !dayIsCustom() && !calendarOpen() }}>
                      <span class="flex items-center gap-1 text-xs"><Calendar size={13} />{dayIsCustom() ? shortDate(selDay()) : ''}</span>
                    </button>
                    <Show when={tab() === 'task'}>
                      <button type="button" title="Due date" onClick={() => togglePopover('due')}
                        class="ml-auto inline-flex items-center gap-1 text-[11px] text-orange-500 py-1">
                        <Flag size={12} classList={{ 'fill-orange-500': dueDiffers() }} />
                        {dueDiffers() ? `Due ${fmtDayLabel(dueAt())}` : 'Set due'}
                      </button>
                      {/* Due popover — anchored right */}
                      <Show when={popover() === 'due'}>
                        <div class={`${popCard} left-auto right-0 min-w-44`}>
                          <div class={popLabel}>Due date</div>
                          <button type="button" class={popItem}
                            onClick={() => { setDueEdited(false); setPopover(null); }}>Same as start</button>
                          <For each={dayOptions()}>
                            {(o) => (
                              <button type="button" class={popItem}
                                classList={{ 'text-primary': dueDiffers() && dueAt() === o.date }}
                                onClick={() => pickDue(o.date)}>
                                {o.label}
                              </button>
                            )}
                          </For>
                          <button type="button"
                            class="w-full text-left text-xs px-2 py-1.5 mt-1 border-t border-border text-primary hover:underline"
                            onClick={() => { setCalTarget('due'); setCalMonth((dueAt() || selDay()).slice(0, 8) + '01'); setPopover(null); setCalendarOpen(true); }}>
                            Choose a date…
                          </button>
                        </div>
                      </Show>
                    </Show>
                  </div>

                  {/* Inline month calendar (start or due, per calTarget) */}
                  <Show when={calendarOpen()}>
                    <div class="rounded-lg border border-border bg-popover shadow-xl p-2.5 mt-1">
                      <div class="flex items-center justify-between mb-1.5">
                        <button type="button" class="btn-icon" onClick={() => moveCalMonth(-1)}><ChevronLeft size={13} /></button>
                        <span class="text-xs font-semibold text-foreground">
                          {calMonthLabel()}{calTarget() === 'due' ? ' · due' : ''}
                        </span>
                        <button type="button" class="btn-icon" onClick={() => moveCalMonth(1)}><ChevronRight size={13} /></button>
                      </div>
                      <div class="grid grid-cols-7 gap-0.5">
                        <For each={['M', 'T', 'W', 'T', 'F', 'S', 'S']}>
                          {(d) => <span class="text-center text-[9px] text-muted-foreground py-0.5">{d}</span>}
                        </For>
                        <For each={calGrid()}>
                          {(d) => {
                            const inMonth = () => d.slice(0, 7) === calMonth().slice(0, 7);
                            const selected = () => (calTarget() === 'due' ? dueAt() === d : selDay() === d);
                            return (
                              <button type="button" onClick={() => pickCalDate(d)}
                                class="rounded text-[10px] py-1 transition-colors"
                                classList={{
                                  'bg-primary text-primary-foreground font-bold': selected(),
                                  'text-foreground hover:bg-sidebar-accent': !selected() && inMonth(),
                                  'text-muted-foreground/40 hover:bg-sidebar-accent': !selected() && !inMonth(),
                                  'ring-1 ring-primary/50': !selected() && d === localISODate(),
                                }}>
                                {Number(d.slice(8, 10))}
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>

                {/* Block scheduled/someday toggle */}
                <Show when={tab() === 'timeblock'}>
                  <div class="flex gap-1">
                    <button type="button" onClick={() => setSomeday(false)} class={seg}
                      classList={{ [chipOn]: !someday(), [chipOff]: someday() }}>Scheduled</button>
                    <button type="button" onClick={() => setSomeday(true)} class={seg}
                      classList={{ [chipOn]: someday(), [chipOff]: !someday() }}>Someday</button>
                  </div>
                </Show>

                {/* Someday block — compact fields */}
                <Show when={tab() === 'timeblock' && someday()}>
                  <div class="flex flex-col gap-2.5 rounded-xl border border-dashed border-border bg-background/50 p-3.5">
                    <div class="text-[11px] text-muted-foreground">No schedule yet — saved for later.</div>
                    <div class="flex flex-col gap-1.5">
                      <span class={sectionLabel}>Target week</span>
                      <div class="flex flex-wrap items-center gap-1.5">
                        <For each={targetWeekOptions()}>
                          {(o) => (
                            <button type="button" onClick={() => setGoalDay(o.date)}
                              class={pill}
                              classList={{ [chipOn]: goalDay() === o.date, [chipOff]: goalDay() !== o.date }}>
                              {o.label}
                            </button>
                          )}
                        </For>
                        <input type="date" class="input py-0.5 text-xs w-32" value={goalDay()}
                          onInput={(e) => setGoalDay(e.currentTarget.value)} />
                      </div>
                    </div>
                    <DurationRow />
                  </div>
                </Show>

                {/* All-day block — collapsed full-span bar, no time/duration */}
                <Show when={blockAllDayView()}>
                  <div class="flex flex-col gap-1.5">
                    <div class={sectionLabel}>All day</div>
                    <div class="h-14 rounded-xl flex items-center px-3.5 text-sm font-semibold"
                      style={{ background: barGradient, color: '#041620' }}>
                      {title() || 'Time block'}
                    </div>
                  </div>
                </Show>

                {/* Timed view — time/duration rows + suggestion + timeline */}
                <Show when={(tab() === 'task' || (tab() === 'timeblock' && !someday())) && !blockAllDayView()}>
                  <TimeRow />
                  <DurationRow />

                  {/* Phase Z · Z6 — suggest-only estimate chip (Time-Sense). */}
                  <Show when={estimateSuggestion()}>
                    {(s) => (
                      <div class="flex items-center gap-2 text-[11px] rounded-md border border-border bg-background/60 px-2 py-1.5">
                        <span class="flex-1 text-muted-foreground">
                          {/* Z7 — the line is rendered server-side through the Voice loop
                              (one voice, no repeats). Falls back to the structured sentence
                              only if the message is somehow absent. */}
                          {s().message ?? `${s().scope_label} tends to run ${Math.abs(s().delta_minutes)}m ${s().delta_minutes > 0 ? 'longer' : 'shorter'} than you estimate — set ${s().suggested_minutes}m?`}
                          <Show when={s().confidence === 'tentative'}><span class="opacity-60"> (early signal)</span></Show>
                        </span>
                        <button type="button" class="text-primary hover:underline flex-shrink-0"
                          onClick={() => { setEstimate(s().suggested_minutes); mutateSuggestion(null); }}>Set</button>
                        <button type="button" class="text-muted-foreground hover:text-foreground flex-shrink-0"
                          onClick={() => mutateSuggestion(null)}>Dismiss</button>
                      </div>
                    )}
                  </Show>

                  {/* Timeline — drag the bar to set start; drag the bottom edge for duration */}
                  <div ref={timelineEl} onPointerDown={onTimelinePointerDown}
                    class="relative h-[220px] md:h-[300px] rounded-xl border border-border bg-background overflow-hidden select-none"
                    classList={{ 'opacity-60': timePaneMuted() }}>
                    <Show when={timePaneMuted()}>
                      <div class="absolute inset-0 z-[15] flex items-center justify-center bg-background/60">
                        <span class="text-[11px] text-muted-foreground bg-popover border border-border px-2.5 py-1 rounded-full whitespace-nowrap">{timeMuteLabel()}</span>
                      </div>
                    </Show>
                    {/* hour gridlines */}
                    <For each={HOUR_LINES}>
                      {(h) => (
                        <div class="absolute left-0 right-0 border-t border-border/40 text-[9px] text-muted-foreground/60 pl-1 pointer-events-none"
                          style={{ top: `${h.frac * 100}%` }}>{h.label}</div>
                      )}
                    </For>
                    {/* ghost existing events */}
                    <For each={ghostBlocks()}>
                      {(g) => (
                        <div class="absolute left-8 right-2 rounded-md text-[10px] px-1.5 py-0.5 overflow-hidden whitespace-nowrap text-ellipsis border pointer-events-none"
                          classList={{
                            'bg-destructive/15 border-dashed border-destructive/60 text-destructive': dragging() && barConflicts(g),
                            'bg-muted-foreground/10 border-muted-foreground/25 text-muted-foreground': !(dragging() && barConflicts(g)),
                          }}
                          style={{
                            top: `${minutesToFrac(g.startMin) * 100}%`,
                            height: `${Math.max((minutesToFrac(g.endMin) - minutesToFrac(g.startMin)) * 100, 3)}%`,
                          }}>
                          {g.title}
                        </div>
                      )}
                    </For>
                    {/* draggable bar */}
                    <Show when={barStartMin() !== null} fallback={
                      <div class="absolute inset-x-0 bottom-2 text-center text-[10px] text-muted-foreground pointer-events-none">
                        Click a slot to set a time
                      </div>
                    }>
                      <div onPointerDown={onBarPointerDown}
                        class="absolute left-8 right-2 rounded-lg px-2 py-0.5 text-[11px] font-semibold overflow-hidden z-[5]"
                        classList={{ 'cursor-grabbing': dragging(), 'cursor-grab': !dragging() }}
                        style={{
                          top: `${minutesToFrac(barStartMin()!) * 100}%`,
                          height: `${Math.max((minutesToFrac(barStartMin()! + barDurMin()) - minutesToFrac(barStartMin()!)) * 100, 5)}%`,
                          background: barGradient, color: '#041620',
                          'box-shadow': dragging() ? '0 6px 20px rgba(171,212,216,.35)' : undefined,
                        }}>
                        <div class="truncate">{title() || (tab() === 'timeblock' ? 'Time block' : 'Task')}</div>
                        <div class="truncate text-[10px] font-medium opacity-80">
                          {clockLabel(minToHHMM(barStartMin()!))} – {clockLabel(minToHHMM(barStartMin()! + barDurMin()))}
                        </div>
                        <div onPointerDown={onResizePointerDown} class="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize" />
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          {/* ── Footer: summary + actions ── */}
          <div class="flex items-center gap-2.5 px-5 py-3 border-t border-border">
            <span class="flex-1 text-xs text-muted-foreground truncate">{summaryText()}</span>
            <button type="button" onClick={close} class="btn-ghost text-sm px-3 py-1.5">Cancel</button>
            <button type="button" onClick={doSave} disabled={saving() || !title().trim()} class="btn-primary text-sm px-4 py-1.5">
              {saving() ? 'Saving…' : isEdit() ? 'Save' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
