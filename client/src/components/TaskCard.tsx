import { createSignal, Show, For, createResource } from 'solid-js';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Play, Square, CalendarDays } from 'lucide-solid';
import { type Task, api } from '../lib/api.js';
import { refetchTasks, showToast, setTaskModal, activeTimer, startTimer, stopTimer, scheduleTaskNextGap } from '../stores/index.js';
import { renderMarkdown } from '../lib/markdown.js';

const priorityDot = ['', 'p1', 'p2', 'p3', 'p4', 'p5'] as const;
const statusClass: Record<string, string> = {
  open:      'text-ci-1',
  done:      'text-ci-1/40 line-through',
  scheduled: 'text-blue-300',
  cancelled: 'text-ci-1/30 line-through',
  deferred:  'text-yellow-500',
};

interface Props {
  task: Task;
  depth?: number;
  scheduleDate?: string;
}

export function TaskCard(props: Props) {
  const depth = () => props.depth ?? 0;
  const p = () => Math.min(Math.max(props.task.priority, 1), 5);
  const [showSubs, setShowSubs] = createSignal(false);
  const [subsFetched, setSubsFetched] = createSignal(false);
  const [isNotesExpanded, setIsNotesExpanded] = createSignal(false);
  const [isEditingNotes, setIsEditingNotes] = createSignal(false);
  const [notesText, setNotesText] = createSignal(props.task.notes ?? props.task.description ?? '');

  async function saveNotes() {
    try {
      await api.tasks.update(props.task.id, { notes: notesText() });
      showToast('Notes updated', 'success');
      setIsEditingNotes(false);
      refetchTasks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

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
      <span class={`font-mono text-xs ${isOverdue ? 'text-red-400' : 'text-ci-1/60'}`}>
        {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        {props.task.task_time && <span class="ml-1 text-ci-1/40">{props.task.task_time}</span>}
      </span>
    );
  };

  const timeDisplay = () => {
    const est = props.task.estimated_minutes;
    const act = props.task.actual_minutes;
    if (!est && !act) return null;
    return (
      <span class="text-xs font-mono text-ci-1/50 flex items-center gap-1 select-none">
        {act ? <span class="text-accent-light font-semibold">{act}m</span> : null}
        {act && est ? <span>/</span> : null}
        {est ? <span>{est}m</span> : null}
      </span>
    );
  };

  return (
    <div class={depth() > 0 ? 'pl-6 relative' : ''}>
      {depth() > 0 && <div class="absolute left-4 top-0 bottom-0 w-px bg-surface-600/60" />}

      <div
        draggable={props.task.status === 'open'}
        onDragStart={(e) => {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify({ taskId: props.task.id, title: props.task.title, estimatedMinutes: props.task.estimated_minutes || 30 }));
          }
        }}
        class={`card group flex gap-3 relative overflow-hidden transition-all duration-200 border-l-2
          ${props.task.status === 'done' ? 'opacity-40 border-l-surface-600' : 'border-l-transparent hover:border-l-accent-light'}
          ${activeTimer()?.taskId === props.task.id ? 'bg-surface-900/80 border-l-accent shadow-lg shadow-accent/5' : ''}`}
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
            <span class={`flex-1 text-sm leading-snug ${statusClass[props.task.status] ?? 'text-ci-1'}`}>
              {props.task.title}
            </span>
            {dueLabel()}
            {timeDisplay()}
          </div>

          <Show when={props.task.notes || props.task.description}>
            <Show when={isNotesExpanded()} fallback={
              <p 
                class="text-xs text-ci-1/60 mt-1 ml-4 line-clamp-2 cursor-pointer hover:text-ci-1/80 transition-colors duration-150 select-none"
                onClick={() => setIsNotesExpanded(true)}
                title="Click to view full notes"
              >
                {props.task.notes ?? props.task.description}
              </p>
            }>
              <Show when={isEditingNotes()} fallback={
                <div class="mt-2 ml-4">
                  <div 
                    class="text-xs text-ci-1/80 leading-relaxed border-l-2 border-surface-700/50 pl-3 py-0.5 space-y-1.5"
                    innerHTML={renderMarkdown(props.task.notes ?? props.task.description ?? '')}
                  />
                  <div class="mt-2 flex gap-3 text-[11px]">
                    <button class="text-accent-light hover:underline font-semibold" onClick={() => setIsEditingNotes(true)}>Edit notes</button>
                    <button class="text-ci-1/50 hover:text-ci-1 hover:underline" onClick={() => setIsNotesExpanded(false)}>Collapse</button>
                  </div>
                </div>
              }>
                <div class="mt-2 ml-4 flex flex-col gap-2">
                  <textarea
                    class="textarea text-xs font-mono w-full min-h-[120px] bg-surface-900 border-surface-700"
                    value={notesText()}
                    onInput={(e) => setNotesText(e.currentTarget.value)}
                    placeholder="Markdown notes..."
                    autofocus
                  />
                  <div class="flex gap-2 justify-end">
                    <button class="btn-primary py-1 px-3 text-xs" onClick={saveNotes}>Save</button>
                    <button class="btn-secondary py-1 px-3 text-xs" onClick={() => { setIsEditingNotes(false); setNotesText(props.task.notes ?? props.task.description ?? ''); }}>Cancel</button>
                  </div>
                </div>
              </Show>
            </Show>
          </Show>

          <Show when={props.task.tags.length > 0}>
            <div class="flex flex-wrap gap-1 mt-1.5 ml-4">
              <For each={props.task.tags}>
                {(t) => <span class="badge-neutral text-[11px]">#{t}</span>}
              </For>
            </div>
          </Show>
        </div>

        {/* Actions (visible on hover or when active timer is running) */}
        <div class={`flex items-center gap-0.5 transition-opacity duration-100 flex-shrink-0
          ${activeTimer()?.taskId === props.task.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        >
          <Show when={props.task.status === 'open'}>
            <Show when={activeTimer()?.taskId === props.task.id} fallback={
              <button
                onClick={() => startTimer(props.task.id, props.task.title)}
                class="btn-icon text-accent-light hover:text-accent"
                title="Start Timer"
              >
                <Play size={13} />
              </button>
            }>
              <button
                onClick={stopTimer}
                class="btn-icon text-red-400 hover:text-red-300 animate-pulse2"
                title="Stop Timer"
              >
                <Square size={13} fill="currentColor" />
              </button>
            </Show>
          </Show>
          <Show when={props.scheduleDate && props.task.status === 'open'}>
            <button
              onClick={async () => {
                try {
                  await scheduleTaskNextGap(props.task.id, props.task.title, props.task.estimated_minutes || 30, props.scheduleDate!);
                  showToast('Task scheduled successfully', 'success');
                } catch (err) {
                  showToast((err as Error).message, 'error');
                }
              }}
              class="btn-icon text-accent-hi hover:text-accent font-semibold"
              title={`Schedule on ${props.scheduleDate}`}
            >
              <CalendarDays size={13} />
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
            <div class="pl-6 py-2 text-xs text-ci-1/60 animate-pulse2">Loading subtasks…</div>
          </Show>
          <For each={subtasks()}>
            {(sub) => <TaskCard task={sub} depth={(depth()) + 1} />}
          </For>
          <Show when={(subtasks()?.length ?? 0) === 0 && !subtasks.loading}>
            <div class="pl-6 py-1.5 text-xs text-ci-1/40 italic">No subtasks yet</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
