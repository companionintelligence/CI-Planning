import { createSignal, Show, For } from 'solid-js';
import { 
  SlidersHorizontal, Search, Calendar, Tag, Clock, Play, Square, 
  Pencil, Trash2, CheckCircle2, ChevronRight, ChevronDown, Plus, HelpCircle
} from 'lucide-solid';
import { 
  tasks, tags, taskFilter, setTaskFilter, refetchTasks, 
  activeTimer, startTimer, stopTimer, setTaskModal 
} from '../stores/index.js';
import { api, type Task } from '../lib/api.js';

export function AllTasks() {
  const [expandedNotes, setExpandedNotes] = createSignal<Record<number, boolean>>({});
  const [expandedSubtasks, setExpandedSubtasks] = createSignal<Record<number, boolean>>({});

  const statusOptions = [
    { value: '', label: 'All Statuses' },
    { value: 'open', label: 'Open' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'done', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'deferred', label: 'Deferred' }
  ];

  const priorities = [
    { value: 1, label: 'P1 - Urgent', color: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' },
    { value: 2, label: 'P2 - High', color: 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.4)]' },
    { value: 3, label: 'P3 - Normal', color: 'bg-accent shadow-[0_0_8px_rgba(88,235,191,0.4)]' },
    { value: 4, label: 'P4 - Low', color: 'bg-accent/60' },
    { value: 5, label: 'P5 - Someday', color: 'bg-surface-600' }
  ];

  const toggleNotes = (id: number) => {
    setExpandedNotes(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleSubtasks = (id: number) => {
    setExpandedSubtasks(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const activeTaskCount = () => (tasks() ?? []).filter(t => t.status === 'open' && !t.parent_id).length;

  async function toggleDone(task: Task) {
    try {
      if (task.status === 'done') {
        await api.tasks.update(task.id, { status: 'open', completed_at: null });
      } else {
        await api.tasks.update(task.id, { completed: true });
      }
      refetchTasks();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function remove(id: number) {
    if (!confirm('Are you sure you want to cancel this task?')) return;
    try {
      await api.tasks.delete(id);
      refetchTasks();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // Format date helper
  function fmtDate(iso?: string) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return (
    <div class="h-full flex overflow-hidden page-enter">
      {/* ── Left Sidebar Filters (Permanently Visible & Usable) ── */}
      <div class="w-64 border-r border-surface-700/40 bg-surface-900/10 flex flex-col h-full flex-shrink-0 p-4 gap-5 overflow-y-auto">
        <div>
          <h2 class="text-xs font-heading font-bold text-ci-1/40 uppercase tracking-widest mb-3 select-none">Search Backlog</h2>
          <div class="relative">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-ci-1/40 pointer-events-none" />
            <input
              class="input pl-9 text-xs"
              placeholder="Search title or notes..."
              value={taskFilter().q ?? ''}
              onInput={(e) => setTaskFilter(f => ({ ...f, q: e.currentTarget.value || '' }))}
            />
          </div>
        </div>

        <div>
          <h2 class="text-xs font-heading font-bold text-ci-1/40 uppercase tracking-widest mb-2.5 select-none">Status Filter</h2>
          <div class="flex flex-col gap-1">
            <For each={statusOptions}>
              {(opt) => {
                const isActive = () => (taskFilter().status ?? '') === opt.value;
                return (
                  <button
                    onClick={() => setTaskFilter(f => ({ ...f, status: opt.value }))}
                    class={`flex items-center justify-between text-xs py-1.5 px-3 rounded-lg text-left transition-all duration-150
                      ${isActive() 
                        ? 'bg-accent/15 text-accent-light font-semibold border-l-2 border-accent' 
                        : 'text-ci-1/70 hover:text-ci-1 hover:bg-surface-700/50'}`}
                  >
                    <span>{opt.label}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        <div>
          <h2 class="text-xs font-heading font-bold text-ci-1/40 uppercase tracking-widest mb-2.5 select-none">Priority</h2>
          <div class="grid grid-cols-5 gap-1.5">
            <For each={[1, 2, 3, 4, 5]}>
              {(p) => {
                const isActive = () => taskFilter().priority === p;
                return (
                  <button
                    onClick={() => setTaskFilter(f => ({ ...f, priority: isActive() ? undefined : p }))}
                    class={`py-1.5 rounded-lg text-xs font-mono font-medium border text-center transition-all duration-100
                      ${isActive()
                        ? 'border-accent bg-accent/20 text-accent-light font-bold'
                        : 'border-surface-750 hover:border-surface-600 text-ci-1/60'}`}
                    title={`Priority P${p}`}
                  >
                    P{p}
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <h2 class="text-xs font-heading font-bold text-ci-1/40 uppercase tracking-widest select-none">Tags</h2>
            <Show when={taskFilter().tag}>
              <button 
                onClick={() => setTaskFilter(f => ({ ...f, tag: undefined }))}
                class="text-[10px] text-accent-light hover:underline font-mono"
              >
                Clear
              </button>
            </Show>
          </div>
          <div class="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto pr-1">
            <For each={tags()}>
              {(t) => {
                const isActive = () => taskFilter().tag === t.name;
                return (
                  <button
                    onClick={() => setTaskFilter(f => ({ ...f, tag: isActive() ? undefined : t.name }))}
                    class={`badge text-[10px] py-1 px-2.5 font-mono cursor-pointer transition-all duration-100
                      ${isActive()
                        ? 'bg-accent text-surface-950 font-bold border border-accent'
                        : 'bg-surface-800 hover:bg-surface-750 text-ci-1/70 border border-surface-700/50'}`}
                  >
                    #{t.name}
                    <span class="ml-1 opacity-50 font-sans">({t.count})</span>
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        <button
          class="btn-secondary text-xs py-1.5 w-full mt-2"
          onClick={() => setTaskFilter({})}
        >
          Reset All Filters
        </button>
      </div>

      {/* ── Right Main Area (Explorer List Grid) ── */}
      <div class="flex-1 flex flex-col h-full bg-surface-950/20 overflow-hidden">
        {/* Header */}
        <div class="p-4 border-b border-surface-700/40 flex items-center justify-between flex-shrink-0 bg-surface-900/10">
          <div>
            <h1 class="text-lg font-heading font-bold text-ci-1 tracking-wide">Tasks Explorer</h1>
            <p class="text-ci-1/60 text-xs mt-0.5 font-mono">{activeTaskCount()} open tasks found</p>
          </div>
          <button 
            onClick={() => setTaskModal({ open: true })}
            class="btn-primary py-1.5 px-4 text-xs"
          >
            <Plus size={12} /> New Task
          </button>
        </div>

        {/* Task cards explorer */}
        <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          <Show when={(tasks() ?? []).filter(t => !t.parent_id).length > 0} fallback={
            <div class="card text-center text-ci-1/50 py-16 text-sm font-mono border-dashed">
              No tasks match current filter criteria.
            </div>
          }>
            <For each={(tasks() ?? []).filter(t => !t.parent_id)}>
              {(task) => {
                const hasSubs = () => (tasks() ?? []).some(t => t.parent_id === task.id);
                const subTasks = () => (tasks() ?? []).filter(t => t.parent_id === task.id);
                const completedSubsCount = () => subTasks().filter(t => t.status === 'done').length;

                // Time progress values
                const est = () => task.estimated_minutes || 0;
                const act = () => task.actual_minutes || 0;
                const progressPct = () => est() > 0 ? Math.min(100, Math.round((act() / est()) * 100)) : 0;
                const progressColor = () => {
                  if (act() > est()) return 'bg-red-500';
                  if (progressPct() > 80) return 'bg-orange-500';
                  return 'bg-accent';
                };

                return (
                  <div class="card p-0 overflow-hidden border-surface-700/60 hover:border-accent/30 transition-all duration-200 shadow-sm">
                    {/* Header Row */}
                    <div class="flex items-center gap-3 p-3.5 flex-wrap md:flex-nowrap">
                      {/* Checkbox */}
                      <button
                        onClick={() => toggleDone(task)}
                        class={`checkbox ${task.status === 'done' ? 'checkbox-checked' : ''}`}
                        title={task.status === 'done' ? 'Mark open' : 'Mark done'}
                      >
                        <Show when={task.status === 'done'}>
                          <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
                            <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                          </svg>
                        </Show>
                      </button>

                      {/* Priority indicator */}
                      <span class={`priority-dot ${priorities.find(p => p.value === task.priority)?.color || 'bg-surface-600'}`} />

                      {/* Task title */}
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <span class={`text-sm font-medium leading-snug truncate ${task.status === 'done' ? 'text-ci-1/40 line-through' : 'text-ci-1'}`}>
                            {task.title}
                          </span>
                        </div>
                        {/* Tags list */}
                        <Show when={task.tags.length > 0}>
                          <div class="flex flex-wrap gap-1 mt-1">
                            <For each={task.tags}>
                              {(tag) => <span class="badge-neutral text-[10px] px-1.5">#{tag}</span>}
                            </For>
                          </div>
                        </Show>
                      </div>

                      {/* Due date */}
                      <Show when={task.due_at}>
                        <div class="flex items-center gap-1 text-xs text-ci-1/60 bg-surface-900/60 px-2 py-1 rounded-lg border border-surface-800 font-mono">
                          <Calendar size={11} />
                          <span>{fmtDate(task.due_at)}</span>
                          {task.task_time && <span class="text-ci-1/40 ml-0.5">{task.task_time}</span>}
                        </div>
                      </Show>

                      {/* Estimated vs Tracked progress bar */}
                      <Show when={est() > 0 || act() > 0}>
                        <div class="w-36 flex flex-col gap-1 flex-shrink-0">
                          <div class="flex justify-between text-[10px] font-mono text-ci-1/50">
                            <span>Tracked</span>
                            <span class="font-semibold">{act()}m / {est() || '—'}m</span>
                          </div>
                          <div class="w-full h-1.5 bg-surface-900 rounded-full overflow-hidden border border-surface-800">
                            <div class={`h-full rounded-full transition-all duration-300 ${progressColor()}`} style={{ width: `${progressPct() || (act() > 0 ? 100 : 0)}%` }} />
                          </div>
                        </div>
                      </Show>

                      {/* Actions */}
                      <div class="flex items-center gap-1 flex-shrink-0 ml-auto pl-2">
                        {/* Timer control */}
                        <Show when={task.status === 'open' || task.status === 'scheduled' || task.status === 'in_progress'}>
                          <Show when={activeTimer()?.taskId === task.id} fallback={
                            <button
                              onClick={() => startTimer(task.id, task.title)}
                              class="btn-icon text-accent hover:bg-accent/15"
                              title="Start timer"
                            >
                              <Play size={13} />
                            </button>
                          }>
                            <button
                              onClick={stopTimer}
                              class="btn-icon text-red-400 hover:bg-red-950/20 animate-pulse2"
                              title="Stop timer"
                            >
                              <Square size={13} fill="currentColor" />
                            </button>
                          </Show>
                        </Show>

                        {/* Edit task */}
                        <button
                          onClick={() => setTaskModal({ open: true, editTask: task })}
                          class="btn-icon hover:bg-surface-700/50"
                          title="Edit task details"
                        >
                          <Pencil size={13} />
                        </button>

                        {/* Delete/Cancel task */}
                        <button
                          onClick={() => remove(task.id)}
                          class="btn-icon hover:bg-red-950/25 hover:text-red-400"
                          title="Cancel task"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {/* Expand buttons (Subtasks & Notes indicators) */}
                    <div class="flex border-t border-surface-750 bg-surface-900/30 px-3.5 py-1.5 text-xs text-ci-1/50 justify-between items-center select-none font-mono">
                      <div class="flex gap-4">
                        <Show when={task.notes || task.description}>
                          <button 
                            onClick={() => toggleNotes(task.id)} 
                            class="hover:text-ci-1 flex items-center gap-1 font-sans"
                          >
                            <span>{expandedNotes()[task.id] ? 'Hide Notes' : 'Show Notes'}</span>
                          </button>
                        </Show>
                        <Show when={hasSubs()}>
                          <button 
                            onClick={() => toggleSubtasks(task.id)} 
                            class="hover:text-ci-1 flex items-center gap-1.5"
                          >
                            <Show when={expandedSubtasks()[task.id]} fallback={<ChevronRight size={12} />}>
                              <ChevronDown size={12} />
                            </Show>
                            <span>{completedSubsCount()}/{subTasks().length} subtasks</span>
                          </button>
                        </Show>
                      </div>

                      {/* Status indicator badge */}
                      <span class={`badge text-[9px] uppercase tracking-wider ${task.status === 'done' ? 'badge-green' : task.status === 'scheduled' ? 'badge-blue' : 'badge-neutral'}`}>
                        {task.status}
                      </span>
                    </div>

                    {/* Expandable Notes panel */}
                    <Show when={expandedNotes()[task.id]}>
                      <div class="p-4 bg-surface-900/60 border-t border-surface-750 text-xs text-ci-1/80 leading-relaxed font-sans select-text">
                        <div class="font-semibold text-ci-1/40 uppercase text-[9px] tracking-wider mb-1.5 font-mono">Task Notes</div>
                        <p class="whitespace-pre-wrap">{task.notes || task.description}</p>
                      </div>
                    </Show>

                    {/* Expandable Subtasks panel */}
                    <Show when={expandedSubtasks()[task.id] && hasSubs()}>
                      <div class="p-3 bg-surface-900/40 border-t border-surface-750 flex flex-col gap-2">
                        <For each={subTasks()}>
                          {(sub) => (
                            <div class="flex items-center gap-2.5 pl-6 py-1 pr-3 rounded border border-transparent hover:border-surface-700 hover:bg-surface-800/20 transition-all duration-100">
                              {/* Subtask Checkbox */}
                              <button
                                onClick={() => toggleDone(sub)}
                                class={`checkbox w-3.5 h-3.5 ${sub.status === 'done' ? 'checkbox-checked' : ''}`}
                              >
                                <Show when={sub.status === 'done'}>
                                  <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
                                    <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                  </svg>
                                </Show>
                              </button>

                              <span class={`priority-dot w-1.5 h-1.5 ${priorities.find(p => p.value === sub.priority)?.color || 'bg-surface-600'}`} />

                              <span class={`text-xs ${sub.status === 'done' ? 'text-ci-1/40 line-through' : 'text-ci-1/90'}`}>
                                {sub.title}
                              </span>

                              <div class="ml-auto flex items-center gap-1">
                                <button
                                  onClick={() => setTaskModal({ open: true, editTask: sub })}
                                  class="p-1 text-ci-1/40 hover:text-ci-1 rounded"
                                  title="Edit subtask"
                                >
                                  <Pencil size={11} />
                                </button>
                                <button
                                  onClick={() => remove(sub.id)}
                                  class="p-1 text-ci-1/40 hover:text-red-400 rounded"
                                  title="Cancel subtask"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
