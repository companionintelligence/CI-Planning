import { createResource, createMemo, Show, For } from 'solid-js';
import { Plus, AlertCircle, Ban, ListTodo } from 'lucide-solid';
import { blocks, tasks, taskOf, setTaskModal } from '../stores/index.js';
import { api } from '../lib/api.js';
import { localISODate } from '../lib/dates.js';
import { Planner } from '../components/Planner.js';
import { ConceptLane } from '../components/ConceptLane.js';
import { FlightPlan } from '../components/FlightPlan.js';
import { PlannerDrawer } from '../components/PlannerDrawer.js';

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

      {/* PLANNER */}
      <Planner />

      {/* Concept horizon lane (hidden when empty) */}
      <ConceptLane />

      {/* Flight-plan (Auto Schedule lives at its top) */}
      <FlightPlan />

      {/* Lower drawer — floats above, never closes */}
      <PlannerDrawer />
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
