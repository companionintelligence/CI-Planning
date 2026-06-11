import { createSignal, Show, For } from 'solid-js';
import { SlidersHorizontal, Search } from 'lucide-solid';
import { tasks, tags, taskFilter, setTaskFilter, refetchTasks } from '../stores/index.js';
import { TaskCard } from '../components/TaskCard.js';

export function AllTasks() {
  const [showFilters, setShowFilters] = createSignal(false);

  const statusOptions = ['', 'open', 'scheduled', 'in_progress', 'done', 'cancelled', 'deferred'];

  const activeTaskCount = () => (tasks() ?? []).filter(t => t.status === 'open').length;

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      {/* Header */}
      <div class="flex items-center justify-between mb-5">
        <div>
          <h1 class="text-2xl font-heading font-bold text-ci-1 tracking-wide">Tasks</h1>
          <p class="text-ci-1/60 text-sm mt-0.5">{activeTaskCount()} open</p>
        </div>
        <button onClick={() => setShowFilters(v => !v)} class="btn-secondary gap-2">
          <SlidersHorizontal size={14} /> Filters
        </button>
      </div>

      {/* Filters */}
      <Show when={showFilters()}>
        <div class="card mb-4 flex gap-2 flex-wrap animate-slide-down">
          <div class="flex-1 min-w-36 relative">
            <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-ci-1/50 pointer-events-none" />
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

      {/* Task list */}
      <div class="flex flex-col gap-2">
        <Show when={(tasks() ?? []).filter(t => !t.parent_id).length > 0} fallback={
          <div class="card text-center text-ci-1/60 py-12 text-sm scroll-reveal">No tasks found.</div>
        }>
          <For each={(tasks() ?? []).filter(t => !t.parent_id)}>
            {(task) => <TaskCard task={task} />}
          </For>
        </Show>
      </div>
    </div>
  );
}
