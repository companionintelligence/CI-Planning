import { createResource, createMemo, createSignal, onCleanup, onMount, Show, For } from 'solid-js';
import { Plus, AlertCircle, Ban, ListTodo, X, Repeat } from 'lucide-solid';
import { blocks, tasks, taskOf, setTaskModal, refetchPatterns, showToast } from '../stores/index.js';
import { selection, clearSelection, selectedTaskIds, selectedTitles } from '../stores/selection.js';
import { api } from '../lib/api.js';
import { localISODate } from '../lib/dates.js';
import { Planner } from '../components/Planner.js';
import { ConceptLane } from '../components/ConceptLane.js';
import { FlightPlan } from '../components/FlightPlan.js';
import { PlannerDrawer } from '../components/PlannerDrawer.js';
import { MissedReview } from '../components/MissedReview.js';

/**
 * TODAY — the planner cockpit (Phase G, G5). Four regions on the CI-Hub tokens:
 * **Day Overview** (day/date + today's tag set), **Summary** (overdue/blocked/open
 * + the moved `+ New Task`), the **PLANNER**, and the **Flight-plan** — with the
 * never-closing **drawer** floating at the bottom.
 */
export function Today() {
  const [summary] = createResource(() => localISODate(), (date) => api.summary.get(date));

  const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const monthDay = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  // The tag set of everything scheduled today — the shape of the day at a glance.
  const todayTags = createMemo(() => {
    const set = new Set<string>();
    for (const b of blocks() ?? []) {
      if (b.tag) set.add(b.tag);
      for (const t of taskOf(b.task_id)?.tags ?? []) set.add(t);
    }
    return [...set];
  });

  const overdue = () => summary()?.stats.overdue ?? 0;
  const open = () => summary()?.stats.open ?? (tasks() ?? []).filter((t) => t.status === 'open' && !t.parent_id).length;
  const blocked = () => (tasks() ?? []).filter((t) => t.blocked).length;

  // ── Multi-select → "Create Routine" (Phase F) ──────────────────────────────
  // The Shift+= chord (the literal "Shift + +" keys) opens a small modal listing
  // the selected items and lets the user name + create the Routine via
  // POST /api/patterns/promote-from-tasks. Escape clears the selection too.
  const [routineModal, setRoutineModal] = createSignal<{ open: boolean; name: string }>({ open: false, name: '' });
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
      {/* Day Overview — date · tag set · counts, with + New Task top-right */}
      <div class="rounded-xl border border-border bg-card p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary mb-1">Day Overview</div>
            <div class="flex items-baseline gap-2">
              <h1 class="text-xl font-semibold text-foreground">{weekday}</h1>
              <span class="text-sm text-muted-foreground">· {monthDay}</span>
            </div>
          </div>
          <button onClick={() => setTaskModal({ open: true })} class="btn-primary text-xs px-3 py-1.5 flex-shrink-0">
            <Plus size={13} /> New Task
          </button>
        </div>

        <Show
          when={todayTags().length > 0}
          fallback={<p class="mt-2 text-sm text-muted-foreground">Nothing scheduled yet.</p>}
        >
          <div class="mt-2 flex flex-wrap gap-1.5">
            <For each={todayTags()}>{(t) => <span class="badge-neutral text-[11px]">#{t}</span>}</For>
          </div>
        </Show>

        <div class="flex flex-col gap-1.5 mt-3">
          <Bar icon={AlertCircle} value={overdue()} max={open()} label="overdue" tone={overdue() > 0 ? 'destructive' : 'muted'} />
          <Bar icon={Ban}         value={blocked()} max={open()} label="blocked" tone={blocked() > 0 ? 'foreground' : 'muted'} />
          <Bar icon={ListTodo}    value={open()}    max={open()} label="open"    tone="foreground" />
        </div>
      </div>

      {/* Missed-task review — surfaced by the nightly review (hidden when empty) */}
      <MissedReview />

      {/* PLANNER */}
      <Planner />

      {/* Concept horizon lane (hidden when empty) */}
      <ConceptLane />

      {/* Flight-plan (Auto Schedule lives at its top) */}
      <FlightPlan />

      {/* Lower drawer — floats above, never closes */}
      <PlannerDrawer />

      {/* Multi-select indicator (Phase F) — appears when items are picked. */}
      <Show when={selection().size > 0 && !routineModal().open}>
        <div class="fixed bottom-24 left-1/2 -translate-x-1/2 z-30 rounded-full border border-border bg-popover px-4 py-2 shadow-lg flex items-center gap-3 text-xs">
          <span class="font-medium text-foreground">{selection().size} selected</span>
          <span class="text-muted-foreground">Shift+= → Routine · Esc to clear</span>
          <button onClick={() => clearSelection()} class="btn-icon"><X size={14} /></button>
        </div>
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
 * Horizontal summary row — label/icon on the left, a proportional bar in the
 * middle, the count on the right. Bar fill = value / max(1, max). With max ==
 * the day's open count, each bar reads as "this many of the day's open tasks
 * are X" — so "open" itself always reads full-width as the visual anchor.
 */
function Bar(props: { icon: any; value: number; max: number; label: string; tone: 'destructive' | 'foreground' | 'muted' }) {
  const pct = () => `${Math.min(100, (props.value / Math.max(1, props.max)) * 100)}%`;
  return (
    <div class="flex items-center gap-2 text-[11px]">
      <span class="flex items-center gap-1 w-20 text-muted-foreground uppercase tracking-wide text-[10px] flex-shrink-0">
        <props.icon size={10} /> {props.label}
      </span>
      <div class="flex-1 h-2 rounded-full bg-background/60 border border-border overflow-hidden">
        <div
          class="h-full rounded-full transition-[width] duration-200"
          classList={{
            'bg-destructive': props.tone === 'destructive',
            'bg-foreground/70': props.tone === 'foreground',
            'bg-muted-foreground/30': props.tone === 'muted',
          }}
          style={{ width: pct() }}
        />
      </div>
      <span
        class="tabular-nums font-semibold w-6 text-right flex-shrink-0"
        classList={{
          'text-destructive': props.tone === 'destructive',
          'text-foreground': props.tone === 'foreground',
          'text-muted-foreground': props.tone === 'muted',
        }}
      >
        {props.value}
      </span>
    </div>
  );
}
