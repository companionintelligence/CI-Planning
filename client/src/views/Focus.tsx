import { createSignal, createMemo, Show, For, onCleanup } from 'solid-js';
import { ChevronDown, ChevronRight, Crosshair, Play, Check, RotateCcw, CalendarRange } from 'lucide-solid';
import { FocusRitual } from '../components/FocusRitual.js';
import { FocusReminders } from '../components/FocusReminders.js';
import { EmptyStateConnectCTA } from '../components/EmptyStateConnectCTA.js';
import { blocks, tasks, taskOf, prefs, tags, patternPrefs, refetchTasks, refetchBlocks, showToast, setSelectedDay, setPlanWeekModal } from '../stores/index.js';
import { api, type Block, type Task } from '../lib/api.js';
import { localISODate } from '../lib/dates.js';
import { focusState, formatRemaining } from '../lib/focus.js';
import { directionColorForTask } from '../lib/pattern-meta.js';
import { minutesIntoDay } from '../lib/grid.js';

/**
 * FOCUS — the pre-Today view: "what am I doing right now, and what's left today?"
 *
 * A deliberately simple, single-column list of the day's tasks: UPCOMING items
 * (in start order; time-less ones last as "Anytime") with past/completed items
 * collapsed into one expandable row. When Time-Sense is enabled and a block is in
 * progress, a hero card shows the live countdown (lib/focus.ts state math) and
 * opens the full-screen Focus Ritual — the same Z3b surface Today launches.
 *
 * Reuses the shared `blocks` resource (selectedDay-keyed), pinned to today on
 * mount — FOCUS is today-only by design; other days live in Today/Calendar.
 */

const FOCUS_KINDS = new Set(['task', 'focus', 'habit']);

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
  task?: Task;
  block?: Block;
}

export function Focus() {
  // FOCUS is today-only: pin the shared cockpit day so the blocks resource covers today.
  setSelectedDay(localISODate());
  const today = localISODate();

  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  const [pastOpen, setPastOpen] = createSignal(false);
  const [ritualOpen, setRitualOpen] = createSignal(false);
  // The block the user explicitly STARTED from this view (start-any-task-now). Drives the
  // Focus Ritual directly, independent of the Time-Sense master flag — an explicit start is
  // a deliberate request for the timer, so it runs even if the ambient hero is off.
  const [startedBlock, setStartedBlock] = createSignal<Block | null>(null);
  const [starting, setStarting] = createSignal<string | null>(null); // entry key mid-start

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
        sortMin: minutesIntoDay(b.start_at, today),
        startMs, endMs,
        done: t?.status === 'done' || b.status === 'completed' || b.status === 'done',
        task: t, block: b,
      });
    }
    for (const t of tasks() ?? []) {
      if ((t.scheduled_for ?? '').slice(0, 10) !== today) continue;
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
          const d = new Date(`${today}T${t.task_time.length === 5 ? t.task_time : '00:00'}:00`);
          startMs = d.getTime();
          endMs = startMs + Math.max(15, t.estimated_minutes || 30) * 60_000;
          timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        }
      }
      out.push({ key: `t:${t.id}`, taskId: t.id, title: t.title, timeLabel, sortMin, startMs, endMs, done: t.status === 'done', task: t });
    }
    return out.sort((a, b) => a.sortMin - b.sortMin);
  });

  // Past = done, or its slot has fully elapsed. Upcoming = everything else.
  const isPast = (e: Entry) => e.done || (e.endMs != null && e.endMs <= now());
  const upcoming = () => entries().filter((e) => !isPast(e));
  const past = () => entries().filter(isPast);
  const isNow = (e: Entry) => !e.done && e.startMs != null && e.endMs != null && e.startMs <= now() && e.endMs > now();

  // ── Time-Sense integration (Phase Z) — mirrors Today's gating exactly ──────────
  const timeSenseOn = () => !!prefs()?.time_sense_enabled && prefs()?.focus_ritual_enabled !== false;
  const currentBlock = createMemo(() => {
    if (!timeSenseOn()) return null;
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

    const durMin = Math.max(15, entry.task?.estimated_minutes || 30);
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
    const durMin = Math.max(15, (block.task_id ? taskOf(block.task_id)?.estimated_minutes : 0) || 30);
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
      else await api.tasks.update(e.taskId, { completed: true });
      refetchTasks();
      refetchBlocks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const dotColor = (e: Entry): string =>
    e.task ? directionColorForTask({ tags: e.task.tags ?? [] }, tags() ?? [], patternPrefs()?.prefs ?? {}) : 'var(--border)';

  const Row = (props: { entry: Entry; dim?: boolean }) => (
    <div
      class="flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors"
      classList={{
        'opacity-50': !!props.dim,
        'border-accent-hi/50 bg-accent-hi/5': isNow(props.entry),
        'border-border/60': !isNow(props.entry),
      }}
    >
      <span class="w-16 flex-shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground">
        {props.entry.timeLabel ?? 'Anytime'}
      </span>
      <button
        onClick={() => toggleDone(props.entry)}
        disabled={!props.entry.taskId}
        class="w-[16px] h-[16px] rounded-full border flex-shrink-0 flex items-center justify-center transition-colors"
        style={props.entry.done ? { background: dotColor(props.entry), 'border-color': dotColor(props.entry) } : { 'border-color': dotColor(props.entry) }}
        title={props.entry.taskId ? (props.entry.done ? 'Mark open' : 'Mark done') : undefined}
      >
        <Show when={props.entry.done}><Check size={10} class="text-white" /></Show>
      </button>
      <span class="flex-1 min-w-0 text-sm truncate" classList={{ 'line-through text-muted-foreground': props.entry.done, 'text-foreground': !props.entry.done }}>
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
    <div class="flex-1 overflow-auto p-6 page-enter max-w-2xl mx-auto w-full">
      <div class="flex items-baseline gap-3 mb-5">
        <h1 class="text-2xl font-bold text-foreground flex items-center gap-2"><Crosshair size={20} class="text-accent-hi" /> Focus</h1>
        <span class="text-sm text-muted-foreground">
          {new Date(`${today}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </span>
        {/* The persistent "Plan my week" entry point moved to the Calendar header (it acts
            on the week/calendar); the empty-day contextual nudge below stays. */}
      </div>

      {/* Time-Sense hero — the in-progress block, live countdown, Focus Ritual launcher. */}
      <Show when={currentBlock()}>
        {(b) => (
          <div class="mb-5 rounded-2xl border border-accent-hi/40 bg-accent-hi/5 p-4">
            <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-accent-hi mb-1.5">Focus now</div>
            <div class="flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div class="text-base font-semibold text-foreground truncate">
                  {(b().task_id ? taskOf(b().task_id!)?.title : null) ?? b().title}
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  {fmtTime(b().start_at)} – {fmtTime(b().end_at)}
                  <Show when={heroState()}>
                    {(s) => <span classList={{ 'text-red-400 font-medium': s().phase === 'warning' }}> · {formatRemaining(s().remainingMs)} left</span>}
                  </Show>
                </div>
              </div>
              {/* Small "Start" affordance — re-anchor to now (fresh clock); distinct from
                  the primary "Enter Focus" resume. */}
              <button
                onClick={() => restartHeroNow(b())}
                disabled={starting() === b().id}
                class="flex items-center gap-1 h-9 px-3 rounded-full border border-accent-hi/50 text-accent-hi text-[13px] font-semibold hover:bg-accent-hi/10 transition-colors flex-shrink-0 disabled:opacity-60"
                title="Start fresh from now — reset the timer to a full estimate"
              >
                <RotateCcw size={13} /> Start
              </button>
              <button
                onClick={() => setRitualOpen(true)}
                class="flex items-center gap-1.5 h-9 px-4 rounded-full bg-accent-hi text-[#041620] text-sm font-semibold hover:brightness-110 transition-all flex-shrink-0"
              >
                <Play size={14} /> Enter Focus
              </button>
            </div>
            {/* Depletion bar — same math the ritual's ambient layer uses. */}
            <Show when={heroState()}>
              {(s) => (
                <div class="mt-3 h-1 rounded-full bg-muted/60 overflow-hidden">
                  <div class="h-full rounded-full bg-accent-hi transition-all" style={{ width: `${(1 - s().depletionFrac) * 100}%` }} />
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>

      {/* #388: reminders — list, create, delete (the toast keeps Snooze). */}
      <FocusReminders />

      {/* Past tasks — collapsed into one expandable row. */}
      <Show when={past().length > 0}>
        <button
          onClick={() => setPastOpen((v) => !v)}
          class="w-full flex items-center gap-2 px-3 py-2 mb-2 rounded-xl text-xs text-muted-foreground hover:text-foreground bg-muted/30 transition-colors"
          aria-expanded={pastOpen()}
        >
          <Show when={pastOpen()} fallback={<ChevronRight size={12} />}><ChevronDown size={12} /></Show>
          {past().length} earlier task{past().length === 1 ? '' : 's'}
          <span class="ml-auto">{past().filter((e) => e.done).length} done</span>
        </button>
        <Show when={pastOpen()}>
          <div class="flex flex-col gap-1.5 mb-4 animate-slide-down">
            <For each={past()}>{(e) => <Row entry={e} dim />}</For>
          </div>
        </Show>
      </Show>

      {/* Upcoming — the simple list. */}
      <div class="flex flex-col gap-1.5">
        <For each={upcoming()}>{(e) => <Row entry={e} />}</For>
        <Show when={upcoming().length === 0}>
          <div class="text-sm text-muted-foreground text-center py-10 flex flex-col items-center gap-3">
            {/* T2: a truly-empty day is the strongest moment to offer planning, so the
                copy now points at the assistant instead of sending the user to Today. */}
            <Show when={entries().length === 0} fallback={<span>All done for today. 🎉</span>}>
              <span>Nothing scheduled today.</span>
              <button
                class="btn-primary text-xs inline-flex items-center gap-1.5"
                onClick={() => setPlanWeekModal({ open: true })}
              >
                <CalendarRange size={14} /> Plan my week
              </button>
              <EmptyStateConnectCTA />
            </Show>
          </div>
        </Show>
      </div>

      {/* The full-screen Focus Ritual (Phase Z · Z3b) — over an explicitly-started task
          (start-any-task-now) or the auto-detected in-progress block ("Enter Focus"). */}
      <Show when={ritualBlock()}>
        <FocusRitual block={ritualBlock()!} next={ritualNext()} onClose={closeRitual} />
      </Show>
    </div>
  );
}
