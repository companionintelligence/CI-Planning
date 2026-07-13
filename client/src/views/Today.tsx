import { createResource, createMemo, createSignal, onCleanup, onMount, Show, For } from 'solid-js';
import { AlertCircle, CalendarClock, X, Repeat, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, CalendarDays, NotebookPen, Zap, ListFilter } from 'lucide-solid';
import { blocks, tasks, taskOf, tags, isRoutineTask, setElementModal, refetchPatterns, refetchFlightPlan, refetchTasks, showToast, selectedDay, setSelectedDay, prefs } from '../stores/index.js';
import { dueFilterActive, passesDueFilter } from '../lib/due-filter.js';
import { dueFilter, toggleDirection, setHideHabits, setHideRoutines } from '../stores/due-filter.js';
import { FocusRitual } from '../components/FocusRitual.js';
import { selection, clearSelection, selectedTaskIds, selectedTitles, routineModal, setRoutineModal } from '../stores/selection.js';
import { api, type Task } from '../lib/api.js';
import { splitTagNames } from '../lib/multi-tag.js';
import { localISODate, addDays } from '../lib/dates.js';
import { dueItems } from '../lib/task-buckets.js';
import { QuickAdd } from '../components/QuickAdd.js';
import { Planner } from '../components/Planner.js';
import { FlightPlan } from '../components/FlightPlan.js';
import { DayTypeControl } from '../components/DayTypeControl.js';
import { DayStarsRow } from '../components/DayStarsRow.js';
import { ReplanBanner } from '../components/ReplanBanner.js';
import { FocusMenu, BriefMenu } from '../components/DayGoals.js';

/**
 * TODAY — the planner cockpit (Phase G, G5). Four regions on the CI-Hub tokens:
 * **Day Overview** (day/date + today's tag set), **Summary** (overdue/blocked/open
 * + the moved `+ New Task`), the **PLANNER**, and the **Flight-plan** — with the
 * never-closing **drawer** floating at the bottom.
 */
export function Today() {
  const [summary, { refetch: refetchSummary }] = createResource(selectedDay, (date) => api.summary.get(date));

  // Phase O · O1 — the one free-text note per day. Outline affordance when empty,
  // accent-filled when a note exists; opens an inline editor (no modal).
  const [reflections, { refetch: refetchReflections }] = createResource(selectedDay, (date) => api.reflections.get(date));
  const note = () => reflections()?.note ?? null;
  const [editingNote, setEditingNote] = createSignal(false);
  const [noteDraft, setNoteDraft] = createSignal('');
  function startEditNote() {
    setNoteDraft(note()?.body ?? '');
    setEditingNote(true);
  }
  async function saveNote() {
    try {
      await api.reflections.setNote(selectedDay(), noteDraft());
      refetchReflections();
    } catch (err) { showToast((err as Error).message, 'error'); }
    setEditingNote(false);
  }

  const today = () => localISODate();
  const isToday = () => selectedDay() === today();
  const viewedDate = () => new Date(selectedDay() + 'T12:00:00');
  const weekday = () => viewedDate().toLocaleDateString('en-US', { weekday: 'long' });
  const monthDay = () => viewedDate().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const stepDay = (n: number) => setSelectedDay(addDays(selectedDay(), n));

  // The tag set of everything scheduled today — the shape of the day at a glance.
  // AF-11 Slice 5: a block tag can be a comma-joined multi-direction union — add
  // each split name, never the raw joined string.
  const todayTags = createMemo(() => {
    const set = new Set<string>();
    for (const b of blocks() ?? []) {
      for (const n of splitTagNames(b.tag)) set.add(n);
      for (const t of taskOf(b.task_id)?.tags ?? []) set.add(t);
    }
    return [...set];
  });

  function openTask(t: Task) {
    setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: t.id } });
  }

  // ── Phase Z · Z3b — Focus Ritual entry ─────────────────────────────────────
  // A coarse clock (30s) so the "Focus now" affordance appears/clears near block
  // boundaries without waiting for the next blocks refetch. Only ticks matter here;
  // the value is unused. Gated entirely by the Time-Sense master flag.
  const [nowTick, setNowTick] = createSignal(Date.now());
  const focusClock = setInterval(() => setNowTick(Date.now()), 30_000);
  onCleanup(() => clearInterval(focusClock));
  const currentFocusBlock = createMemo(() => {
    // Z5: the Focus screen has its own channel gate on top of the master flag.
    if (!prefs()?.time_sense_enabled || prefs()?.focus_ritual_enabled === false) return null;
    const t = nowTick();
    return (blocks() ?? []).find(
      (b) =>
        (b.block_kind === 'task' || b.block_kind === 'focus' || b.block_kind === 'habit') &&
        b.status === 'planned' &&
        Date.parse(b.start_at) <= t && Date.parse(b.end_at) > t,
    ) ?? null;
  });
  // The next timeline block after the focused one, for the T4 "what's next" line.
  const nextAfterFocus = createMemo(() => {
    const cur = currentFocusBlock();
    if (!cur) return null;
    const after = (blocks() ?? [])
      .filter((b) => b.id !== cur.id && b.block_kind !== 'timeblock' && Date.parse(b.start_at) >= Date.parse(cur.end_at))
      .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    return after[0] ?? null;
  });
  const [focusOpen, setFocusOpen] = createSignal(false);

  // ── Capacity bar (relocated from the removed Morning Briefing, Phase O · O3) ──
  const capacity = () => summary()?.capacity;
  const capacityPct = () => {
    const c = capacity();
    if (!c || c.workday_minutes === 0) return 0;
    return Math.min(100, Math.round((c.scheduled_minutes / c.workday_minutes) * 100));
  };

  // ── Multi-select → "Create Routine" (Phase F) ──────────────────────────────
  // The Shift+= chord (the literal "Shift + +" keys) opens a small modal listing
  // the selected items and lets the user name + create the Routine via
  // POST /api/patterns/promote-from-tasks. Escape clears the selection too. The modal
  // state lives in the selection store so the Planner header "+ Routine" button can open it.
  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === '+' && e.shiftKey) {
      if (selection().size === 0) {
        showToast('Cmd/Ctrl-click items first, then Shift++ to make a Routine', 'default');
        return;
      }
      e.preventDefault();
      setRoutineModal({ open: true, name: '' });
      return;
    }
    if (e.key === 'Escape') {
      clearSelection();
      setRoutineModal({ open: false, name: '' });
    }
  }
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  async function createRoutineFromSelection() {
    const ids = selectedTaskIds(blocks() ?? []);
    if (ids.length === 0) return;
    try {
      await api.patterns.promoteFromTasks(ids, routineModal().name.trim() || undefined);
      refetchPatterns();
      showToast(`Created Routine from ${ids.length} task${ids.length === 1 ? '' : 's'}`, 'success');
      clearSelection();
      setRoutineModal({ open: false, name: '' });
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="flex flex-col gap-4 p-4 md:p-6 page-enter min-h-full">
      {/* Quick task entry — one line of natural language, Enter to add. QuickAdd
          refetches the tasks store itself; onAdded refreshes this view's summary
          resource + the flight-plan so the new task shows up without a reload. */}
      <QuickAdd onAdded={() => { refetchSummary(); refetchFlightPlan(); }} />

      {/* Day Overview — date · tag set · counts, with + New Task top-right */}
      <div class="rounded-xl border border-border bg-card p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="flex items-center gap-1.5">
              <button onClick={() => stepDay(-1)} class="btn-icon" title="Previous day"><ChevronLeft size={16} /></button>
              <div class="flex items-baseline gap-2">
                <h1 class="text-xl font-semibold text-foreground">{weekday()}</h1>
                <span class="text-sm text-muted-foreground">· {monthDay()}</span>
              </div>
              <button onClick={() => stepDay(1)} class="btn-icon" title="Next day"><ChevronRight size={16} /></button>
              <label class="btn-icon relative cursor-pointer" title="Pick a day">
                <CalendarDays size={15} />
                <input
                  type="date"
                  class="absolute inset-0 opacity-0 cursor-pointer"
                  value={selectedDay()}
                  onInput={(e) => e.currentTarget.value && setSelectedDay(e.currentTarget.value)}
                />
              </label>
              <Show when={!isToday()}>
                <button onClick={() => setSelectedDay(today())} class="text-xs text-primary hover:underline ml-1">Jump to today</button>
              </Show>
            </div>
          </div>
          {/* Right column, aligned with the date: Today's Brief · Focus · Note
              (Phase AC — collapsed from the removed FOCUS card). The FAB (App.tsx)
              is the create affordance now; the Add button is gone. */}
          <div class="flex items-center gap-1.5 flex-shrink-0 self-start">
            {/* Today's Brief — popover (same idiom as Focus). */}
            <BriefMenu date={selectedDay()} />
            {/* Focus — bullseye popover: today & this-week focus (add/edit/delete/complete). */}
            <FocusMenu date={selectedDay()} />
            {/* Day note. */}
            <button
              onClick={startEditNote}
              class="btn-icon"
              classList={{ 'text-primary': !!note(), 'text-muted-foreground': !note() }}
              title={note() ? 'Edit day note' : 'Add a note for the day'}
            >
              <NotebookPen size={16} fill={note() ? 'currentColor' : 'none'} />
            </button>
            {/* Focus Ritual entry — only while a block is in progress (Time-Sense). */}
            <Show when={currentFocusBlock()}>
              <button onClick={() => setFocusOpen(true)} class="btn-ghost text-xs px-3 py-1.5 border border-primary/50 text-primary" title="Enter the Focus Ritual for the block in progress">
                <Zap size={13} /> Focus
              </button>
            </Show>
          </div>
        </div>

        {/* Capacity bar — directly below the date (AC follow-up). */}
        <Show when={capacity() && capacity()!.workday_minutes > 0}>
          <div class="mt-2 flex items-center gap-2">
            <span class={`text-[10px] tabular-nums ${capacityPct() >= 90 ? 'text-destructive' : capacityPct() >= 70 ? 'text-amber-400' : 'text-primary'}`}>
              {capacity()!.scheduled_minutes}m / {capacity()!.workday_minutes}m
            </span>
            <div class="relative h-1.5 w-32 rounded-full bg-background border border-border overflow-hidden">
              <div
                class="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
                classList={{ 'bg-amber-400': capacityPct() >= 70, 'bg-destructive': capacityPct() >= 90 }}
                style={{ width: `${capacityPct()}%` }}
              />
            </div>
          </div>
        </Show>

        {/* Phase O · O1 — inline day-note editor (matches the card inline-edit idiom) */}
        <Show when={editingNote()}>
          <div class="mt-3 flex flex-col gap-2">
            <textarea
              autofocus
              rows={3}
              class="input text-sm w-full resize-y"
              placeholder="A note for the day — how it went, what stood out…"
              value={noteDraft()}
              onInput={(e) => setNoteDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingNote(false);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote();
              }}
            />
            <div class="flex justify-end gap-2">
              <button class="btn-ghost text-xs px-2 py-1" onClick={() => setEditingNote(false)}>Cancel</button>
              <button class="btn-primary text-xs px-3 py-1" onClick={saveNote}>Save note</button>
            </div>
          </div>
        </Show>
        <Show when={!editingNote() && note()}>
          <button
            class="mt-3 w-full text-left text-sm text-muted-foreground rounded-lg px-3 py-2 border border-border hover:border-primary/50 transition-colors whitespace-pre-line"
            onClick={startEditNote}
            title="Edit day note"
          >
            {note()!.body}
          </button>
        </Show>

        <Show
          when={todayTags().length > 0}
          fallback={<p class="mt-2 text-sm text-muted-foreground">Nothing scheduled yet.</p>}
        >
          <div class="mt-2 flex flex-wrap gap-1.5">
            <For each={todayTags()}>{(t) => <span class="badge-neutral text-[11px]">#{t}</span>}</For>
          </div>
        </Show>

        {/* Day type + day-stars row. */}
        <div class="mt-3 pt-3 border-t border-border">
          <DayTypeControl date={selectedDay()} hideLabel trailing={<DayStarsRow date={selectedDay()} />} />
        </div>
      </div>

      {/* Phase AB · AB4 — always-visible Due card: the selected day's deadlines +
          an overdue rollup. The primary due surface (the count buttons above stay). */}
      <DueCard date={selectedDay()} onOpen={openTask} />

      {/* Replan suggestion — a big-disruption reflow asks to re-plan with AI (B4) */}
      <ReplanBanner />

      {/* Stacked workspace: Planner on top, Flight-plan below it (full width).
          Someday Time Blocks render on their goal day in the Planner header lane
          (the ConceptLane is retired — CON-2d). */}
      <div class="flex flex-col gap-4">
        <Planner />
        <FlightPlan />
      </div>

      {/* Multi-select indicator (Phase F) — appears when items are picked. */}
      <Show when={selection().size > 0 && !routineModal().open}>
        <div class="fixed bottom-24 left-1/2 -translate-x-1/2 z-30 rounded-full border border-border bg-popover px-4 py-2 shadow-lg flex items-center gap-3 text-xs">
          <span class="font-medium text-foreground">{selection().size} selected</span>
          <span class="text-muted-foreground">Shift+= → Routine · Esc to clear</span>
          <button onClick={() => clearSelection()} class="btn-icon"><X size={14} /></button>
        </div>
      </Show>

      {/* Phase Z · Z3b — Focus Ritual full-screen overlay for the in-progress block. */}
      <Show when={focusOpen() && currentFocusBlock()}>
        <FocusRitual block={currentFocusBlock()!} next={nextAfterFocus()} onClose={() => setFocusOpen(false)} />
      </Show>

      {/* Create-Routine-from-selection modal (Phase F). */}
      <Show when={routineModal().open}>
        <div class="modal-backdrop" onClick={() => setRoutineModal({ open: false, name: '' })}>
          <div class="modal max-w-md" onClick={(e) => e.stopPropagation()}>
            <div class="px-4 py-3 border-b border-border flex items-center gap-2">
              <Repeat size={14} class="text-primary" />
              <span class="text-sm font-semibold text-foreground">Create Routine from {selection().size} item{selection().size === 1 ? '' : 's'}</span>
            </div>
            <div class="p-4 flex flex-col gap-3">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">Name</span>
                <input
                  class="input"
                  placeholder="e.g. Morning routine"
                  autofocus
                  value={routineModal().name}
                  onInput={(e) => setRoutineModal({ open: true, name: e.currentTarget.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') createRoutineFromSelection(); }}
                />
              </label>
              <div class="rounded-md border border-border bg-background/40 p-2 max-h-40 overflow-auto">
                <For each={selectedTitles(blocks() ?? [], tasks() ?? [])}>
                  {(t) => <div class="text-xs text-foreground truncate py-0.5">· {t}</div>}
                </For>
              </div>
              <div class="flex justify-end gap-2 pt-1">
                <button onClick={() => setRoutineModal({ open: false, name: '' })} class="btn-ghost text-sm px-3 py-1.5">Cancel</button>
                <button onClick={createRoutineFromSelection} class="btn-primary text-sm px-4 py-1.5"><Repeat size={13} /> Create</button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

/**
 * Phase AB · AB4 — the pinned, ALWAYS-VISIBLE "Due" card for the selected day.
 * Two groups from the pure `dueItems` selector (same rules as the count buckets,
 * so the card and the buttons never disagree): the day's due tasks, always
 * listed; and an overdue rollup (due before this day, still active) that expands
 * on demand — a destructive-toned pill mirroring the overdue count button. Rows
 * reuse the bucket-list row styling and open the task editor the same way.
 */
function DueCard(props: { date: string; onOpen: (t: Task) => void }) {
  // The day's dues + overdue rollup, then narrowed by the persisted filter
  // (direction include-set · hide habits · hide routines — habits & routines
  // hidden by default). Both lists share one predicate so they stay consistent.
  const items = createMemo(() => {
    const raw = dueItems(tasks() ?? [], props.date);
    const f = dueFilter();
    const keep = (t: Task) => passesDueFilter(t, isRoutineTask(t.id), f);
    return { overdue: raw.overdue.filter(keep), dueToday: raw.dueToday.filter(keep) };
  });
  const [showOverdue, setShowOverdue] = createSignal(false);
  const [expanded, setExpanded] = createSignal(true); // AC — the whole due list is collapsible
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const fmtDay = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Overdue defer — pushes the DEADLINE out from today (AB: due_at is the deadline
  // axis, so this is what clears the debt; engine reschedule moves scheduled_for
  // and would leave the row overdue forever).
  const DEFER_STEPS = [{ days: 1, label: '+1d' }, { days: 3, label: '+3d' }, { days: 7, label: '+1w' }] as const;
  async function deferDue(t: Task, days: number, label: string) {
    try {
      await api.tasks.update(t.id, { due_at: addDays(localISODate(), days) });
      refetchTasks();
      showToast(`"${t.title}" due ${label}`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const Row = (p: { task: Task; when: string; danger?: boolean }) => (
    <li class="flex items-center">
      <button
        class="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-primary/5 transition-colors"
        classList={{ 'text-xs': !!p.danger, 'text-sm': !p.danger }}
        onClick={() => props.onOpen(p.task)}
        title="Open task"
      >
        <span class="flex-1 truncate">{p.task.title}</span>
        <span
          class="text-[10px] tabular-nums flex-shrink-0"
          classList={{ 'text-destructive': !!p.danger, 'text-muted-foreground': !p.danger }}
        >{p.when}</span>
        <Show when={p.task.priority}>
          <span class="text-[10px] text-muted-foreground flex-shrink-0">P{p.task.priority}</span>
        </Show>
      </button>
      {/* Defer chips — overdue rows only: push the due date out from today. */}
      <Show when={p.danger}>
        <div class="flex items-center gap-1 pr-2 flex-shrink-0">
          <For each={DEFER_STEPS}>
            {(s) => (
              <button
                type="button"
                onClick={() => deferDue(p.task, s.days, s.label)}
                class="text-[10px] tabular-nums px-1.5 py-0.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary transition-colors"
                title={`Defer due date ${s.label}`}
              >{s.label}</button>
            )}
          </For>
        </div>
      </Show>
    </li>
  );

  return (
    <div class="rounded-xl border border-border bg-card p-4">
      <div class="flex items-center justify-between gap-2">
        {/* Header doubles as the collapse toggle for the whole due list. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => { const next = !v; if (!next) setShowOverdue(false); return next; })}
          aria-expanded={expanded()}
          class="flex items-center gap-2"
          title={expanded() ? 'Collapse due list' : 'Expand due list'}
        >
          <CalendarClock size={13} class="text-primary" />
          <span class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Due</span>
          <span class="text-[10px] text-muted-foreground">deadlines for this day</span>
          <Show when={expanded()} fallback={<ChevronDown size={12} class="text-muted-foreground" />}>
            <ChevronUp size={12} class="text-muted-foreground" />
          </Show>
        </button>
        <div class="flex items-center gap-1.5">
          {/* Overdue rollup toggle — the optional filter; hidden when there's no debt. */}
          <Show when={items().overdue.length > 0}>
            <button
              type="button"
              aria-expanded={showOverdue()}
              onClick={() => setShowOverdue((v) => !v)}
              class="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/5 px-2.5 py-1 text-xs transition-colors hover:border-destructive"
              title={showOverdue() ? 'Hide overdue tasks' : 'Show overdue tasks'}
            >
              <AlertCircle size={12} class="text-destructive" />
              <span class="tabular-nums font-semibold text-destructive">{items().overdue.length}</span>
              <span class="text-muted-foreground">overdue</span>
              <Show when={showOverdue()} fallback={<ChevronDown size={12} class="text-muted-foreground" />}>
                <ChevronUp size={12} class="text-muted-foreground" />
              </Show>
            </button>
          </Show>
          {/* Multi-select filter menu — direction · hide habits · hide routines. */}
          <DueFilterMenu />
        </div>
      </div>

      {/* Body — collapsible (AC). Overdue rollup (optional filter) then the day's dues. */}
      <Show when={expanded()}>
        {/* Overdue list (expanded rollup) — oldest debt first, red due dates. */}
        <Show when={showOverdue() && items().overdue.length > 0}>
          <ul class="mt-2 divide-y divide-border/60 rounded-lg border border-destructive/30 bg-background/40">
            <For each={items().overdue}>
              {(t) => <Row task={t} when={t.due_at ? fmtDay(t.due_at) : ''} danger />}
            </For>
          </ul>
        </Show>

        {/* The day's due list. */}
        <Show
          when={items().dueToday.length > 0}
          fallback={<p class="mt-2 text-sm text-muted-foreground">Nothing due this day.</p>}
        >
          <ul class="mt-2 divide-y divide-border/60 rounded-lg border border-border bg-background/40">
            <For each={items().dueToday}>
              {(t) => <Row task={t} when={t.due_at ? fmtTime(t.due_at) : ''} />}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

/**
 * The Due card's multi-select filter dropdown. Five options — the three direction
 * tags (INCLUDE filter) plus "Hide habits" / "Hide routines" (on by default). The
 * menu stays open while toggling (each option filters the list in real time via the
 * persisted `dueFilter` signal) and closes only on a click-away. Selections persist
 * across reloads (localStorage), so the last settings stay active until changed again.
 */
function DueFilterMenu() {
  const [open, setOpen] = createSignal(false);
  const directionTags = createMemo(() => (tags() ?? []).filter((t) => t.kind === 'direction'));
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open()}
        class="btn-icon"
        classList={{ 'text-primary': dueFilterActive(dueFilter()), 'text-muted-foreground': !dueFilterActive(dueFilter()) }}
        title="Filter due list"
      >
        <ListFilter size={15} />
      </button>
      <Show when={open()}>
        {/* click-away backdrop — the only thing that closes the menu. z-40/z-50 sit
            ABOVE the Planner's internal grid layers (which reach z-30 in this same
            root stacking context), so the menu is never obscured by the calendar. */}
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div class="absolute right-0 mt-1 z-50 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-3 shadow-lg">
          {/* Direction include-set */}
          <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground mb-1.5">Direction</div>
          <Show
            when={directionTags().length > 0}
            fallback={<p class="text-xs text-muted-foreground mb-2">No direction tags yet.</p>}
          >
            <div class="flex flex-col gap-1.5 mb-3">
              <For each={directionTags()}>
                {(t) => (
                  <label class="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input
                      type="checkbox"
                      class="accent-primary w-4 h-4"
                      checked={dueFilter().directions.includes(t.name)}
                      onChange={() => toggleDirection(t.name)}
                    />
                    <span class="text-foreground">{cap(t.name)}</span>
                  </label>
                )}
              </For>
            </div>
          </Show>

          <div class="border-t border-border pt-2 flex flex-col gap-1.5">
            <label class="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                class="accent-primary w-4 h-4"
                checked={dueFilter().hideHabits}
                onChange={(e) => setHideHabits(e.currentTarget.checked)}
              />
              <span class="text-foreground">Hide habits</span>
            </label>
            <label class="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                class="accent-primary w-4 h-4"
                checked={dueFilter().hideRoutines}
                onChange={(e) => setHideRoutines(e.currentTarget.checked)}
              />
              <span class="text-foreground">Hide routines</span>
            </label>
          </div>
        </div>
      </Show>
    </div>
  );
}
