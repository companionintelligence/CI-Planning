import { createSignal, createResource, Show, For } from 'solid-js';
import { SlidersHorizontal, Search, Sparkles, Archive, ChevronDown, ChevronRight } from 'lucide-solid';
import { tasks, tags, taskFilter, setTaskFilter, refetchTasks, showToast, isRoutineTask, scheduledByTaskId, patternForTask } from '../stores/index.js';
import { api, type Task } from '../lib/api.js';
import { colorVar } from '../lib/pattern-meta.js';
import { suggestTagsFromTitle, mergeSuggestedTags } from '../lib/tag-suggest.js';
import { TaskCard } from '../components/TaskCard.js';
import { ShapeIcon } from '../components/ShapeIcon.js';
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
  // §E: the Tasks tab groups the backlog into Open / Scheduled / Routine sections.
  const [openSecOpen, setOpenSecOpen] = createSignal(true);
  const [schedSecOpen, setSchedSecOpen] = createSignal(true);
  const [routineSecOpen, setRoutineSecOpen] = createSignal(true);

  // done + cancelled live in the Archive view now, not the status filter.
  const statusOptions = ['', 'open', 'scheduled', 'in_progress', 'deferred'];
  const ARCHIVED = new Set(['done', 'cancelled']);

  // A task completed TODAY (owner-tz baseline = UTC, as everywhere) stays in the active
  // list — rendered checked — and only falls into the Archive once the day rolls over.
  // Derived by date, so no background job is needed to "move at end of day".
  const utcToday = () => new Date().toISOString().slice(0, 10);
  const isDoneToday = (t: Task) =>
    t.status === 'done' && !!t.completed_at && t.completed_at.slice(0, 10) === utcToday();
  // Shown in the active backlog: everything not archived, PLUS today's completions
  // (cancelled always archives immediately — no same-day grace). Routine tasks are a
  // repeatable checklist: they are NEVER archived on completion — they stay in the list
  // (checked) and the midnight `reset_routines` job flips them back to open. Only a
  // cancelled (thrown-away) routine task leaves the active list.
  const inActiveList = (t: Task) =>
    isRoutineTask(t.id) ? t.status !== 'cancelled' : (!ARCHIVED.has(t.status) || isDoneToday(t));

  // Header count matches what the default Tasks view actually shows as "Open" (top-level,
  // non-routine, non-scheduled backlog) so the header number and the "Open ⟨n⟩" section agree.
  const activeTaskCount = () => openList().length;

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
  const patternNames = () => new Set((tags() ?? []).filter((t) => t.kind === 'direction').map((t) => t.name));
  const directions = () => (tags() ?? []).filter((t) => t.kind === 'direction').map((t) => t.name);
  const taskDirection = (t: Task) => (t.tags ?? []).find((n) => patternNames().has(n));

  // Active list — excludes archived (done/cancelled) except today's completions; filtered
  // by tab + direction; sorted.
  const shownList = () => {
    let list = baseList().filter((t) => inActiveList(t) && (view() === 'habits' ? t.is_habit : !t.is_habit));
    if (direction()) list = list.filter((t) => taskDirection(t) === direction());
    return [...list].sort(order() === 'due' ? byDueDateAsc : byPriority);
  };
  const tabCount = (v: 'tasks' | 'habits') =>
    baseList().filter((t) => inActiveList(t) && (v === 'habits' ? t.is_habit : !t.is_habit)).length;

  // §E: partition the (already filtered+sorted) Tasks-tab backlog. Routine membership
  // wins the grouping (a routine task can also be scheduled — it still lands here);
  // then scheduled/in-progress; everything else (open/deferred/…) is Open.
  const hasStatusFilter = () => !!taskFilter().status;
  // "Scheduled" = a real placement on the planner (any engine) OR a persisted scheduled/
  // in_progress status — so auto-placed tasks group correctly, not just manual ones.
  const isScheduledish = (t: Task) => t.status === 'scheduled' || t.status === 'in_progress' || scheduledByTaskId().has(t.id);
  const routineList = () => shownList().filter((t) => isRoutineTask(t.id));
  const scheduledList = () => shownList().filter((t) => !isRoutineTask(t.id) && isScheduledish(t));
  const openList = () => shownList().filter((t) => !isRoutineTask(t.id) && !isScheduledish(t));
  // Explicit status filter → flat list; routine tasks never appear under the 'open' filter.
  const explicitList = () => (taskFilter().status === 'open' ? shownList().filter((t) => !isRoutineTask(t.id)) : shownList());

  // §E follow-up: cluster the Routine section by routine, preserving the sorted order —
  // each routine's members render together under a sub-header (icon + name + count).
  interface RoutineGroup { id: string; name: string; iconShape?: string; colorToken?: string | null; items: Task[] }
  const routineGroups = (): RoutineGroup[] => {
    const groups = new Map<string, RoutineGroup>();
    for (const t of routineList()) {
      const info = patternForTask(t.id);
      const id = info?.pattern.id ?? '_ungrouped';
      let g = groups.get(id);
      if (!g) {
        g = { id, name: info?.pattern.name ?? 'Routine', iconShape: info?.type?.icon_shape, colorToken: info?.type?.color_token, items: [] };
        groups.set(id, g);
      }
      g.items.push(t);
    }
    return [...groups.values()];
  };

  // Archive — done (before today) + cancelled, fetched explicitly. Re-keyed on tasks() so
  // it refetches whenever a task mutates while the panel is open — e.g. un-checking a
  // completed task there flips it back to open and it leaves the archive immediately.
  // Today's completions are filtered out (they're still in the active list).
  const [archived] = createResource(
    () => (showArchive() ? (tasks() ?? []) : null),
    async () => {
      const [d, c] = await Promise.all([api.tasks.list({ status: 'done' }), api.tasks.list({ status: 'cancelled' })]);
      return {
        // Routine tasks are never archived on completion (they reset at midnight), so
        // they never appear in Completed — only the day's completions are also withheld.
        done: d.tasks.filter((t) => isTopLevel(t) && !isDoneToday(t) && !isRoutineTask(t.id)),
        cancelled: c.tasks.filter(isTopLevel),
      };
    },
  );

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
                {statusOptions.map((s) => <option value={s}>{s || 'All Active'}</option>)}
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

          {/* List — top-level only; recurring series collapse to their template.
              Habits + any explicit status filter render flat; the default Tasks tab
              groups into Open / Scheduled / Routine sections (§E). */}
          <Show
            when={view() === 'tasks' && !hasStatusFilter()}
            fallback={
              <div class="flex flex-col gap-2">
                <Show when={(view() === 'habits' ? shownList() : explicitList()).length > 0} fallback={
                  <div class="card text-center text-slate-500 py-12 text-sm">No {view() === 'habits' ? 'habits' : 'tasks'} found.</div>
                }>
                  <For each={view() === 'habits' ? shownList() : explicitList()}>
                    {(task) => <TaskCard task={task} />}
                  </For>
                </Show>
              </div>
            }
          >
            <Show
              when={openList().length + scheduledList().length + routineList().length > 0}
              fallback={<div class="card text-center text-slate-500 py-12 text-sm">No tasks found.</div>}
            >
              <Show when={openList().length > 0}>
                <ArchiveSection title="Open" open={openSecOpen()} onToggle={() => setOpenSecOpen((v) => !v)} items={openList()} loading={false} emptyLabel="" />
              </Show>
              <Show when={scheduledList().length > 0}>
                <ArchiveSection title="Scheduled" open={schedSecOpen()} onToggle={() => setSchedSecOpen((v) => !v)} items={scheduledList()} loading={false} emptyLabel="" />
              </Show>
              <Show when={routineList().length > 0}>
                <RoutineSection
                  open={routineSecOpen()}
                  onToggle={() => setRoutineSecOpen((v) => !v)}
                  count={routineList().length}
                  groups={routineGroups()}
                />
              </Show>
            </Show>
          </Show>
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

/** The Routine backlog section — collapsible, with tasks clustered by routine under a
 *  per-routine sub-header (icon + name + count). */
function RoutineSection(props: {
  open: boolean;
  onToggle: () => void;
  count: number;
  groups: { id: string; name: string; iconShape?: string; colorToken?: string | null; items: Task[] }[];
}) {
  return (
    <div class="card mb-3">
      <button onClick={props.onToggle} class="flex items-center gap-2 w-full text-left text-sm font-semibold text-foreground">
        <Show when={props.open} fallback={<ChevronRight size={15} class="text-muted-foreground" />}>
          <ChevronDown size={15} class="text-muted-foreground" />
        </Show>
        Routine
        <span class="opacity-60 tabular-nums font-normal">{props.count}</span>
      </button>
      <Show when={props.open}>
        <div class="flex flex-col gap-4 mt-3">
          <For each={props.groups}>
            {(g) => (
              <div class="flex flex-col gap-2">
                <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title={`Routine: ${g.name}`}>
                  <span class="inline-flex" style={{ color: colorVar(g.colorToken) }}>
                    <ShapeIcon shape={g.iconShape ?? 'circle'} size={12} strokeWidth={1.75} />
                  </span>
                  <span class="truncate">{g.name}</span>
                  <span class="opacity-60 tabular-nums">{g.items.length}</span>
                </div>
                <For each={g.items}>
                  {(task) => <TaskCard task={task} />}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
