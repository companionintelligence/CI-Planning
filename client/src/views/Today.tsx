import { createResource, createMemo, createSignal, onCleanup, onMount, Show, For } from 'solid-js';
import { Plus, AlertCircle, CalendarClock, CalendarCheck, ListTodo, X, Repeat, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, CalendarDays, NotebookPen, Target } from 'lucide-solid';
import { blocks, tasks, taskOf, setElementModal, refetchPatterns, refetchFlightPlan, showToast, selectedDay, setSelectedDay, scheduledByTaskId, isRoutineTask, prefs } from '../stores/index.js';
import { FocusRitual } from '../components/FocusRitual.js';
import { selection, clearSelection, selectedTaskIds, selectedTitles, routineModal, setRoutineModal } from '../stores/selection.js';
import { api, type Task } from '../lib/api.js';
import { localISODate, addDays } from '../lib/dates.js';
import { bucketCounts, tasksInBucket, pageWindow, type BucketKey } from '../lib/task-buckets.js';
import { QuickAdd } from '../components/QuickAdd.js';
import { Planner } from '../components/Planner.js';
import { FlightPlan } from '../components/FlightPlan.js';
import { DayTypeControl } from '../components/DayTypeControl.js';
import { DayStarsRow } from '../components/DayStarsRow.js';
import { MissedReview } from '../components/MissedReview.js';
import { ReplanBanner } from '../components/ReplanBanner.js';
import { PlanInstruct } from '../components/PlanInstruct.js';
import { DayGoals } from '../components/DayGoals.js';

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
  const todayTags = createMemo(() => {
    const set = new Set<string>();
    for (const b of blocks() ?? []) {
      if (b.tag) set.add(b.tag);
      for (const t of taskOf(b.task_id)?.tags ?? []) set.add(t);
    }
    return [...set];
  });

  // ── Header count buttons (Phase O · O3) ────────────────────────────────────
  // Four single-select buckets over the loaded task set, mirroring the server's
  // summary stats. Selecting one reveals its task list below; selecting another
  // swaps; re-selecting closes. The list pages one item at a time.
  const bucketDeps = () => ({
    scheduledIds: new Set([...scheduledByTaskId().keys()]),
    isRoutine: (id: string) => isRoutineTask(id),
  });
  const counts = createMemo(() => bucketCounts(tasks() ?? [], selectedDay(), bucketDeps()));
  const countOf = (key: BucketKey) => counts().find((c) => c.key === key)?.count ?? 0;

  const [selectedBucket, setSelectedBucket] = createSignal<BucketKey | null>(null);
  const [pageOffset, setPageOffset] = createSignal(0);
  const PAGE_SIZE = 3;

  function toggleBucket(key: BucketKey) {
    if (selectedBucket() === key) { setSelectedBucket(null); return; }
    setSelectedBucket(key);
    setPageOffset(0);
  }

  const bucketTasks = createMemo<Task[]>(() => {
    const b = selectedBucket();
    return b ? tasksInBucket(b, tasks() ?? [], selectedDay(), bucketDeps()) : [];
  });
  const pageView = createMemo(() => pageWindow(bucketTasks(), pageOffset(), PAGE_SIZE));

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
            <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary mb-1">
              {isToday() ? 'Today' : 'Day Overview'}
            </div>
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
          {/* Right column: day note affordance + Add button */}
          <div class="flex items-center gap-1.5 flex-shrink-0 self-start">
            <button
              onClick={startEditNote}
              class="btn-icon"
              classList={{ 'text-primary': !!note(), 'text-muted-foreground': !note() }}
              title={note() ? 'Edit day note' : 'Add a note for the day'}
            >
              <NotebookPen size={16} fill={note() ? 'currentColor' : 'none'} />
            </button>
            <Show when={currentFocusBlock()}>
              <button onClick={() => setFocusOpen(true)} class="btn-ghost text-xs px-3 py-1.5 border border-primary/50 text-primary" title="Enter the Focus Ritual for the block in progress">
                <Target size={13} /> Focus
              </button>
            </Show>
            <button onClick={() => setElementModal({ open: true, mode: 'add', kind: null })} class="btn-primary text-xs px-3 py-1.5">
              <Plus size={13} /> Add
            </button>
          </div>
        </div>

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

        {/* Count buttons (Phase O · O3) — single-select; capacity bar on the right. */}
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <CountButton icon={AlertCircle}   value={countOf('overdue')}   label="overdue"   tone="destructive" active={selectedBucket() === 'overdue'}   onClick={() => toggleBucket('overdue')} />
          <CountButton icon={CalendarClock} value={countOf('dueToday')}  label="due today" tone="foreground"  active={selectedBucket() === 'dueToday'}  onClick={() => toggleBucket('dueToday')} />
          <CountButton icon={CalendarCheck} value={countOf('scheduled')} label="scheduled" tone="foreground"  active={selectedBucket() === 'scheduled'} onClick={() => toggleBucket('scheduled')} />
          <CountButton icon={ListTodo}      value={countOf('open')}      label="open"      tone="foreground"  active={selectedBucket() === 'open'}      onClick={() => toggleBucket('open')} />
          <Show when={capacity() && capacity()!.workday_minutes > 0}>
            <div class="ml-auto flex items-center gap-2 min-w-[9rem]">
              <span class={`text-[10px] tabular-nums ${capacityPct() >= 90 ? 'text-destructive' : capacityPct() >= 70 ? 'text-amber-400' : 'text-primary'}`}>
                {capacity()!.scheduled_minutes}m / {capacity()!.workday_minutes}m
              </span>
              <div class="relative h-1.5 w-20 rounded-full bg-background border border-border overflow-hidden">
                <div
                  class="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
                  classList={{ 'bg-amber-400': capacityPct() >= 70, 'bg-destructive': capacityPct() >= 90 }}
                  style={{ width: `${capacityPct()}%` }}
                />
              </div>
            </div>
          </Show>
        </div>

        {/* Selected-bucket task list — ~3 rows + a paging stepper. Each row links to the task. */}
        <Show when={selectedBucket()}>
          <div class="mt-2 rounded-lg border border-border bg-background/40">
            <Show
              when={bucketTasks().length > 0}
              fallback={<p class="px-3 py-2 text-xs text-muted-foreground">Nothing in this bucket.</p>}
            >
              <ul class="divide-y divide-border/60">
                <For each={pageView().visible}>
                  {(t) => (
                    <li>
                      <button
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-primary/5 transition-colors"
                        onClick={() => openTask(t)}
                        title="Open task"
                      >
                        <span class="flex-1 truncate">{t.title}</span>
                        <Show when={t.priority}><span class="text-[10px] text-muted-foreground flex-shrink-0">P{t.priority}</span></Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={pageView().remaining > 0 || pageView().canUp}>
                <div class="flex items-center justify-between px-3 py-1 border-t border-border/60">
                  <span class="text-[10px] text-muted-foreground">
                    <Show when={pageView().remaining > 0} fallback="end of list">+{pageView().remaining} more</Show>
                  </span>
                  <div class="flex items-center gap-1">
                    <button
                      class="btn-icon disabled:opacity-30"
                      disabled={!pageView().canUp}
                      onClick={() => setPageOffset((o) => Math.max(0, o - 1))}
                      title="Show previous"
                    ><ChevronUp size={14} /></button>
                    <button
                      class="btn-icon disabled:opacity-30"
                      disabled={!pageView().canDown}
                      onClick={() => setPageOffset((o) => o + 1)}
                      title="Show next"
                    ><ChevronDown size={14} /></button>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        {/* DAY TYPE row — select + Edit windows on the LEFT, small day-stars on the RIGHT. */}
        <div class="mt-3 pt-3 border-t border-border">
          <DayTypeControl date={selectedDay()} trailing={<DayStarsRow date={selectedDay()} />} />
        </div>
      </div>

      {/* Phase N0: FOCUS card (holds the Today's Brief pop-up — prose + capacity + top tasks) */}
      <DayGoals date={selectedDay()} />

      {/* Natural-language planning instruction — pins become blocks, hints are noted (A4) */}
      <PlanInstruct />
      {/* Replan suggestion — a big-disruption reflow asks to re-plan with AI (B4) */}
      <ReplanBanner />
      {/* Missed-task review — surfaced by the nightly review (hidden when empty) */}
      <MissedReview />

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
 * A Day-Overview count BUTTON — icon · count · label (Phase O · O3). Single-select:
 * clicking reveals its task list below the row; the active button gets a ring +
 * accent fill. No caret. Overdue keeps its danger tone.
 */
function CountButton(props: {
  icon: any; value: number; label: string;
  tone: 'destructive' | 'foreground';
  active: boolean; onClick: () => void;
}) {
  const isDanger = () => props.tone === 'destructive' && props.value > 0;
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
      classList={{
        'border-primary ring-1 ring-primary/40 bg-primary/10': props.active,
        'border-destructive/40 bg-destructive/5': !props.active && isDanger(),
        'border-border bg-background/40 hover:border-primary/50': !props.active && !isDanger(),
      }}
    >
      <props.icon size={12} classList={{ 'text-destructive': isDanger(), 'text-foreground': !isDanger() }} />
      <span class="tabular-nums font-semibold" classList={{ 'text-destructive': isDanger(), 'text-foreground': !isDanger() }}>{props.value}</span>
      <span class="text-muted-foreground">{props.label}</span>
    </button>
  );
}
