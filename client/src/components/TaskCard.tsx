import { createSignal, Show, For, createResource } from 'solid-js';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Play, Square } from 'lucide-solid';
import { type Task, api } from '../lib/api.js';
import {
  refetchTasks,
  showToast,
  setTaskModal,
  runningEntry,
  liveElapsedClock,
} from '../stores/index.js';

const priorityDot = ['', 'p1', 'p2', 'p3', 'p4', 'p5'] as const;
const statusClass: Record<string, string> = {
  open:      'text-slate-200',
  done:      'text-slate-500 line-through',
  scheduled: 'text-blue-300',
  cancelled: 'text-slate-600 line-through',
  deferred:  'text-yellow-500',
};

interface Props {
  task: Task;
  depth?: number;
}

export function TaskCard(props: Props) {
  const depth = () => props.depth ?? 0;
  const p = () => Math.min(Math.max(props.task.priority, 1), 5);
  const [showSubs, setShowSubs] = createSignal(false);
  const [subsFetched, setSubsFetched] = createSignal(false);

  const [subtasks, { refetch: refetchSubs }] = createResource(
    () => (showSubs() && subsFetched() ? props.task.id : null),
    (id) => api.tasks.subtasks(id).then(r => r.subtasks)
  );

  function toggleSubs() {
    setSubsFetched(true);
    setShowSubs(v => !v);
  }

  async function toggleDone() {
    try {
      if (props.task.status === 'done') {
        await api.tasks.update(props.task.id, { status: 'open', completed_at: null });
      } else {
        await api.tasks.update(props.task.id, { completed: true });
      }
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function remove() {
    try {
      await api.tasks.delete(props.task.id);
      showToast('Task cancelled', 'default');
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const dueLabel = () => {
    if (!props.task.due_at) return null;
    const d = new Date(props.task.due_at);
    const isOverdue = d < new Date() && props.task.status !== 'done';
    return (
      <span class={`font-mono text-xs ${isOverdue ? 'text-red-400' : 'text-slate-500'}`}>
        {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        {props.task.task_time && <span class="ml-1 text-slate-600">{props.task.task_time}</span>}
      </span>
    );
  };

  // ── Timer ──────────────────────────────────────────────────────────────────
  const isRunning = () => runningEntry()?.task_id === props.task.id;
  const liveClock = () => liveElapsedClock(props.task.id);

  async function toggleTimer() {
    try {
      if (isRunning()) {
        await api.tasks.timerStop(props.task.id);
      } else {
        await api.tasks.timerStart(props.task.id);
      }
      // The store reacts to SSE; refetch keeps the badge's actual_minutes current.
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function acceptSuggestion(mins: number) {
    try {
      await api.tasks.update(props.task.id, { estimated_minutes: mins });
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Estimate-vs-actual badge: `{actual}m / {est}m`, green when actual ≤ est,
  // amber when over. Shows a bare estimate when no actual yet, and nothing when
  // neither is set.
  const badge = () => {
    const est = props.task.estimated_minutes;
    const actual = props.task.actual_minutes ?? 0;
    if (actual > 0 && est != null) {
      const over = actual > est;
      return (
        <span class={`text-xs font-mono ${over ? 'text-amber-400' : 'text-green-400'}`} title="actual / estimate">
          {actual}m / {est}m
        </span>
      );
    }
    if (actual > 0) {
      return <span class="text-xs font-mono text-slate-400" title="actual">{actual}m</span>;
    }
    if (est != null) {
      return <span class="text-xs font-mono text-slate-600" title="estimate">{est}m</span>;
    }
    return null;
  };

  // One-tap suggestion chip: only when no estimate is set and the server returned
  // a deterministic suggestion (≥5 tag-cohort samples).
  const suggestion = () =>
    props.task.estimated_minutes == null && props.task.suggested_estimate != null
      ? props.task.suggested_estimate
      : null;

  return (
    <div class={depth() > 0 ? 'pl-6 relative' : ''}>
      {depth() > 0 && <div class="absolute left-4 top-0 bottom-0 w-px bg-surface-600/60" />}

      <div
        class={`card group flex gap-3 ${props.task.status === 'done' ? 'opacity-40' : ''}`}
        style={{ 'margin-bottom': '6px' }}
      >
        {/* Checkbox */}
        <button
          onClick={toggleDone}
          class={`checkbox mt-0.5 flex-shrink-0 ${props.task.status === 'done' ? 'checkbox-checked' : ''}`}
          title={props.task.status === 'done' ? 'Mark open' : 'Mark done'}
        >
          <Show when={props.task.status === 'done'}>
            <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
              <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </Show>
        </button>

        {/* Content */}
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2">
            <span class={`priority-dot mt-[5px] ${priorityDot[p()]}`} />
            <span class={`flex-1 text-sm leading-snug ${statusClass[props.task.status] ?? 'text-slate-200'}`}>
              {props.task.title}
            </span>
            {dueLabel()}
            {badge()}
            <Show when={isRunning()}>
              <span class="text-xs font-mono text-green-400 tabular-nums" title="running">
                {liveClock()}
              </span>
            </Show>
            <button
              onClick={toggleTimer}
              class={`btn-icon flex-shrink-0 ${isRunning() ? 'text-green-400' : 'text-slate-500 hover:text-slate-300'}`}
              title={isRunning() ? 'Stop timer' : 'Start timer'}
            >
              <Show when={isRunning()} fallback={<Play size={13} />}>
                <Square size={13} />
              </Show>
            </button>
          </div>

          <Show when={suggestion() != null}>
            <button
              onClick={() => acceptSuggestion(suggestion()!)}
              class="badge-neutral text-[11px] mt-1 ml-4 hover:text-accent-300 hover:border-accent-400/40 transition-colors"
              title="Set this estimate from your history"
            >
              ≈{suggestion()}m?
            </button>
          </Show>

          <Show when={props.task.notes || props.task.description}>
            <p class="text-xs text-slate-500 mt-1 ml-4 line-clamp-2">
              {props.task.notes ?? props.task.description}
            </p>
          </Show>

          <Show when={props.task.tags.length > 0}>
            <div class="flex flex-wrap gap-1 mt-1.5 ml-4">
              <For each={props.task.tags}>
                {(t) => <span class="badge-neutral text-[11px]">#{t}</span>}
              </For>
            </div>
          </Show>
        </div>

        {/* Actions (visible on hover) */}
        <div class="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity duration-100 flex-shrink-0">
          <button onClick={toggleSubs} class="btn-icon" title="Subtasks">
            <Show when={showSubs()} fallback={<ChevronRight size={13} />}>
              <ChevronDown size={13} />
            </Show>
          </button>
          <button
            class="btn-icon"
            title="Add subtask"
            onClick={() => setTaskModal({ open: true, parentId: props.task.id })}
          >
            <Plus size={13} />
          </button>
          <button
            class="btn-icon"
            title="Edit"
            onClick={() => setTaskModal({ open: true, editTask: props.task })}
          >
            <Pencil size={13} />
          </button>
          <button onClick={remove} class="btn-icon hover:text-red-400" title="Cancel task">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Subtasks */}
      <Show when={showSubs()}>
        <div class="animate-slide-down">
          <Show when={subtasks.loading}>
            <div class="pl-6 py-2 text-xs text-slate-500 animate-pulse2">Loading subtasks…</div>
          </Show>
          <For each={subtasks()}>
            {(sub) => <TaskCard task={sub} depth={(depth()) + 1} />}
          </For>
          <Show when={(subtasks()?.length ?? 0) === 0 && !subtasks.loading}>
            <div class="pl-6 py-1.5 text-xs text-slate-600 italic">No subtasks yet</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
