import { createSignal, Show, For, batch } from 'solid-js';
import { tasks, tags, taskFilter, setTaskFilter, refetchTasks } from '../stores/index.js';
import { api } from '../lib/api.js';
import { TaskCard } from '../components/TaskCard.js';

export function AllTasks() {
  const [showForm, setShowForm] = createSignal(false);
  const [form, setForm] = createSignal({
    title: '', description: '', due_at: '', estimated_minutes: '', priority: '3', tags: '',
  });

  function setField(key: string, val: string) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function submit(e: Event) {
    e.preventDefault();
    const f = form();
    if (!f.title.trim()) return;
    await api.tasks.create({
      title: f.title.trim(),
      description: f.description || undefined,
      due_at: f.due_at || undefined,
      estimated_minutes: f.estimated_minutes ? Number(f.estimated_minutes) : undefined,
      priority: Number(f.priority),
      tags: f.tags ? f.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    });
    setForm({ title: '', description: '', due_at: '', estimated_minutes: '', priority: '3', tags: '' });
    setShowForm(false);
  }

  const statusOptions = ['', 'open', 'scheduled', 'done', 'cancelled', 'deferred'];

  return (
    <div class="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-semibold text-slate-100">Tasks</h1>
        <button onClick={() => setShowForm((v) => !v)} class="btn-primary">+ New Task</button>
      </div>

      {/* Filters */}
      <div class="flex gap-2 flex-wrap mb-4">
        <select
          class="input w-auto"
          value={taskFilter().status ?? ''}
          onChange={(e) => setTaskFilter((f) => ({ ...f, status: e.currentTarget.value || undefined! }))}
        >
          {statusOptions.map((s) => <option value={s}>{s || 'All statuses'}</option>)}
        </select>
        <select
          class="input w-auto"
          value={taskFilter().tag ?? ''}
          onChange={(e) => setTaskFilter((f) => ({ ...f, tag: e.currentTarget.value || undefined! }))}
        >
          <option value="">All tags</option>
          <For each={tags()}>
            {(t) => <option value={t.name}>#{t.name} ({t.count})</option>}
          </For>
        </select>
        <input
          class="input flex-1 min-w-32"
          placeholder="Search…"
          value={taskFilter().q ?? ''}
          onInput={(e) => setTaskFilter((f) => ({ ...f, q: e.currentTarget.value || undefined! }))}
        />
      </div>

      {/* Create form */}
      <Show when={showForm()}>
        <form onSubmit={submit} class="card mb-4 flex flex-col gap-3">
          <input class="input" placeholder="Title *" value={form().title}
            onInput={(e) => setField('title', e.currentTarget.value)} />
          <textarea class="input resize-none" placeholder="Description" rows={2}
            value={form().description} onInput={(e) => setField('description', e.currentTarget.value)} />
          <div class="flex gap-2">
            <input class="input" type="date" value={form().due_at}
              onInput={(e) => setField('due_at', e.currentTarget.value)} />
            <input class="input" type="number" placeholder="Est. minutes" value={form().estimated_minutes}
              onInput={(e) => setField('estimated_minutes', e.currentTarget.value)} />
            <select class="input w-auto" value={form().priority}
              onChange={(e) => setField('priority', e.currentTarget.value)}>
              {[1,2,3,4,5].map((p) => <option value={p}>P{p}</option>)}
            </select>
          </div>
          <input class="input" placeholder="Tags (comma-separated)" value={form().tags}
            onInput={(e) => setField('tags', e.currentTarget.value)} />
          <div class="flex gap-2">
            <button type="submit" class="btn-primary">Add Task</button>
            <button type="button" class="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </form>
      </Show>

      <div class="flex flex-col gap-2">
        <Show when={(tasks() ?? []).length > 0} fallback={
          <div class="card text-center text-slate-500 py-10">No tasks found.</div>
        }>
          <For each={tasks()}>
            {(task) => <TaskCard task={task} onUpdated={refetchTasks} />}
          </For>
        </Show>
      </div>
    </div>
  );
}
