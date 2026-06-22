import { createSignal, Show, For } from 'solid-js';
import { SlidersHorizontal, Search } from 'lucide-solid';
import { tasks, tags, taskFilter, setTaskFilter, refetchTasks } from '../stores/index.js';
import { TaskCard } from '../components/TaskCard.js';
import { QuickAdd } from '../components/QuickAdd.js';

export function AllTasks() {
  const [showFilters, setShowFilters] = createSignal(false);

  const statusOptions = ['', 'open', 'scheduled', 'in_progress', 'done', 'cancelled', 'deferred'];

  const activeTaskCount = () => (tasks() ?? []).filter(t => t.status === 'open').length;

  // Tasks vs Habits tabs. Both exclude subtasks + recurrence instances (a series
  // collapses to its template); Habits are split out onto their own tab.
  const [view, setView] = createSignal<'tasks' | 'habits'>('tasks');
  const baseList = () => (tasks() ?? []).filter(t => !t.parent_id && !t.recurrence_parent_id);
  const shownList = () => baseList().filter(t => (view() === 'habits' ? t.is_habit : !t.is_habit));

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      {/* Header */}
      <div class="flex items-center justify-between mb-5">
        <div>
          <h1 class="text-2xl font-bold text-slate-100">Tasks</h1>
          <p class="text-slate-500 text-sm mt-0.5">{activeTaskCount()} open</p>
        </div>
        <button onClick={() => setShowFilters(v => !v)} class="btn-secondary gap-2">
          <SlidersHorizontal size={14} /> Filters
        </button>
      </div>

      {/* Natural-language quick add */}
      <QuickAdd />

      {/* Filters */}
      <Show when={showFilters()}>
        <div class="card mb-4 flex gap-2 flex-wrap animate-slide-down">
          <div class="flex-1 min-w-36 relative">
            <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              class="input pl-8"
              placeholder="Search…"
              value={taskFilter().q ?? ''}
              onInput={(e) => setTaskFilter(f => ({ ...f, q: e.currentTarget.value || '' }))}
            />
          </div>
          <select
            class="input w-auto"
            value={taskFilter().status ?? ''}
            onChange={(e) => setTaskFilter(f => ({ ...f, status: e.currentTarget.value }))}
          >
            {statusOptions.map(s => <option value={s}>{s || 'All statuses'}</option>)}
          </select>
          <select
            class="input w-auto"
            value={taskFilter().tag ?? ''}
            onChange={(e) => setTaskFilter(f => ({ ...f, tag: e.currentTarget.value }))}
          >
            <option value="">All tags</option>
            <For each={tags()}>
              {(t) => <option value={t.name}>#{t.name} ({t.count})</option>}
            </For>
          </select>
          <button
            class="btn-ghost text-xs"
            onClick={() => setTaskFilter({})}
          >
            Clear
          </button>
        </div>
      </Show>

      {/* Tasks / Habits tabs */}
      <div class="flex gap-2 mb-3">
        <For each={[['tasks', 'Tasks'], ['habits', 'Habits']] as const}>
          {([v, label]) => (
            <button
              onClick={() => setView(v)}
              class="px-3 py-1 text-sm rounded-md transition-colors"
              classList={{ 'bg-primary text-primary-foreground': view() === v, 'text-muted-foreground hover:text-foreground': view() !== v }}
            >
              {label} <span class="opacity-60 tabular-nums">{baseList().filter(t => (v === 'habits' ? t.is_habit : !t.is_habit)).length}</span>
            </button>
          )}
        </For>
      </div>

      {/* List — top-level only; recurring series collapse to their template (instances
          hidden so a habit shows once). Habits live on their own tab. */}
      <div class="flex flex-col gap-2">
        <Show when={shownList().length > 0} fallback={
          <div class="card text-center text-slate-500 py-12 text-sm">No {view() === 'habits' ? 'habits' : 'tasks'} found.</div>
        }>
          <For each={shownList()}>
            {(task) => <TaskCard task={task} />}
          </For>
        </Show>
      </div>
    </div>
  );
}
