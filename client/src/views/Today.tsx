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

        <div class="grid grid-cols-3 gap-2 mt-3">
          <Stat icon={AlertCircle} value={overdue()} label="overdue" tone={overdue() > 0 ? 'destructive' : 'muted'} />
          <Stat icon={Ban} value={blocked()} label="blocked" tone={blocked() > 0 ? 'foreground' : 'muted'} />
          <Stat icon={ListTodo} value={open()} label="open" tone="foreground" />
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

function Stat(props: { icon: any; value: number; label: string; tone: 'destructive' | 'foreground' | 'muted' }) {
  return (
    <div class="rounded-lg border border-border bg-background/40 px-2.5 py-2 flex flex-col items-center justify-center text-center">
      <span
        class="text-lg font-semibold tabular-nums"
        classList={{
          'text-destructive': props.tone === 'destructive',
          'text-foreground': props.tone === 'foreground',
          'text-muted-foreground': props.tone === 'muted',
        }}
      >
        {props.value}
      </span>
      <span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <props.icon size={10} /> {props.label}
      </span>
    </div>
  );
}
