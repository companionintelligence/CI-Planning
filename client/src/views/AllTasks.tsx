import { createSignal, createResource, createMemo, createEffect, onCleanup, Show, For } from 'solid-js';
import { ViewHeader } from '../components/ViewHeader.js';
import { useSearchParams } from '@solidjs/router';
import { SlidersHorizontal, Search, Archive, ChevronDown, ChevronRight, X, CalendarRange, Pencil, Pentagon, Clock3 } from 'lucide-solid';
import { tasks, tags, concepts, prefs, taskFilter, setTaskFilter, refetchTasks, showToast, isRoutineTask, scheduledByTaskId, patternForTask, setPlanWeekModal, setElementModal } from '../stores/index.js';
import { api, type Block, type Task } from '../lib/api.js';
import { colorVar } from '../lib/pattern-meta.js';
import { localISODate } from '../lib/dates.js';
import { TaskCard } from '../components/TaskCard.js';
import { EmptyStateConnectCTA } from '../components/EmptyStateConnectCTA.js';
import { ShapeIcon } from '../components/ShapeIcon.js';
import { SortControl, type SortOrder } from '../components/SortControl.js';
import { byPriority, byDueDateAsc } from '../lib/sort.js';
import { RoutinesPanel } from '../components/RoutinesPanel.js';
import { TimeBlocksPanel } from '../components/TimeBlocksPanel.js';
import { ObjectivesPanel } from '../components/ObjectivesPanel.js';
import { parseTasksTab, type TasksTab } from '../lib/tasks-tabs.js';
import { setActiveTask } from '../stores/selection.js';
import { setDetailsOpen } from '../stores/ui.js';
import { partitionTaskSections, headerOpenCount } from '../lib/task-sections.js';
import { SuggestionsSection } from '../components/SuggestionsSection.js';
import { splitBlockTag } from '../lib/element.js';
import { Skeleton } from '../components/Skeleton.js';

export function AllTasks() {
  const [showFilters, setShowFilters] = createSignal(false);
  const [showArchive, setShowArchive] = createSignal(false);
  const [order, setOrder] = createSignal<SortOrder>('priority');
  const [direction, setDirection] = createSignal('');
  // Always-visible task search (client-side over the loaded list, title + tag names).
  // Distinct from the Filters panel's server `q` — that mutates the SHARED taskFilter
  // store and would filter Today/Focus too; this is local to the Tasks view.
  const [search, setSearch] = createSignal('');
  const matchesSearch = (t: Task): boolean => {
    const q = search().trim().toLowerCase();
    if (!q) return true;
    if (t.title.toLowerCase().includes(q)) return true;
    return [...(t.tags ?? []), ...(t.secondary_tags ?? [])].some((n) => n.toLowerCase().includes(q));
  };
  const matchesConceptSearch = (b: Block): boolean => {
    const q = search().trim().toLowerCase();
    if (!q) return true;
    const { primary, secondary } = splitBlockTag(b.tag);
    return [b.title, b.note ?? '', primary, ...secondary, ...(b.secondary_tags ?? [])]
      .some((value) => value.toLowerCase().includes(q));
  };
  const [doneOpen, setDoneOpen] = createSignal(true);
  const [cancelledOpen, setCancelledOpen] = createSignal(true);
  // §E / AF-7: the Tasks tab groups the backlog into New Today / Open / Scheduled /
  // Routine sections.
  const [newTodaySecOpen, setNewTodaySecOpen] = createSignal(true);
  const [openSecOpen, setOpenSecOpen] = createSignal(true);
  const [somedaySecOpen, setSomedaySecOpen] = createSignal(true);
  const [schedSecOpen, setSchedSecOpen] = createSignal(true);
  const [routineSecOpen, setRoutineSecOpen] = createSignal(true);

  // done + cancelled live in the Archive view now, not the status filter.
  const statusOptions = ['', 'open', 'scheduled', 'in_progress', 'deferred'];
  const ARCHIVED = new Set(['done', 'cancelled']);

  // A task completed TODAY stays in the active list — rendered checked — and only falls
  // into the Archive once the day rolls over (derived by date, so no background job is
  // needed to "move at end of day"). Uses the client's LOCAL day (localISODate) to match
  // the rest of the client's day-boundary convention — a UTC comparison would flip the
  // day around midnight for non-UTC users.
  const isDoneToday = (t: Task) =>
    t.status === 'done' && !!t.completed_at && localISODate(new Date(t.completed_at)) === localISODate();
  // Shown in the active backlog: everything not archived, PLUS today's completions
  // (cancelled always archives immediately — no same-day grace). Routine tasks are a
  // repeatable checklist: they are NEVER archived on completion — they stay in the list
  // (checked) and the midnight `reset_routines` job flips them back to open. Only a
  // cancelled (thrown-away) routine task leaves the active list.
  const inActiveList = (t: Task) =>
    isRoutineTask(t.id) ? t.status !== 'cancelled' : (!ARCHIVED.has(t.status) || isDoneToday(t));

  // Header "N open" count — owner decision (AF-7 follow-up): a task created today is
  // open IMMEDIATELY, so the count spans the New Today AND Open sections (a task sits in
  // exactly one, so no double-count). Scheduled/Routine are excluded by the partition
  // itself now that Scheduled outranks New Today, and done/cancelled rows never count.
  // The midnight rollover (New Today → Open) leaves this number unchanged.
  // Derived from the shared `sections` memo (defined below) — no second partition run.
  const activeTaskCount = () => headerOpenCount(sections());

  // Tasks/Objectives/Habits/Routines/Timeblock tabs. Tasks & Habits list the backlog
  // (both exclude subtasks + recurrence instances — a series collapses to its template);
  // Objectives, Routines & Timeblock mount extracted panels. AF-1: the active tab is
  // URL-driven (`/tasks?tab=…`) so deep-links and reloads land on the same tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = () => parseTasksTab(searchParams.tab);
  const isTaskTab = () => view() === 'tasks' || view() === 'habits';
  // Switching to a panel tab drops the Tasks-only archive/filter state; the
  // objectives deep-link focus (`?focus=`) is cleared on any explicit tab change.
  const selectTab = (v: TasksTab) => {
    setSearchParams({ tab: v, focus: undefined, task: undefined });
    if (v !== 'tasks' && v !== 'habits') { setShowArchive(false); setShowFilters(false); }
  };

  // AF-D: `?task=<id>` selects a task and opens the drawer on it. This is what makes the
  // drawer's subtask rows real hotlinks — cmd/middle-click opens a genuine browser tab
  // that lands on the same task, instead of a bare /tasks with nothing selected. Consumed
  // ONCE (mirrors `?focus=`), so a later manual deselect isn't fought by a re-run.
  let consumedTaskParam: string | undefined;
  createEffect(() => {
    const id = typeof searchParams.task === 'string' ? searchParams.task : undefined;
    if (!id || consumedTaskParam === id) return;
    consumedTaskParam = id;
    setActiveTask(id);
    setDetailsOpen(true);
  });
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
    list = list.filter(matchesSearch);
    return [...list].sort(order() === 'due' ? byDueDateAsc : byPriority);
  };
  // §E / AF-7: partition the (already filtered+sorted) Tasks-tab backlog into four
  // sections. Precedence: Routine wins (a routine task can also be scheduled — it still
  // lands here); then scheduled/in-progress, so placing a task moves its card out of New
  // Today ON PLACEMENT rather than at midnight; then New Today (anything created on the
  // owner-local today and still unscheduled — manual, quick-add, or an AF-3 auto-promoted
  // suggestion); then Open. Nothing is listed twice, and an unscheduled New Today task
  // falls into Open purely because the local day rolled over — no schema column, no
  // nightly job (see lib/task-sections.ts).
  const hasStatusFilter = () => !!taskFilter().status;
  // "Scheduled" = a real placement on the planner (any engine) OR a persisted scheduled/
  // in_progress status — so auto-placed tasks group correctly, not just manual ones.
  const isScheduledish = (t: Task) => t.status === 'scheduled' || t.status === 'in_progress' || scheduledByTaskId().has(t.id);

  // Day-tick: the New Today boundary must move at the local midnight even if the view
  // just sits open — otherwise New Today never drains until some unrelated state change.
  // A signal holds today's local date; a timeout re-armed for the NEXT local midnight
  // (delay recomputed each fire — DST can stretch/shrink a day, so never assume 24h)
  // bumps it, which re-runs the sections memo below. Small buffer past midnight guards
  // against timers firing a hair early. Component-scoped; cleaned up on unmount.
  const [todayISO, setTodayISO] = createSignal(localISODate());
  let midnightTimer: ReturnType<typeof setTimeout> | undefined;
  const armMidnightTick = () => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    midnightTimer = setTimeout(() => {
      setTodayISO(localISODate());
      armMidnightTick();
    }, nextMidnight.getTime() - now.getTime() + 250);
  };
  armMidnightTick();
  onCleanup(() => clearTimeout(midnightTimer));

  // One shared partition for the section lists AND the header count (component-scoped
  // memo — repo gotcha: module-scope memos evaluate eagerly and break resource ordering).
  const sections = createMemo(() =>
    partitionTaskSections(shownList(), { isRoutine: (t) => isRoutineTask(t.id), isScheduled: isScheduledish, todayISO: todayISO() }));
  const newTodayList = () => sections().newToday;
  const routineList = () => sections().routine;
  const scheduledList = () => sections().scheduled;
  const openList = () => sections().open;
  const somedayList = () => {
    const selectedDirection = direction();
    return (concepts() ?? [])
      .filter((b) => matchesConceptSearch(b))
      .filter((b) => !selectedDirection || splitBlockTag(b.tag).primary === selectedDirection)
      .sort((a, b) => (a.goal_start_date ?? '9999-12-31').localeCompare(b.goal_start_date ?? '9999-12-31') || a.title.localeCompare(b.title));
  };
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
        // #391: the group tint is item-first (the routine's own colour beats its type's).
        g = { id, name: info?.pattern.name ?? 'Routine', iconShape: info?.type?.icon_shape, colorToken: info?.pattern.color_token ?? info?.type?.color_token, items: [] };
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

  return (
    <div class="view-container page-enter">
      <ViewHeader title="Tasks" sub={`${activeTaskCount()} open`}>
        <Show when={isTaskTab()}>
          <button
            onClick={() => setPlanWeekModal({ open: true })}
            class="btn-secondary gap-2 whitespace-nowrap"
            title="Plan your week with the assistant"
          >
            <CalendarRange size={14} /> Plan my week
          </button>
          <button onClick={() => setShowFilters((v) => !v)} disabled={showArchive()} class="btn-secondary gap-2 whitespace-nowrap" classList={{ 'opacity-40 pointer-events-none': showArchive() }}>
            <SlidersHorizontal size={14} /> Filters
          </button>
          <button
            onClick={() => setShowArchive((v) => !v)}
            class="btn-secondary gap-2 whitespace-nowrap"
            classList={{ 'border-primary text-primary': showArchive() }}
            title="View completed and thrown-away tasks"
          >
            <Archive size={14} /> Archive
          </button>
        </Show>
      </ViewHeader>

      {/* Tabs — always visible; sort sits to the right on the Task/Habit tabs. */}
      <div class="view-tabs justify-between" role="tablist">
        <div class="flex flex-wrap">
          {/* AF-1 order: Tasks · Objectives · Habits · Routines · Timeblock. */}
          <For each={[
            ['tasks', 'Tasks'],
            ['objectives', 'Objectives'],
            ['habits', 'Habits'],
            ['routines', 'Routines'],
            ['timeblocks', 'Timeblock'],
          ] as const}>
            {([v, label]) => (
              <button role="tab" class="view-tab" aria-selected={view() === v} onClick={() => selectTab(v)}>
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
          {/* Always-visible task search — filters the loaded list by title + tag names. */}
          <div class="relative flex-1 min-w-[10rem] max-w-md">
            <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              class="input pl-8 pr-8 w-full"
              type="search"
              placeholder="Search tasks…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <Show when={search()}>
              <button
                type="button"
                onClick={() => setSearch('')}
                title="Clear search"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-foreground"
              >
                <X size={13} />
              </button>
            </Show>
          </div>
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

          {/* Email review queue. Sits ABOVE the list branch (not inside it) so it is
              equally visible when the owner has no tasks at all — otherwise the
              "No tasks found." fallback would hide the entire queue. Renders nothing
              when empty. Tasks view only; the Habits view is a different lens. */}
          <Show when={view() === 'tasks'}>
            <SuggestionsSection />
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
              when={newTodayList().length + openList().length + somedayList().length + scheduledList().length + routineList().length > 0}
              fallback={<div class="flex flex-col gap-2">
                <div class="card text-center text-slate-500 py-12 text-sm flex flex-col items-center gap-2">
                  No tasks found.
                  <button type="button" class="btn-primary text-xs" onClick={() => setElementModal({ open: true, mode: 'add', kind: null })}>
                    Add a task
                  </button>
                  <EmptyStateConnectCTA />
                </div>
                <SomedayTasksSection
                  open={somedaySecOpen()}
                  onToggle={() => setSomedaySecOpen((v) => !v)}
                  items={somedayList()}
                  defaultMinutes={prefs()?.concept_default_minutes ?? 60}
                />
              </div>}
            >
              {/* AF-7: everything created on the local today, above the standing sections.
                  Rolls into Open/Scheduled at the local midnight by pure date derivation. */}
              <Show when={newTodayList().length > 0}>
                <ArchiveSection title="New Today" open={newTodaySecOpen()} onToggle={() => setNewTodaySecOpen((v) => !v)} items={newTodayList()} loading={false} emptyLabel="" />
              </Show>
              <Show when={openList().length > 0}>
                <ArchiveSection title="Open" open={openSecOpen()} onToggle={() => setOpenSecOpen((v) => !v)} items={openList()} loading={false} emptyLabel="" />
              </Show>
              <SomedayTasksSection
                open={somedaySecOpen()}
                onToggle={() => setSomedaySecOpen((v) => !v)}
                items={somedayList()}
                defaultMinutes={prefs()?.concept_default_minutes ?? 60}
              />
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

      {/* ── Objectives — tree panel lifted from the retired /objectives view (AF-1) ── */}
      <Show when={view() === 'objectives'}><ObjectivesPanel /></Show>

      {/* ── Routines / Timeblock — panels lifted from the Patterns view ── */}
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
      <button onClick={props.onToggle} class="flex items-center gap-2 w-full text-left text-sm font-semibold text-foreground" aria-expanded={props.open}>
        <Show when={props.open} fallback={<ChevronRight size={15} class="text-muted-foreground" />}>
          <ChevronDown size={15} class="text-muted-foreground" />
        </Show>
        {props.title}
        <span class="opacity-60 tabular-nums font-normal">{props.items.length}</span>
      </button>
      <Show when={props.open}>
        <div class="flex flex-col gap-2 mt-3">
          <Show when={props.loading}>
            <div role="status" class="flex flex-col gap-2">
              <span class="sr-only">Loading</span>
              <Skeleton class="h-12" />
              <Skeleton class="h-12" />
            </div>
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

/** Someday Tasks are unscheduled goal blocks, shown beside the task backlog without
 *  staging them. Editing keeps the original goal/estimate; promotion is offered in the
 *  Weekly Review so a deliberate choice creates an ordinary open task. */
function SomedayTasksSection(props: {
  open: boolean;
  onToggle: () => void;
  items: Block[];
  defaultMinutes: number;
}) {
  return (
    <div class="card mb-3">
      <button onClick={props.onToggle} class="flex items-center gap-2 w-full text-left text-sm font-semibold text-foreground" aria-expanded={props.open}>
        <Show when={props.open} fallback={<ChevronRight size={15} class="text-muted-foreground" />}>
          <ChevronDown size={15} class="text-muted-foreground" />
        </Show>
        Someday Tasks
        <span class="opacity-60 tabular-nums font-normal">{props.items.length}</span>
      </button>
      <Show when={props.open}>
        <div class="flex flex-col gap-2 mt-3">
          <For each={props.items}>{(item) => <SomedayTaskRow item={item} defaultMinutes={props.defaultMinutes} />}</For>
          <Show when={props.items.length === 0}>
            <div class="text-xs text-muted-foreground py-2">No Someday Tasks yet.</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function SomedayTaskRow(props: { item: Block; defaultMinutes: number }) {
  const openEdit = () => setElementModal({
    open: true,
    mode: 'edit',
    kind: 'timeblock',
    editTarget: { kind: 'timeblock', id: props.item.id },
  });
  const estimate = () => props.item.duration_minutes ?? props.defaultMinutes;
  const estimateLabel = () => {
    const mins = estimate();
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${mins}m`;
  };
  const goalLabel = () => {
    const date = props.item.goal_start_date;
    if (!date) return 'No goal date';
    const parsed = new Date(`${date}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? date : `Goal · ${parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  };
  const tagNames = () => {
    const { primary, secondary } = splitBlockTag(props.item.tag);
    return [...new Set([primary, ...secondary, ...(props.item.secondary_tags ?? [])].filter(Boolean))];
  };
  return (
    <div class="flex items-center gap-3 border border-border bg-background/40 px-3 py-2">
      <Pentagon size={14} class="text-muted-foreground flex-shrink-0" />
      <button type="button" class="min-w-0 flex-1 text-left" onClick={openEdit} title="Edit Someday Task">
        <span class="block truncate text-sm font-medium text-foreground">{props.item.title}</span>
        <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{goalLabel()}</span>
          <span class="inline-flex items-center gap-1"><Clock3 size={11} /> {estimateLabel()}</span>
          <For each={tagNames()}>{(name) => <span class="text-primary">#{name}</span>}</For>
        </span>
        <Show when={props.item.note}>{(note) => <span class="block truncate text-[11px] text-muted-foreground/80">{note()}</span>}</Show>
      </button>
      <button type="button" class="btn-icon flex-shrink-0" onClick={openEdit} title="Edit Someday Task" aria-label={`Edit ${props.item.title}`}>
        <Pencil size={13} />
      </button>
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
