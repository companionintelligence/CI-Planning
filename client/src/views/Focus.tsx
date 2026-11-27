import { createSignal, createMemo, createResource, createEffect, Show, For, onCleanup } from 'solid-js';
import { setActiveTask } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';
import { ChevronDown, ChevronRight, ChevronLeft, Crosshair, Play, Check, RotateCcw, NotebookPen, SlidersHorizontal, CalendarDays, X } from 'lucide-solid';
import { FocusRitual } from '../components/FocusRitual.js';
import { FocusLab } from '../components/FocusLab.js';
import { FocusReminders } from '../components/FocusReminders.js';
import { TrialityBanner } from '../components/TrialityBanner.js';
import { BriefMenu, FocusMenu } from '../components/DayGoals.js';
import { EmptyStateConnectCTA } from '../components/EmptyStateConnectCTA.js';
import { blocks, tasks, taskOf, prefs, tags, patternPrefs, refetchTasks, refetchBlocks, showToast, selectedDay, setSelectedDay, openCloseRitual } from '../stores/index.js';
import { api, type Block, type Task } from '../lib/api.js';
import { localISODate } from '../lib/dates.js';
import { focusState, formatRemaining } from '../lib/focus.js';
import { resolveSessionMinutes, resolveFocusTint } from '../lib/focus-appearance.js';
import { directionColorForTask } from '../lib/pattern-meta.js';
import { focusAppearance } from '../stores/index.js';
import { minutesIntoDay } from '../lib/grid.js';
import { buildFocusItems, countPastRows, memberPast, itemPast, sectionPast, type BuiltSection } from '../lib/focus-sections.js';
import { LockToggle } from '../components/LockToggle.js';
import { SectionAddTask } from '../components/SectionAddTask.js';
import { DayReflowBanner } from '../components/DayReflowBanner.js';
import { blockColorVar } from '../lib/textures.js';
import { categoryPrefs, textureColorSource, conflictedBlockIds } from '../stores/index.js';
import { ModalSheet, PageHeader, Toolbar } from '../ui/index.js';

function taskNeedsApproval(task?: Task): boolean {
  return !!task?.auto_generated && !task.human_approved_at;
}

/**
 * FOCUS — the pre-Today view: "what am I doing right now, and what's left today?"
 *
 * A deliberately simple, single-column list of the day's tasks: UPCOMING items
 * (in start order; time-less ones last as "Anytime") with past/completed items
 * collapsed into one expandable row. When Time-Sense is enabled and a block is in
 * progress, a hero card shows the live countdown (lib/focus.ts state math) and
 * opens the full-screen Focus Ritual — the same Z3b surface Today launches.
 *
 * Reuses the shared `blocks` resource keyed by the selected day, so a calendar
 * choice shows that day's placements and task notes.
 */

// Doable kinds. A `timeblock` is deliberately absent: it is a CONTAINER, so Phase 2
// renders it as a section rather than a row, and it never becomes the Time-Sense hero.
// `meeting` stays out too — Focus answers "what am I doing", not "what is on my calendar".
const FOCUS_KINDS = new Set(['task', 'focus', 'habit']);

/** A Time Block prepared for grouping — the row shape `buildFocusItems` needs. */
interface Container {
  block: Block;
  id: string;
  sortMin: number;
  endMs: number | null;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

interface Entry {
  key: string;
  taskId?: string;
  title: string;
  timeLabel: string | null; // null = no clock time ("Anytime")
  sortMin: number;
  startMs: number | null;
  endMs: number | null;
  done: boolean;
  /** Phase 2 — the Time Block this row nests under, if any. */
  parentBlockId: string | null;
  task?: Task;
  block?: Block;
}

export function Focus() {
  const viewDay = () => selectedDay();
  const isToday = () => viewDay() === localISODate();
  const [datePickerOpen, setDatePickerOpen] = createSignal(false);
  const [pickerMonth, setPickerMonth] = createSignal(new Date(`${viewDay()}T12:00:00`));
  const [pickerDay, setPickerDay] = createSignal(viewDay());
  const monthLabel = () => pickerMonth().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const monthDays = () => {
    const month = pickerMonth();
    const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
    const offset = first.getDay();
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12).getDate();
    return [...Array(offset).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  };
  const dateKey = (day: number) => `${pickerMonth().getFullYear()}-${String(pickerMonth().getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  function openDatePicker() { setPickerDay(viewDay()); setPickerMonth(new Date(`${viewDay()}T12:00:00`)); setDatePickerOpen(true); }

  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  const [pastOpen, setPastOpen] = createSignal(false);
  const [ritualOpen, setRitualOpen] = createSignal(false);
  // The note follows the viewed day, including when the date picker changes it.
  const [reflections, { refetch: refetchReflections }] = createResource(viewDay, (date) => api.reflections.get(date));
  const note = () => reflections()?.note ?? null;
  const [editingNote, setEditingNote] = createSignal(false);
  const [noteDraft, setNoteDraft] = createSignal('');
  function startEditNote() {
    setNoteDraft(note()?.body ?? '');
    setEditingNote(true);
  }
  async function saveNote() {
    try {
      await api.reflections.setNote(viewDay(), noteDraft());
      void refetchReflections();
    } catch (err) { showToast((err as Error).message, 'error'); }
    setEditingNote(false);
  }
  // The block the user explicitly STARTED from this view (start-any-task-now). Drives the
  // Focus Ritual directly, independent of the Time-Sense master flag — an explicit start is
  // a deliberate request for the timer, so it runs even if the ambient hero is off.
  const [startedBlock, setStartedBlock] = createSignal<Block | null>(null);
  const [starting, setStarting] = createSignal<string | null>(null); // entry key mid-start
  const [labOpen, setLabOpen] = createSignal(false);         // the Focus Lab pop-up

  // ── The day's entries: placed blocks first, then unplaced scheduled-for-today tasks ──
  const entries = createMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const placedTaskIds = new Set<string>();
    for (const b of blocks() ?? []) {
      if (!FOCUS_KINDS.has(b.block_kind) || b.all_day) continue;
      const t = b.task_id ? taskOf(b.task_id) : undefined;
      if (b.task_id) placedTaskIds.add(b.task_id);
      const startMs = Date.parse(b.start_at);
      const endMs = Date.parse(b.end_at);
      out.push({
        key: `b:${b.id}`,
        taskId: b.task_id,
        title: t?.title ?? b.title,
        timeLabel: fmtTime(b.start_at),
        sortMin: minutesIntoDay(b.start_at, viewDay()),
        startMs, endMs,
        done: t?.status === 'done' || b.status === 'completed' || b.status === 'done',
        parentBlockId: b.parent_block_id ?? null,
        task: t, block: b,
      });
    }
    for (const t of tasks() ?? []) {
      if ((t.scheduled_for ?? '').slice(0, 10) !== viewDay()) continue;
      if (t.parent_id) continue; // keep it simple: top-level tasks only
      if (t.status === 'cancelled') continue;
      if (placedTaskIds.has(t.id)) continue;
      let sortMin = 24 * 60; // time-less → after every timed item
      let timeLabel: string | null = null;
      let startMs: number | null = null;
      let endMs: number | null = null;
      if (t.task_time) {
        const [h, m] = t.task_time.split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) {
          sortMin = h * 60 + m;
          const d = new Date(`${viewDay()}T${t.task_time.length === 5 ? t.task_time : '00:00'}:00`);
          startMs = d.getTime();
          endMs = startMs + Math.max(15, t.estimated_minutes || 30) * 60_000;
          timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        }
      }
      out.push({ key: `t:${t.id}`, taskId: t.id, title: t.title, timeLabel, sortMin, startMs, endMs, done: t.status === 'done', parentBlockId: null, task: t });
    }
    return out.sort((a, b) => a.sortMin - b.sortMin);
  });

  // ── Phase 2: Time Blocks are SECTIONS, not rows ───────────────────────────────
  // A Time Block is a container, not a doing, so it never enters `entries` (and so
  // never becomes the Time-Sense hero — see `currentBlock`, which still filters on
  // FOCUS_KINDS). Its member task blocks nest under it instead of sitting beside it.
  const containers = createMemo(() =>
    (blocks() ?? [])
      .filter((b) => b.block_kind === 'timeblock' && !b.all_day)
      .map((b) => ({
        block: b,
        id: b.id,
        sortMin: minutesIntoDay(b.start_at, viewDay()),
        endMs: Date.parse(b.end_at),
      })),
  );

  // The grouping memo deliberately does NOT read `now()`. It recomputes only when the
  // day's rows change, so the item objects keep their identity across the 30-second
  // tick — `<For>` keys by reference, and re-created rows would wipe whatever is being
  // typed into a section's add box. Pastness is asked at render time instead.
  const items = createMemo(() => buildFocusItems(entries(), containers()));
  const upcoming = () => isToday() ? items().filter((it) => !itemPast(it, now())) : items();
  const past = () => isToday() ? items().filter((it) => itemPast(it, now())) : [];
  const pastTally = () => isToday() ? countPastRows(items(), now()) : { rows: 0, done: 0 };

  const isPast = (e: Entry) => isToday() && memberPast(e, now());
  const isNow = (e: Entry) => !e.done && e.startMs != null && e.endMs != null && e.startMs <= now() && e.endMs > now();

  // Collapse state resets on date changes. Sections
  // start EXPANDED: the view's job is "what am I doing", and a collapsed container
  // hides exactly that.
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(() => {
    viewDay();
    setCollapsed(new Set<string>());
    setPastOpen(false);
    setEditingNote(false);
  });
  const isCollapsed = (id: string) => collapsed().has(id);
  const toggleSection = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // ── Time-Sense integration (Phase Z) — mirrors Today's gating exactly ──────────
  const timeSenseOn = () => !!prefs()?.time_sense_enabled && prefs()?.focus_ritual_enabled !== false;
  const currentBlock = createMemo(() => {
    if (!timeSenseOn() || !isToday()) return null;
    const t = now();
    return (blocks() ?? []).find(
      (b) => FOCUS_KINDS.has(b.block_kind) && b.status === 'planned' && Date.parse(b.start_at) <= t && Date.parse(b.end_at) > t,
    ) ?? null;
  });
  const heroState = () => {
    const b = currentBlock();
    return b ? focusState(now(), Date.parse(b.start_at), Date.parse(b.end_at)) : null;
  };

  // The next HARD commitment after `fromMs` — any timed block (task, focus, habit, or a
  // meeting), excluding one block id (the one we're about to move). Meetings count: they're
  // the collisions the overrun warning is about.
  function nextCommitmentAfter(fromMs: number, excludeId?: string): Block | null {
    return (blocks() ?? [])
      .filter((b) => !b.all_day && b.id !== excludeId && Date.parse(b.start_at) > fromMs)
      .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))[0] ?? null;
  }

  // ── Start any task, now (start-any-task-at-anytime + Time-Sense launch) ─────────
  // Warn if the task can't finish before the next commitment; then anchor a "now" block
  // for it (move an existing placement, or create one) and open the Focus Ritual timer.
  async function startTask(entry: Entry) {
    if (!entry.taskId || starting()) return;
    // If it's already the in-progress block, just (re)enter the timer.
    if (entry.block && isNow(entry)) { setStartedBlock(entry.block); return; }

    const durMin = resolveSessionMinutes(focusAppearance().sessionMinutes, entry.task?.estimated_minutes);
    const nowMs = Date.now();
    const next = nextCommitmentAfter(nowMs, entry.block?.id);
    if (next) {
      const gapMin = Math.round((Date.parse(next.start_at) - nowMs) / 60_000);
      if (durMin > gapMin) {
        const nextTitle = (next.task_id ? taskOf(next.task_id)?.title : null) ?? next.title;
        const ok = window.confirm(
          `"${entry.title}" needs about ${durMin} min, but there's only ${gapMin} min until ` +
          `"${nextTitle}" at ${fmtTime(next.start_at)}.\n\nStart it now anyway?`,
        );
        if (!ok) return;
      }
    }

    const startISO = new Date(nowMs).toISOString();
    const endISO = new Date(nowMs + durMin * 60_000).toISOString();
    setStarting(entry.key);
    try {
      const block = entry.block
        ? (await api.blocks.update(entry.block.id, { start_at: startISO, end_at: endISO })).block
        : (await api.blocks.create({ title: entry.title, task_id: entry.taskId, block_kind: 'task', start_at: startISO, end_at: endISO })).block;
      void refetchBlocks();
      void refetchTasks();
      setStartedBlock(block); // opens the ritual
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setStarting(null);
    }
  }

  // Hero "Start" — (re)anchor the in-progress block to NOW for a fresh full estimate
  // (for when you're starting late), then open the timer. Distinct from "Enter Focus",
  // which resumes the block's remaining scheduled time.
  async function restartHeroNow(block: Block) {
    if (starting()) return;
    const durMin = resolveSessionMinutes(
      focusAppearance().sessionMinutes,
      block.task_id ? taskOf(block.task_id)?.estimated_minutes : null,
    );
    const nowMs = Date.now();
    setStarting(block.id);
    try {
      const r = await api.blocks.update(block.id, {
        start_at: new Date(nowMs).toISOString(),
        end_at: new Date(nowMs + durMin * 60_000).toISOString(),
      });
      void refetchBlocks();
      setStartedBlock(r.block);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setStarting(null);
    }
  }

  // What the ritual would be lit with right now if the owner set no override — the
  // in-progress task's Work / Home / Community colour. Previewed in the Focus Lab.
  const directionTint = () => {
    const b = currentBlock();
    return resolveFocusTint({
      task: b?.task_id ? taskOf(b.task_id) : null,
      tagDefs: tags() ?? [],
      patternPrefs: patternPrefs()?.prefs ?? {},
      block: b ?? null,
      categoryPrefs: categoryPrefs()?.prefs ?? {},
    });
  };

  // The block the ritual runs over: an explicit start wins; else the auto hero on "Enter Focus".
  const ritualBlock = () => startedBlock() ?? (ritualOpen() ? currentBlock() : null);
  const ritualNext = () => {
    const b = ritualBlock();
    return b ? nextCommitmentAfter(Date.parse(b.end_at) - 1, b.id) : null;
  };
  function closeRitual() { setStartedBlock(null); setRitualOpen(false); }

  async function toggleDone(e: Entry) {
    if (!e.taskId) return;
    try {
      if (e.done) await api.tasks.update(e.taskId, { status: 'open', completed_at: null });
      else {
        await api.tasks.update(e.taskId, { completed: true });
        // The row knows its block, so the ritual can measure against the span the user
        // actually just worked rather than guessing at the earliest placement.
        openCloseRitual(e.task ?? taskOf(e.taskId));
      }
      refetchTasks();
      refetchBlocks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  /** Phase 7 — this row's block is stranded outside its direction's windows. */
  const strandedRow = (e: Entry) => !!e.block && conflictedBlockIds().has(e.block.id);

  const dotColor = (e: Entry): string =>
    e.task ? directionColorForTask({ tags: e.task.tags ?? [] }, tags() ?? [], patternPrefs()?.prefs ?? {}) : 'var(--border)';

  /** The tasks already inside a section — so its add box never offers a duplicate. */
  const memberTaskIds = (s: BuiltSection<Entry, Container>): ReadonlySet<string> =>
    new Set(s.members.map((m) => m.taskId).filter((id): id is string => !!id));

  /**
   * A Time Block, as a section: its own header (title, span, progress, lock) with its
   * member rows nested underneath. The header is the collapse control; the lock is the
   * same `LockToggle` the drawer and the Planner card use, so a Time Block's mobility
   * reads identically wherever you meet it (Phase 1).
   */
  const Section = (props: { section: BuiltSection<Entry, Container>; dim?: boolean }) => {
    const b = () => props.section.container.block;
    const open = () => !isCollapsed(b().id);
    return (
      <div
        class="rounded-xl border transition-colors"
        classList={{ 'opacity-50': !!props.dim, 'border-border/60': true }}
      >
        <div class="flex items-center gap-3 px-3 py-2.5">
          <button
            onClick={() => toggleSection(b().id)}
            aria-expanded={open()}
            class="flex items-center gap-2 min-w-0 flex-1 text-left"
            title={open() ? 'Collapse this Time Block' : 'Expand this Time Block'}
          >
            <Show when={open()} fallback={<ChevronRight size={13} class="flex-shrink-0 text-muted-foreground" />}>
              <ChevronDown size={13} class="flex-shrink-0 text-muted-foreground" />
            </Show>
            <span
              class="w-1.5 h-4 rounded-sm flex-shrink-0"
              style={{ 'background-color': blockColorVar(b(), categoryPrefs()?.prefs, { source: textureColorSource(), tags: tags(), categories: categoryPrefs()?.prefs, directions: patternPrefs()?.prefs }) }}
            />
            <span class="text-sm font-medium text-foreground truncate">{b().title}</span>
            <span class="text-[11px] font-mono tabular-nums text-muted-foreground flex-shrink-0">
              {fmtTime(b().start_at)} – {fmtTime(b().end_at)}
            </span>
          </button>
          <span class="text-[11px] text-muted-foreground flex-shrink-0 tabular-nums">
            <Show when={props.section.total > 0} fallback="empty">
              {props.section.doneCount}/{props.section.total} done
            </Show>
          </span>
          <LockToggle block={b()} class="flex-shrink-0" />
        </div>
        <Show when={open()}>
          <div class="animate-slide-down">
            <Show when={props.section.total > 0}>
              <div class="flex flex-col gap-1.5 px-2 pb-2 pl-6">
                <For each={props.section.members}>{(e) => <Row entry={e} dim={props.dim} />}</For>
              </div>
            </Show>
            {/* Phase 3 — search the backlog or create, straight into this block. Not
                offered on a section that is already behind you: adding work to a
                finished or elapsed Time Block would place it in the past. */}
            <Show when={!sectionPast(props.section, now())}>
              <SectionAddTask block={b()} memberTaskIds={memberTaskIds(props.section)} />
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  const Row = (props: { entry: Entry; dim?: boolean }) => (
    <div
      class="flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors"
      classList={{
        'opacity-50': !!props.dim,
        'task-approval-outline': taskNeedsApproval(props.entry.task),
        'border-accent-hi/50 bg-accent-hi/5': isNow(props.entry) && !strandedRow(props.entry),
        'border-destructive bg-destructive/5': strandedRow(props.entry),
        'border-border/60': !isNow(props.entry) && !strandedRow(props.entry),
      }}
    >
      <span class="w-16 flex-shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground">
        {props.entry.timeLabel ?? 'Anytime'}
      </span>
      <button
        onClick={() => toggleDone(props.entry)}
        disabled={!props.entry.taskId}
        class="w-[16px] h-[16px] rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors"
        style={props.entry.done ? { background: dotColor(props.entry), 'border-color': dotColor(props.entry) } : { 'border-color': dotColor(props.entry) }}
        title={props.entry.taskId ? (props.entry.done ? 'Mark open' : 'Mark done') : undefined}
      >
        <Show when={props.entry.done}><Check size={10} class="text-white" /></Show>
      </button>
      <span
        class="flex-1 min-w-0 text-sm truncate"
        classList={{ 'line-through text-muted-foreground': props.entry.done, 'text-foreground': !props.entry.done, 'cursor-pointer hover:text-primary': !!props.entry.taskId }}
        onClick={() => { if (props.entry.taskId) { setActiveTask(props.entry.taskId); revealDetails(); } }}
      >
        {props.entry.title}
      </span>
      <Show when={isNow(props.entry)}>
        <span class="text-[10px] font-semibold uppercase tracking-wider text-accent-hi flex-shrink-0">now</span>
      </Show>
      {/* Start any task, now — anchors a "now" block + opens the Time-Sense timer. */}
      <Show when={props.entry.taskId && !props.entry.done}>
        <button
          onClick={() => startTask(props.entry)}
          disabled={starting() === props.entry.key}
          class="flex items-center gap-1 h-7 px-2.5 rounded-lg bg-accent-hi/15 text-accent-hi text-[11px] font-semibold hover:bg-accent-hi/25 transition-colors flex-shrink-0 disabled:opacity-60"
          title={isNow(props.entry) ? 'Enter the focus timer' : 'Start now — begin a focus timer for this task'}
        >
          <Play size={11} /> {isNow(props.entry) ? 'Focus' : 'Start'}
        </button>
      </Show>
    </div>
  );

  return (
    <div class="view-container page-enter">
      {/* Date selection changes the tasks, blocks, and note in this view. */}
      <PageHeader
        title={<><Crosshair size={18} class="text-accent-hi" /> Focus</>}
        sub={new Date(`${viewDay()}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      >
        <Toolbar label="Focus actions">
          <button class="btn-icon flex-shrink-0" title="Choose Focus day" aria-label="Choose Focus day" onClick={openDatePicker}>
            <CalendarDays size={16} />
          </button>
          <Show when={!isToday()}><button class="btn-ghost text-xs" onClick={() => setSelectedDay(localISODate())}>Today</button></Show>
          <BriefMenu date={viewDay()} />
          <FocusMenu date={viewDay()} />
          {/* Focus Lab — session length + the timer's colour. Display-only settings;
              the style itself is a standing pref in Settings. */}
          <button
            onClick={() => setLabOpen(true)}
            class="btn-icon"
            title="Focus Lab — session length and timer colour"
          >
            <SlidersHorizontal size={16} />
          </button>
          <button
            onClick={startEditNote}
            class="btn-icon"
            classList={{ 'text-primary': !!note(), 'text-muted-foreground': !note() }}
            title={note() ? 'Edit day note' : 'Add a note for the day'}
          >
            <NotebookPen size={16} fill={note() ? 'currentColor' : 'none'} />
          </button>
        </Toolbar>
      </PageHeader>
      <Show when={datePickerOpen()}>
        <ModalSheet
          open={datePickerOpen()}
          title="Choose Focus day"
          ariaLabel="Choose Focus day"
          onClose={() => setDatePickerOpen(false)}
          class="max-w-sm rounded-2xl"
          header={
            <header class="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-4 pb-3">
              <button class="btn-icon" aria-label="Previous month" onClick={() => setPickerMonth(new Date(pickerMonth().getFullYear(), pickerMonth().getMonth() - 1, 1, 12))}><ChevronLeft size={18}/></button>
              <h2 class="flex-1 text-center text-lg font-semibold text-foreground">{monthLabel()}</h2>
              <button class="btn-icon" aria-label="Next month" onClick={() => setPickerMonth(new Date(pickerMonth().getFullYear(), pickerMonth().getMonth() + 1, 1, 12))}><ChevronRight size={18}/></button>
              <button class="btn-icon" aria-label="Close calendar" onClick={() => setDatePickerOpen(false)}><X size={16}/></button>
            </header>
          }
          footer={
            <div class="flex items-center justify-between gap-2 px-4 pb-1">
              <button class="btn-ghost" onClick={() => setPickerDay(localISODate())}>Today</button>
              <div class="flex gap-2"><button class="btn-ghost" onClick={() => setDatePickerOpen(false)}>Cancel</button><button class="btn-primary" onClick={() => { setSelectedDay(pickerDay()); setDatePickerOpen(false); }}>Choose day</button></div>
            </div>
          }
        >
          <div class="px-4">
            <div class="mb-1 grid grid-cols-7 text-center text-xs font-semibold uppercase text-muted-foreground">
              <For each={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']}>{(day) => <div class="py-2">{day}</div>}</For>
            </div>
            <div class="grid grid-cols-7 gap-1">
              <For each={monthDays()}>{(day) => day === null
                ? <div aria-hidden="true" />
                : <button type="button" class={`aspect-square rounded-full text-sm transition-colors hover:bg-primary/15 ${pickerDay() === dateKey(day) ? 'bg-primary text-primary-foreground font-semibold' : 'text-foreground'}`} aria-label={new Date(`${dateKey(day)}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} aria-pressed={pickerDay() === dateKey(day)} onClick={() => setPickerDay(dateKey(day))}>{day}</button>}
              </For>
            </div>
          </div>
        </ModalSheet>
      </Show>

      {/* Inline day-note editor + display (the Today idiom — no modal). */}
      <Show when={editingNote()}>
        <div class="mb-5 flex flex-col gap-2">
          <textarea
            class="input text-sm min-h-[64px]"
            placeholder="A note for this day…"
            value={noteDraft()}
            onInput={(e) => setNoteDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveNote(); }}
          />
          <div class="flex gap-2">
            <button class="btn-primary text-xs px-3 py-1" onClick={() => void saveNote()}>Save note</button>
            <button class="btn-ghost text-xs px-3 py-1" onClick={() => setEditingNote(false)}>Cancel</button>
          </div>
        </div>
      </Show>
      <Show when={!editingNote() && note()}>
        <button class="mb-5 text-left text-xs text-muted-foreground italic hover:text-foreground" onClick={startEditNote}>
          {note()!.body}
        </button>
      </Show>

      {/* Time-Sense hero — the in-progress block, live countdown, Focus Ritual launcher. */}
      <Show when={currentBlock()}>
        {(b) => (
          <div
            class="mb-5 rounded-2xl border border-accent-hi/40 bg-accent-hi/5 p-4"
            classList={{
              'task-approval-outline': taskNeedsApproval(b().task_id ? taskOf(b().task_id!) : undefined),
            }}
          >
            <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-accent-hi mb-1.5">Focus now</div>
            <div class="flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div class="text-base font-semibold text-foreground truncate">
                  {(b().task_id ? taskOf(b().task_id!)?.title : null) ?? b().title}
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  {fmtTime(b().start_at)} – {fmtTime(b().end_at)}
                  <Show when={heroState()}>
                    {(s) => <span classList={{ 'text-destructive font-medium': s().phase === 'warning' }}> · {formatRemaining(s().remainingMs)} left</span>}
                  </Show>
                </div>
              </div>
              {/* Small "Start" affordance — re-anchor to now (fresh clock); distinct from
                  the primary "Enter Focus" resume. */}
              <button
                onClick={() => restartHeroNow(b())}
                disabled={starting() === b().id}
                class="flex items-center gap-1 h-9 px-3 rounded-sm border border-accent-hi/50 text-accent-hi text-[13px] font-semibold hover:bg-accent-hi/10 transition-colors flex-shrink-0 disabled:opacity-60"
                title="Start fresh from now — reset the timer to a full estimate"
              >
                <RotateCcw size={13} /> Start
              </button>
              <button
                onClick={() => setRitualOpen(true)}
                class="flex items-center gap-1.5 h-9 px-4 rounded-sm bg-accent-hi text-accent-hi-foreground text-sm font-semibold hover:brightness-110 transition-all flex-shrink-0"
              >
                <Play size={14} /> Enter Focus
              </button>
            </div>
            {/* Depletion bar — same math the ritual's ambient layer uses. */}
            <Show when={heroState()}>
              {(s) => (
                <div class="mt-3 h-1 rounded-sm bg-muted/60 overflow-hidden">
                  <div class="h-full rounded-sm bg-accent-hi transition-all" style={{ width: `${(1 - s().depletionFrac) * 100}%` }} />
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>

      {/* Triality (0139, design §9.1) — the suggestion banner, between the hero and
          the list: Focus is the "what should I do right now" view, so this is the
          acting home. Flag-gated inside the component; renders nothing when off,
          collapsed for the day, or still loading. */}
      <TrialityBanner />

      {/* #388: reminders — list, create, delete (the toast keeps Snooze). */}
      <FocusReminders />

      {/* Phase 7 — stranded tasks + the confirmed reflow. */}
      <DayReflowBanner />

      {/* Past tasks — collapsed into one expandable row. */}
      <Show when={past().length > 0}>
        <button
          onClick={() => setPastOpen((v) => !v)}
          class="w-full flex items-center gap-2 px-3 py-2 mb-2 rounded-xl text-xs text-muted-foreground hover:text-foreground bg-muted/30 transition-colors"
          aria-expanded={pastOpen()}
        >
          <Show when={pastOpen()} fallback={<ChevronRight size={12} />}><ChevronDown size={12} /></Show>
          {/* Counts ROWS, not items: a past Time Block contributes its members, so the
              number still answers "how many tasks are behind me". */}
          {pastTally().rows} earlier task{pastTally().rows === 1 ? '' : 's'}
          <span class="ml-auto">{pastTally().done} done</span>
        </button>
        <Show when={pastOpen()}>
          <div class="flex flex-col gap-1.5 mb-4 animate-slide-down">
            <For each={past()}>
              {(it) => (
                <Show when={it.kind === 'section'} fallback={<Row entry={(it as { member: Entry }).member} dim />}>
                  <Section section={(it as { section: BuiltSection<Entry, Container> }).section} dim />
                </Show>
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Upcoming — the simple list, with Time Blocks as sections in time order. */}
      <div class="flex flex-col gap-1.5">
        <For each={upcoming()}>
          {(it) => (
            <Show when={it.kind === 'section'} fallback={<Row entry={(it as { member: Entry }).member} />}>
              <Section section={(it as { section: BuiltSection<Entry, Container> }).section} />
            </Show>
          )}
        </For>
        <Show when={upcoming().length === 0}>
          <div class="text-sm text-muted-foreground text-center py-10 flex flex-col items-center gap-3">
            <Show when={entries().length === 0} fallback={<span>All done for this day. 🎉</span>}>
              <span>Nothing scheduled on this day.</span>
              <EmptyStateConnectCTA />
            </Show>
          </div>
        </Show>
      </div>

      <Show when={labOpen()}>
        <FocusLab directionTint={directionTint()} onClose={() => setLabOpen(false)} />
      </Show>

      {/* The full-screen Focus Ritual (Phase Z · Z3b) — over an explicitly-started task
          (start-any-task-now) or the auto-detected in-progress block ("Enter Focus"). */}
      <Show when={ritualBlock()}>
        <FocusRitual block={ritualBlock()!} next={ritualNext()} onClose={closeRitual} />
      </Show>
    </div>
  );
}
