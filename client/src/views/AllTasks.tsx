import { createSignal, createResource, Show, For } from 'solid-js';
import { SlidersHorizontal, Search, Sparkles, Archive, ChevronDown, ChevronRight } from 'lucide-solid';
import { tasks, tags, taskFilter, setTaskFilter, refetchTasks, showToast } from '../stores/index.js';
import { api, type Task } from '../lib/api.js';
import { suggestTagsFromTitle, mergeSuggestedTags } from '../lib/tag-suggest.js';
import { TaskCard } from '../components/TaskCard.js';
import { SortControl, type SortOrder } from '../components/SortControl.js';
import { byPriority, byDueDateAsc } from '../lib/sort.js';
import { RoutinesPanel } from '../components/RoutinesPanel.js';
import { TimeBlocksPanel } from '../components/TimeBlocksPanel.js';

export function AllTasks() {
  const [showFilters, setShowFilters] = createSignal(false);
  const [tagging, setTagging] = createSignal(false);
  const [showArchive, setShowArchive] = createSignal(false);
  const [order, setOrder] = createSignal<SortOrder>('priority');
  const [direction, setDirection] = createSignal('');
  const [doneOpen, setDoneOpen] = createSignal(true);
  const [cancelledOpen, setCancelledOpen] = createSignal(true);

  // done + cancelled live in the Archive view now, not the status filter.
  const statusOptions = ['', 'open', 'scheduled', 'in_progress', 'deferred'];
  const ARCHIVED = new Set(['done', 'cancelled']);

  const activeTaskCount = () => (tasks() ?? []).filter((t) => t.status === 'open').length;

  // Tasks/Habits/Routines/Time-Blocks tabs. Tasks & Habits list the backlog (both
  // exclude subtasks + recurrence instances — a series collapses to its template);
  // Routines & Time Blocks mount the panels lifted out of the Patterns view.
  type Tab = 'tasks' | 'habits' | 'routines' | 'timeblocks';
  const [view, setView] = createSignal<Tab>('tasks');
  const isTaskTab = () => view() === 'tasks' || view() === 'habits';
  // Switching to a panel tab drops the Tasks-only archive/filter state.
  const selectTab = (v: Tab) => {
    setView(v);
    if (v !== 'tasks' && v !== 'habits') { setShowArchive(false); setShowFilters(false); }
  };
  const isTopLevel = (t: Task) => !t.parent_id && !t.recurrence_parent_id;
  const baseList = () => (tasks() ?? []).filter(isTopLevel);

  // Direction (pattern-tag) helpers for the sort/filter control.
  const patternNames = () => new Set((tags() ?? []).filter((t) => t.kind === 'pattern').map((t) => t.name));
  const directions = () => (tags() ?? []).filter((t) => t.kind === 'pattern').map((t) => t.name);
  const taskDirection = (t: Task) => (t.tags ?? []).find((n) => patternNames().has(n));

  // Active list — excludes archived (done/cancelled); filtered by tab + direction; sorted.
  const shownList = () => {
    let list = baseList().filter((t) => !ARCHIVED.has(t.status) && (view() === 'habits' ? t.is_habit : !t.is_habit));
    if (direction()) list = list.filter((t) => taskDirection(t) === direction());
    return [...list].sort(order() === 'due' ? byDueDateAsc : byPriority);
  };
  const tabCount = (v: 'tasks' | 'habits') =>
    baseList().filter((t) => !ARCHIVED.has(t.status) && (v === 'habits' ? t.is_habit : !t.is_habit)).length;

  // Archive — done + cancelled, fetched explicitly (the default list may omit them).
  const [archived] = createResource(showArchive, async (on) => {
    if (!on) return { done: [] as Task[], cancelled: [] as Task[] };
    const [d, c] = await Promise.all([api.tasks.list({ status: 'done' }), api.tasks.list({ status: 'cancelled' })]);
    return { done: d.tasks.filter(isTopLevel), cancelled: c.tasks.filter(isTopLevel) };
  });

  /**
   * Auto-tag every untagged task in the CURRENT (active) view. Reuses the suggest-tags
   * endpoint (LLM, vocabulary-constrained) unioned with the offline heuristic, so it
   * still tags when Ollama is down and never invents a tag. Additive: only untagged
   * tasks are touched.
   */
  async function autoTagUntagged() {
    const vocab = (tags() ?? []).map((t) => t.name);
    const untagged = shownList().filter((t) => (t.tags?.length ?? 0) === 0);
    if (vocab.length === 0) { showToast('No tags yet — create some first', 'default'); return; }
    if (untagged.length === 0) { showToast('No untagged tasks in view', 'default'); return; }
    setTagging(true);
    let tagged = 0;
    try {
      for (const task of untagged) {
        let llm: string[] = [];
        try { llm = (await api.tasks.suggestTags(task.title)).tags; } catch { llm = []; }
        const merged = mergeSuggestedTags(llm, suggestTagsFromTitle(task.title, vocab), vocab);
        if (merged.length) { await api.tasks.update(task.id, { tags: merged }); tagged++; }
      }
      refetchTasks();
      showToast(
        tagged ? `Tagged ${tagged} of ${untagged.length} task${untagged.length === 1 ? '' : 's'}` : 'No matching tags found',
        tagged ? 'success' : 'default',
      );
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setTagging(false);
    }
  }

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      {/* Header */}
      <div class="flex items-center justify-between mb-5">
        <div>
          <h1 class="text-2xl font-bold text-slate-100">Tasks</h1>
          <p class="text-slate-500 text-sm mt-0.5">{activeTaskCount()} open</p>
        </div>
        <Show when={isTaskTab()}>
          <div class="flex items-center gap-2">
            <button
              onClick={autoTagUntagged}
              disabled={tagging() || showArchive()}
              class="btn-secondary gap-2"
              classList={{ 'opacity-40 pointer-events-none': showArchive() }}
              title="Tag untagged tasks in this view using your existing tag vocabulary"
            >
              <Sparkles size={14} classList={{ 'animate-pulse': tagging() }} /> {tagging() ? 'Tagging…' : 'Auto-tag'}
            </button>
            <button onClick={() => setShowFilters((v) => !v)} disabled={showArchive()} class="btn-secondary gap-2" classList={{ 'opacity-40 pointer-events-none': showArchive() }}>
              <SlidersHorizontal size={14} /> Filters
            </button>
            {/* Archive — toggle to the done + thrown-away view. */}
            <button
              onClick={() => setShowArchive((v) => !v)}
              class="btn-secondary gap-2"
              classList={{ 'border-primary text-primary': showArchive() }}
              title="View completed and thrown-away tasks"
            >
              <Archive size={14} /> Archive
            </button>
          </div>
        </Show>
      </div>

      {/* Tabs — always visible; sort sits to the right on the Task/Habit tabs. */}
      <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="flex gap-2">
          <For each={[['tasks', 'Tasks'], ['habits', 'Habits']] as const}>
            {([v, label]) => (
              <button
                onClick={() => selectTab(v)}
                class="px-3 py-1 text-sm rounded-md transition-colors"
                classList={{ 'bg-primary text-primary-foreground': view() === v, 'text-muted-foreground hover:text-foreground': view() !== v }}
              >
                {label} <span class="opacity-60 tabular-nums">{tabCount(v)}</span>
              </button>
            )}
          </For>
          <For each={[['routines', 'Routines'], ['timeblocks', 'Time Blocks']] as const}>
            {([v, label]) => (
              <button
                onClick={() => selectTab(v)}
                class="px-3 py-1 text-sm rounded-md transition-colors"
                classList={{ 'bg-primary text-primary-foreground': view() === v, 'text-muted-foreground hover:text-foreground': view() !== v }}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <Show when={isTaskTab() && !showArchive()}>
          <SortControl
            order={order()}
            onOrder={setOrder}
            showDirection
            direction={direction()}
            directions={directions()}
            onDirection={setDirection}
          />
        </Show>
      </div>

      {/* ── Task / Habit backlog ── */}
      <Show when={isTaskTab()}>
        <Show when={!showArchive()}>
          <Show when={showFilters()}>
            <div class="card mb-4 flex gap-2 flex-wrap animate-slide-down">
              <div class="flex-[2] min-w-[16rem] relative">
                <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  class="input pl-8"
                  placeholder="Search…"
                  value={taskFilter().q ?? ''}
                  onInput={(e) => setTaskFilter((f) => ({ ...f, q: e.currentTarget.value || '' }))}
                />
              </div>
              <select
                class="input w-auto"
                value={taskFilter().status ?? ''}
                onChange={(e) => setTaskFilter((f) => ({ ...f, status: e.currentTarget.value }))}
              >
                {statusOptions.map((s) => <option value={s}>{s || 'All statuses'}</option>)}
              </select>
              <select
                class="input w-auto"
                value={taskFilter().tag ?? ''}
                onChange={(e) => setTaskFilter((f) => ({ ...f, tag: e.currentTarget.value }))}
              >
                <option value="">All tags</option>
                <For each={tags()}>
                  {(t) => <option value={t.name}>#{t.name} ({t.count})</option>}
                </For>
              </select>
              <button class="btn-ghost text-xs" onClick={() => setTaskFilter({})}>Clear</button>
            </div>
          </Show>

          {/* List — top-level only; recurring series collapse to their template. */}
          <div class="flex flex-col gap-2">
            <Show when={shownList().length > 0} fallback={
              <div class="card text-center text-slate-500 py-12 text-sm">No {view() === 'habits' ? 'habits' : 'tasks'} found.</div>
            }>
              <For each={shownList()}>
                {(task) => <TaskCard task={task} />}
              </For>
            </Show>
          </div>
        </Show>

        {/* Archive view — completed + thrown-away, in two collapsible containers. */}
        <Show when={showArchive()}>
          <ArchiveSection
            title="Completed"
            open={doneOpen()}
            onToggle={() => setDoneOpen((v) => !v)}
            items={archived()?.done ?? []}
            loading={archived.loading}
            emptyLabel="No completed tasks."
          />
          <ArchiveSection
            title="Thrown away"
            open={cancelledOpen()}
            onToggle={() => setCancelledOpen((v) => !v)}
            items={archived()?.cancelled ?? []}
            loading={archived.loading}
            emptyLabel="Nothing thrown away."
          />
        </Show>
      </Show>

      {/* ── Routines / Time Blocks — panels lifted from the Patterns view ── */}
      <Show when={view() === 'routines'}><RoutinesPanel /></Show>
      <Show when={view() === 'timeblocks'}><TimeBlocksPanel /></Show>
    </div>
  );
}

/** A collapsible Archive container (Completed / Thrown away). */
function ArchiveSection(props: {
  title: string;
  open: boolean;
  onToggle: () => void;
  items: Task[];
  loading: boolean;
  emptyLabel: string;
}) {
  return (
    <div class="card mb-3">
      <button onClick={props.onToggle} class="flex items-center gap-2 w-full text-left text-sm font-semibold text-foreground">
        <Show when={props.open} fallback={<ChevronRight size={15} class="text-muted-foreground" />}>
          <ChevronDown size={15} class="text-muted-foreground" />
        </Show>
        {props.title}
        <span class="opacity-60 tabular-nums font-normal">{props.items.length}</span>
      </button>
      <Show when={props.open}>
        <div class="flex flex-col gap-2 mt-3">
          <Show when={props.loading}>
            <div class="text-xs text-muted-foreground animate-pulse2 py-2">Loading…</div>
          </Show>
          <For each={props.items}>
            {(task) => <TaskCard task={task} />}
          </For>
          <Show when={!props.loading && props.items.length === 0}>
            <div class="text-center text-slate-500 py-6 text-sm">{props.emptyLabel}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
