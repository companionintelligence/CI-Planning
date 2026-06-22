import { createSignal, Show, For, createResource } from 'solid-js';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Repeat, Flame, SkipForward } from 'lucide-solid';
import { type Task, api } from '../lib/api.js';
import { refetchTasks, showToast, setElementModal } from '../stores/index.js';

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

  // Habit streak strip — fetched only for habit tasks (template or instance).
  const [streak, { refetch: refetchStreak }] = createResource(
    () => (props.task.is_habit ? props.task.id : null),
    (id) => api.tasks.streak(id).catch(() => null)
  );

  const isInstance = () => !!props.task.recurrence_parent_id;

  function toggleSubs() {
    setSubsFetched(true);
    setShowSubs(v => !v);
  }

  async function skip() {
    try {
      await api.tasks.skip(props.task.id);
      showToast('Occurrence skipped', 'default');
      refetchTasks();
      refetchStreak();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function toggleDone() {
    try {
      if (props.task.status === 'done') {
        await api.tasks.update(props.task.id, { status: 'open', completed_at: null });
      } else {
        await api.tasks.update(props.task.id, { completed: true });
      }
      refetchTasks();
      refetchStreak();
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

  const est = () => props.task.estimated_minutes
    ? <span class="text-xs font-mono text-slate-600">{props.task.estimated_minutes}m</span>
    : null;

  return (
    <div class={depth() > 0 ? 'pl-6 relative' : ''}>
      {depth() > 0 && <div class="absolute left-4 top-0 bottom-0 w-px bg-surface-600/60" />}

      <div
        class={`card group flex gap-3 ${props.task.status === 'done' ? 'opacity-40' : ''}`}
        style={{ 'margin-bottom': '6px' }}
      >
        {/* Checkbox — habits aren't completed here; you mark occurrences done on the
            planner. Show a non-interactive habit marker instead of a checkbox. */}
        <Show
          when={!props.task.is_habit}
          fallback={
            <span class="checkbox mt-0.5 flex-shrink-0 flex items-center justify-center cursor-default opacity-60"
              title="Habit — mark occurrences done on the planner, not here">
              <Repeat size={11} class="text-muted-foreground" />
            </span>
          }
        >
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
        </Show>

        {/* Content */}
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2">
            <span class={`priority-dot mt-[5px] ${priorityDot[p()]}`} />
            <span class={`flex-1 text-sm leading-snug ${statusClass[props.task.status] ?? 'text-slate-200'}`}>
              {props.task.title}
            </span>
            <Show when={props.task.is_habit}>
              <span class="badge-neutral text-[10px] flex-shrink-0 inline-flex items-center gap-0.5"><Repeat size={9} /> habit</span>
            </Show>
            <Show when={isInstance() && !props.task.is_habit}>
              <Repeat size={11} class="text-muted-foreground flex-shrink-0 mt-1" />
            </Show>
            {dueLabel()}
            {est()}
          </div>

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

          {/* Habit streak strip */}
          <Show when={props.task.is_habit && streak()}>
            {(s) => (
              <div class="flex items-center gap-1.5 mt-1.5 ml-4">
                <div class="flex gap-0.5">
                  <For each={s().recent}>
                    {(r) => (
                      <span
                        class="w-2 h-2 rounded-full"
                        classList={{
                          'bg-primary': r.status === 'done',
                          'border border-border': r.status === 'open',
                          'bg-muted-foreground/40': r.status === 'missed',
                          'border border-muted-foreground': r.status === 'skipped',
                        }}
                        title={`${r.date}: ${r.status}`}
                      />
                    )}
                  </For>
                </div>
                <Show when={s().current > 0}>
                  <span class="flex items-center gap-0.5 text-[11px] text-primary font-medium">
                    <Flame size={10} /> {s().current}
                  </span>
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* Actions (visible on hover) */}
        <div class="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity duration-100 flex-shrink-0">
          <Show when={isInstance()}>
            <button onClick={skip} class="btn-icon" title="Skip this occurrence">
              <SkipForward size={13} />
            </button>
          </Show>
          <button onClick={toggleSubs} class="btn-icon" title="Subtasks">
            <Show when={showSubs()} fallback={<ChevronRight size={13} />}>
              <ChevronDown size={13} />
            </Show>
          </button>
          <button
            class="btn-icon"
            title="Add subtask"
            onClick={() => setElementModal({ open: true, mode: 'add', kind: 'task', parentId: props.task.id })}
          >
            <Plus size={13} />
          </button>
          <button
            class="btn-icon"
            title="Edit"
            onClick={() => setElementModal({ open: true, mode: 'edit', kind: props.task.is_habit ? 'habit' : 'task', editTarget: { kind: props.task.is_habit ? 'habit' : 'task', id: props.task.id } })}
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
