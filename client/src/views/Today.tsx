import { createSignal, Show, For } from 'solid-js';
import { tasks, blocks, refetchTasks, refetchBlocks } from '../stores/index.js';
import { api } from '../lib/api.js';
import { TaskCard } from '../components/TaskCard.js';
import { BlockCard } from '../components/BlockCard.js';

export function Today() {
  const [creating, setCreating] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal('');
  const [runningSchedule, setRunningSchedule] = createSignal(false);

  const todayBlocks = () => {
    const now = new Date();
    return (blocks() ?? [])
      .filter((b) => b.block_kind !== 'break' && b.block_kind !== 'buffer')
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
  };

  const openTasks = () =>
    (tasks() ?? []).filter((t) => t.status === 'open' || t.status === 'scheduled').slice(0, 8);

  async function addTask(e: Event) {
    e.preventDefault();
    if (!newTitle().trim()) return;
    await api.tasks.create({ title: newTitle().trim() });
    setNewTitle('');
    setCreating(false);
  }

  async function runSchedule() {
    setRunningSchedule(true);
    try {
      await api.schedule.run();
    } finally {
      setRunningSchedule(false);
    }
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div class="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-semibold text-slate-100">Today</h1>
          <p class="text-slate-500 text-sm mt-0.5">{today}</p>
        </div>
        <button
          onClick={runSchedule}
          disabled={runningSchedule()}
          class="btn-primary"
        >
          {runningSchedule() ? 'Scheduling…' : '⚡ Auto-schedule'}
        </button>
      </div>

      {/* Timeline */}
      <section class="mb-8">
        <h2 class="text-xs uppercase tracking-widest text-slate-500 mb-3">Today's Blocks</h2>
        <Show when={(todayBlocks().length) > 0} fallback={
          <div class="card text-slate-500 text-sm text-center py-8">
            No blocks yet — hit <strong class="text-slate-300">Auto-schedule</strong> or add a block manually.
          </div>
        }>
          <div class="flex flex-col gap-2">
            <For each={todayBlocks()}>
              {(block) => <BlockCard block={block} onUpdated={refetchBlocks} />}
            </For>
          </div>
        </Show>
      </section>

      {/* Task backlog */}
      <section>
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-xs uppercase tracking-widest text-slate-500">Open Tasks</h2>
          <button onClick={() => setCreating(true)} class="btn-ghost text-xs">+ New task</button>
        </div>

        <Show when={creating()}>
          <form onSubmit={addTask} class="card mb-2 flex gap-2">
            <input
              autofocus
              class="input flex-1"
              placeholder="Task title…"
              value={newTitle()}
              onInput={(e) => setNewTitle(e.currentTarget.value)}
            />
            <button type="submit" class="btn-primary">Add</button>
            <button type="button" class="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
          </form>
        </Show>

        <Show when={(openTasks().length) > 0} fallback={
          <div class="card text-slate-500 text-sm text-center py-8">
            All clear — no open tasks.
          </div>
        }>
          <div class="flex flex-col gap-2">
            <For each={openTasks()}>
              {(task) => <TaskCard task={task} onUpdated={refetchTasks} />}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
