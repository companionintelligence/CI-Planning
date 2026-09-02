import { For, Show, createSignal, createMemo, createResource, createEffect } from 'solid-js';
import {
  Zap, CalendarCheck, X, ChevronDown, ChevronRight, ChevronLeft, Repeat2, Trash2,
  Star, Plus, Check as CheckIcon,
} from 'lucide-solid';
import { api, type FlightPlanItem, type Task, type BlockTemplate } from '../lib/api.js';
import {
  flightPlan, refetchFlightPlan, refetchBlocks, prefs, refetchPrefs, showToast, selectedDay,
  blockTemplates, refetchBlockTemplates, flightPlanTaskIds, patterns,
} from '../stores/index.js';
import { isSelected, toggleSelection, setActiveTask, activeTask } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';
import { useDraggable } from '../lib/draggable.js';
import { splitTagNames } from '../lib/multi-tag.js';
import {
  groupFlightPlan, buildRows, pageSlice, filterByName, defaultPlaceTimeHHMM, localDayTimeToISO,
  type PagedSlice, type FpRowModel,
} from '../lib/flight-plan-view.js';

/**
 * The Flight-plan (Phase G, G5 + G4 cockpit-v2 redesign): the persisted staging
 * area with **two explicit buttons** and no hidden-state branching.
 *
 *  - **Fill Flight Plan**: always proposes candidates *into* the flight-plan.
 *    Never places anything on the calendar.
 *  - **Auto Schedule**: always places the selected staged tasks — tag-matched into
 *    Plans, then direction windows, then leftover workday capacity ordered by the
 *    Priority / Due Date / New Today toggle. Never proposes candidates.
 *
 * The Suggest / Schedule toggle has moved to the Day Overview header (Today.tsx).
 * Per-direction fill is configured in Settings → Schedule Patterns.
 * The general workday fallback is configured in Settings → Schedule Patterns →
 * "Fill work hours for undirected tasks".
 *
 * Manual placement (CON-5): each row is a drag source (`kind: 'flight-task'`) —
 * drag one onto the Planner grid to schedule it at that time.
 *
 * Two tabs (cockpit paging rework):
 *  - **Plan** — the staging area above, now searchable and paged (10 rows/page; a
 *    collapsed routine group is one row, an expanded group is header + members).
 *    Selection lives server-side, so Schedule acts on ALL selected items, not just
 *    the visible page. A non-empty search also surfaces matching *backlog* tasks
 *    below the staged list with a one-click stage action.
 *  - **Saved blocks** — the reusable `block_templates` (same API the Tasks-screen
 *    Time Blocks tab uses): list / search / create / delete, plus a "place" flow
 *    that instantiates a template onto the selected day at a chosen time.
 */
export function FlightPlan() {
  const [running, setRunning] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [tab, setTab] = createSignal<'plan' | 'saved'>('plan');
  const items = () => flightPlan() ?? [];
  const selectedCount = () => items().filter((i) => i.selected).length;

  const fillOrder = () => prefs()?.fill_order ?? 'priority';
  async function setFillOrder(o: 'priority' | 'overdue' | 'new_today') {
    if (o === fillOrder()) return;
    try { await api.prefs.update({ fill_order: o }); refetchPrefs(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Routine (pattern) id → name, so a flight-plan group header shows the routine's
  // real name instead of the literal 'Pattern' fallback. Groups key on source_ref
  // (the pattern id); see groupFlightPlan.
  const patternName = createMemo(() => {
    const m = new Map<string, string>();
    for (const p of patterns() ?? []) m.set(p.id, p.name);
    return m;
  });

  // ── Plan tab: search → group → flatten → page ─────────────────────────────────
  const [planQuery, setPlanQuery] = createSignal('');
  const [planPage, setPlanPage] = createSignal(0);
  createEffect(() => { planQuery(); setPlanPage(0); }); // new search restarts at page 1

  // Group open/closed state, lifted out of the group row so paging can count an
  // expanded group's members as rows. Default open (matches the old behavior).
  const [closedGroups, setClosedGroups] = createSignal<Set<string>>(new Set());
  const isGroupOpen = (pid: string) => !closedGroups().has(pid);
  function toggleGroup(pid: string) {
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  }

  const filteredItems = createMemo(() => filterByName(items(), planQuery(), (i) => i.title));
  const planRows = createMemo<FpRowModel<FlightPlanItem>[]>(() =>
    buildRows(groupFlightPlan(filteredItems()), isGroupOpen));
  const planSlice = createMemo(() => pageSlice(planRows(), planPage()));

  // ── Plan tab: "Add from backlog" (search-driven) ──────────────────────────────
  // Open tasks are fetched once when a search begins (the source flips truthy);
  // matching + staged-exclusion are reactive client-side filters over that fetch.
  const backlogActive = () => planQuery().trim().length > 0;
  const [openTasks] = createResource(
    () => (backlogActive() ? 'open' : null),
    () => api.tasks.list({ status: 'open' }).then((r) => r.tasks),
  );
  const BACKLOG_CAP = 8;
  const backlogMatches = createMemo<Task[]>(() => {
    if (!backlogActive()) return [];
    const staged = flightPlanTaskIds();
    return filterByName(openTasks() ?? [], planQuery(), (t) => t.title)
      // already staged → shown above; recurrence instances can't be staged (422 server-side)
      .filter((t) => !staged.has(t.id) && !t.recurrence_parent_id);
  });

  async function stageFromBacklog(t: Task) {
    try {
      await api.flightPlan.addTask(t.id);
      refetchFlightPlan();
      showToast(`Staged "${t.title}"`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Saved-blocks tab: search + page over the shared block_templates store ─────
  const [savedQuery, setSavedQuery] = createSignal('');
  const [savedPage, setSavedPage] = createSignal(0);
  createEffect(() => { savedQuery(); setSavedPage(0); });
  const filteredTemplates = createMemo(() =>
    filterByName(blockTemplates() ?? [], savedQuery(), (t) => t.name));
  const savedSlice = createMemo(() => pageSlice(filteredTemplates(), savedPage()));

  async function toggleMany(its: FlightPlanItem[], selected: boolean) {
    for (const it of its) await api.flightPlan.update(it.task_id, { selected });
    refetchFlightPlan();
  }
  async function removeMany(its: FlightPlanItem[]) {
    for (const it of its) await api.flightPlan.remove(it.task_id);
    refetchFlightPlan();
  }

  // Fill Flight Plan: always proposes candidates into the staging area; never places.
  async function runFill() {
    setRunning(true);
    try {
      const { result } = await api.auto.fill({ date: selectedDay() });
      showToast(
        result.candidatesAdded
          ? `Proposed ${result.candidatesAdded} candidate${result.candidatesAdded === 1 ? '' : 's'} — select some and press Schedule`
          : 'No open tasks to propose',
        'default',
      );
      refetchFlightPlan();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  }

  // Auto Schedule: always places selected staged tasks; never proposes candidates.
  async function toggle(taskId: string, selected: boolean) {
    try { await api.flightPlan.update(taskId, { selected }); refetchFlightPlan(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function remove(taskId: string) {
    try { await api.flightPlan.remove(taskId); refetchFlightPlan(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function reset() {
    try {
      const r = await api.flightPlan.reset();
      // Undo lives in the Planner header now and re-syncs from `can_undo` on the
      // refetch below. This used to hide it optimistically here, which was wrong
      // anyway: clearing the STAGING list does not un-place the blocks a Schedule
      // run created, so the undo is still meaningful afterwards.
      refetchFlightPlan();
      showToast(`Cleared ${r.cleared}`, 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const Check = (props: { on: boolean }) => (
    <Show when={props.on}>
      <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
        <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </Show>
  );

  const FpRow = (props: { it: FlightPlanItem; inGroup?: boolean }) => {
    const p = () => Math.min(Math.max(props.it.priority ?? 3, 1), 5);
    const selected = () => isSelected({ kind: 'flight-plan-task', id: props.it.task_id });
    const drag = useDraggable(() => ({ kind: 'flight-task', id: props.it.task_id }));
    return (
      <li
        onPointerDown={drag.onPointerDown}
        class="flex items-center gap-2.5 px-3 py-2 group rounded-md cursor-grab select-none touch-none"
        classList={{
          'pl-7': props.inGroup,
          'ring-2 ring-chart-1 bg-chart-1/5': selected(),
          // Expanded-in-drawer marker. Distinct from the multi-select ring above so a
          // row that is both selected and expanded still reads as both.
          'bg-sidebar-accent': activeTask() === props.it.task_id,
        }}
        onClick={(e) => {
          // Cmd/Ctrl-click keeps its existing meaning (multi-select for "Create
          // Routine from selection"); a plain click expands the row into the
          // details drawer, which previously did nothing at all.
          if (e.metaKey || e.ctrlKey) { e.stopPropagation(); toggleSelection({ kind: 'flight-plan-task', id: props.it.task_id }); return; }
          setActiveTask(props.it.task_id);
          revealDetails();
        }}
      >
        <button onClick={(e) => { if (e.metaKey || e.ctrlKey) return; toggle(props.it.task_id, !props.it.selected); }} class="checkbox flex-shrink-0" classList={{ 'checkbox-checked': props.it.selected }} title={props.it.selected ? 'Deselect to exclude from Schedule' : 'Include in Schedule'}>
          <Check on={props.it.selected} />
        </button>
        <span class={`priority-dot p${p()} flex-shrink-0`} />
        <span class="flex-1 text-sm text-foreground truncate" classList={{ 'opacity-50': !props.it.selected }}>{props.it.title}</span>
        <Show when={props.it.is_recurring}><Repeat2 size={11} class="text-muted-foreground flex-shrink-0" /></Show>
        <Show when={props.it.estimated_minutes}><span class="text-[11px] font-mono text-muted-foreground flex-shrink-0">{props.it.estimated_minutes}m</span></Show>
        <button onClick={(e) => { e.stopPropagation(); remove(props.it.task_id); }} class="btn-icon opacity-0 group-hover:opacity-100 flex-shrink-0" title="Remove from flight-plan"><X size={13} /></button>
      </li>
    );
  };

  // Group header row. Open/closed state lives in the parent (closedGroups) so the
  // pager can count an expanded group's members as rows; the members render as
  // their own sibling rows (possibly on the next page).
  const FpGroupHeader = (props: { patternId: string; its: FlightPlanItem[]; open: boolean }) => {
    const allSelected = () => props.its.every((i) => i.selected);
    return (
      <li class="flex items-center gap-2.5 px-3 py-2 bg-sidebar-accent/40 group">
        <button onClick={() => toggleMany(props.its, !allSelected())} class="checkbox flex-shrink-0" classList={{ 'checkbox-checked': allSelected() }} title={allSelected() ? 'Deselect all' : 'Select all'}>
          <Check on={allSelected()} />
        </button>
        <button onClick={() => toggleGroup(props.patternId)} class="text-muted-foreground"><Show when={props.open} fallback={<ChevronRight size={13} />}><ChevronDown size={13} /></Show></button>
        <span class="flex-1 text-sm font-medium text-foreground truncate">{patternName().get(props.patternId) ?? 'Pattern'}</span>
        <span class="text-[11px] text-muted-foreground">{props.its.length} task{props.its.length === 1 ? '' : 's'}</span>
        <button onClick={() => removeMany(props.its)} class="btn-icon opacity-0 group-hover:opacity-100 flex-shrink-0" title="Remove group"><X size={13} /></button>
      </li>
    );
  };

  // `<` page x/y `>` — hidden while everything fits on one page.
  const Pager = (props: { slice: PagedSlice<unknown>; onPage: (p: number) => void }) => (
    <Show when={props.slice.showPager}>
      <div class="flex items-center justify-center gap-2 px-3 py-1 border-t border-border text-[11px] text-muted-foreground">
        <button
          onClick={() => props.onPage(props.slice.page - 1)}
          disabled={props.slice.page === 0}
          class="btn-icon disabled:opacity-30"
          title="Previous page"
        ><ChevronLeft size={13} /></button>
        <span>page {props.slice.page + 1}/{props.slice.totalPages}</span>
        <button
          onClick={() => props.onPage(props.slice.page + 1)}
          disabled={props.slice.page >= props.slice.totalPages - 1}
          class="btn-icon disabled:opacity-30"
          title="Next page"
        ><ChevronRight size={13} /></button>
      </div>
    </Show>
  );

  // A saved-blocks row: name / tag / duration / task count, an inline "place at
  // time" flow (defaults to the next quarter-hour on the selected day) + delete.
  const TemplateRow = (props: { t: BlockTemplate }) => {
    const [placing, setPlacing] = createSignal(false);
    const [time, setTime] = createSignal('09:00');
    const beginPlace = () => { setTime(defaultPlaceTimeHHMM(selectedDay())); setPlacing(true); };
    async function place() {
      try {
        await api.blockTemplates.instantiate(props.t.id, localDayTimeToISO(selectedDay(), time()));
        refetchBlocks();
        showToast(`Placed "${props.t.name}" at ${time()}`, 'success');
        setPlacing(false);
      } catch (err) { showToast((err as Error).message, 'error'); }
    }
    async function del() {
      if (!confirm(`Delete the "${props.t.name}" saved block? Its embedded tasks won't come back.`)) return;
      try {
        await api.blockTemplates.delete(props.t.id);
        refetchBlockTemplates();
        showToast(`Removed "${props.t.name}"`, 'default');
      } catch (err) { showToast((err as Error).message, 'error'); }
    }
    return (
      <li class="group">
        <div
          class="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none"
          onClick={() => (placing() ? setPlacing(false) : beginPlace())}
          title="Place this saved block onto the selected day"
        >
          <Star size={12} class="text-primary flex-shrink-0" />
          <span class="flex-1 text-sm text-foreground truncate">{props.t.name}</span>
          {/* AF-11 Slice 5: a saved-block tag can be a multi-name union — one chip per name. */}
          <For each={splitTagNames(props.t.tag)}>{(n) => <span class="text-primary text-xs flex-shrink-0">#{n}</span>}</For>
          <span class="text-[11px] font-mono text-muted-foreground flex-shrink-0">{props.t.default_minutes}m</span>
          <Show when={(props.t.tasks ?? []).length > 0}>
            <span class="text-[11px] text-muted-foreground flex-shrink-0">{(props.t.tasks ?? []).length} task{(props.t.tasks ?? []).length === 1 ? '' : 's'}</span>
          </Show>
          <button onClick={(e) => { e.stopPropagation(); del(); }} class="btn-icon opacity-0 group-hover:opacity-100 flex-shrink-0" title="Delete saved block"><Trash2 size={13} /></button>
        </div>
        <Show when={placing()}>
          <div class="flex items-center gap-2 px-3 pb-2 pl-8">
            <span class="text-[11px] text-muted-foreground">Place on {selectedDay()} at</span>
            <input type="time" step={900} class="input py-0.5 text-sm w-24" value={time()} onInput={(e) => setTime(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && place()} />
            <button onClick={place} class="btn-primary !rounded-full !py-0.5 !px-2.5 text-[11px] flex items-center gap-1" title="Create the block at this time"><CalendarCheck size={12} /> Place</button>
            <button onClick={() => setPlacing(false)} class="btn-icon" title="Cancel"><X size={13} /></button>
          </div>
        </Show>
      </li>
    );
  };

  // Small create form for a new saved block (name + minutes, tag optional).
  const CreateTemplate = () => {
    const [openForm, setOpenForm] = createSignal(false);
    const [name, setName] = createSignal('');
    const [minutes, setMinutes] = createSignal(60);
    const [tag, setTag] = createSignal('');
    async function create() {
      const n = name().trim();
      if (!n) return;
      try {
        // AF-8: upsert by name — a same-named saved block is refreshed, not duplicated.
        const { updated } = await api.blockTemplates.create({
          name: n,
          default_minutes: Math.max(5, Number(minutes()) || 60),
          tag: tag().trim().replace(/^#/, '') || undefined,
          upsert: true,
        });
        refetchBlockTemplates();
        showToast(updated ? `Updated "${n}"` : `Saved "${n}"`, 'success');
        setName(''); setMinutes(60); setTag(''); setOpenForm(false);
      } catch (err) { showToast((err as Error).message, 'error'); }
    }
    return (
      <div class="px-3 py-2 border-t border-border">
        <Show when={openForm()} fallback={
          <button onClick={() => setOpenForm(true)} class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors">
            <Plus size={11} /> New saved block
          </button>
        }>
          <div class="flex items-center gap-2 flex-wrap">
            <input class="input py-1 text-sm flex-1 min-w-28" placeholder="Name" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <input class="input py-1 text-sm w-16" type="number" min={5} step={5} title="Default minutes" value={minutes()} onInput={(e) => setMinutes(Number(e.currentTarget.value))} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <input class="input py-1 text-sm w-24" placeholder="#tag (optional)" value={tag()} onInput={(e) => setTag(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <button onClick={create} disabled={!name().trim()} class="btn-icon hover:text-primary disabled:opacity-30" title="Save"><CheckIcon size={15} /></button>
            <button onClick={() => setOpenForm(false)} class="btn-icon" title="Cancel"><X size={14} /></button>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <div class="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div class="flex items-center gap-2 px-3 py-2" classList={{ 'border-b border-border': !collapsed() }}>
        {/* Collapse toggle + label — takes all available space on the left */}
        <button
          onClick={() => setCollapsed((v) => !v)}
          class="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-primary mr-auto"
          title={collapsed() ? 'Expand flight-plan' : 'Collapse flight-plan'}
        >
          <Show when={collapsed()} fallback={<ChevronDown size={13} />}><ChevronRight size={13} /></Show>
          Flight-plan
          <Show when={items().length > 0}>
            <span class="ml-1 normal-case font-normal tracking-normal text-muted-foreground">· {selectedCount()}/{items().length} included</span>
          </Show>
        </button>

        {/* The action cluster drives the Plan tab; hidden while browsing Saved blocks. */}
        <Show when={tab() === 'plan'}>
          {/* Priority / Due Date / New Today toggle — workday fill ordering. "Due Date"
              is the existing `fill_order='overdue'` (Phase M places soonest-due first);
              "New Today" is `fill_order='new_today'`, which gives the Tasks tab's New
              Today set the earliest slots and orders each half by due date. */}
          <div
            class="inline-flex rounded-full border border-border overflow-hidden text-[11px] flex-shrink-0"
            role="group"
            title="Priority: place highest-priority tasks first. Due Date: place soonest-due tasks first. New Today: give tasks that arrived today the earliest slots."
          >
            <button
              onClick={() => setFillOrder('priority')}
              class="px-2 py-0.5 transition-colors"
              classList={{ 'bg-primary text-primary-foreground': fillOrder() === 'priority', 'text-muted-foreground hover:text-foreground': fillOrder() !== 'priority' }}
            >Priority</button>
            <button
              onClick={() => setFillOrder('overdue')}
              class="px-2 py-0.5 transition-colors"
              classList={{ 'bg-primary text-primary-foreground': fillOrder() === 'overdue', 'text-muted-foreground hover:text-foreground': fillOrder() !== 'overdue' }}
            >Due Date</button>
            <button
              onClick={() => setFillOrder('new_today')}
              class="px-2 py-0.5 transition-colors"
              classList={{ 'bg-primary text-primary-foreground': fillOrder() === 'new_today', 'text-muted-foreground hover:text-foreground': fillOrder() !== 'new_today' }}
            >New Today</button>
          </div>

          {/* T-FP-1: empty → Fill Plan (propose candidates, never places); has items →
              Clear Plan (reset, removes all staged tasks). Same outlined style. */}
          <Show
            when={items().length > 0}
            fallback={
              <button
                onClick={runFill}
                disabled={running()}
                class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors disabled:opacity-40 flex-shrink-0"
                title="Propose open tasks into the flight-plan (never places anything)"
              >
                <Zap size={11} classList={{ 'animate-pulse': running() }} /> Fill Plan
              </button>
            }
          >
            <button
              onClick={reset}
              disabled={running()}
              class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive transition-colors disabled:opacity-40 flex-shrink-0"
              title="Clear all tasks from the flight-plan"
            >
              <Trash2 size={11} /> Clear Plan
            </button>
          </Show>

          {/* Schedule moved to the Planner container header: the grid is what you watch
              placement land on, so the trigger belongs beside it rather than in the
              staging list you dip into. See Planner.tsx's header. */}

          {/* Undo moved to the Planner header with Schedule — an undo that sits a panel
              away from the action it reverses is a trap, not an affordance. */}
        </Show>
      </div>

      <Show when={!collapsed()}>
        {/* Tab bar — Plan (the staging area) | Saved blocks (block_templates) */}
        <div class="flex items-center px-3 py-1.5 border-b border-border">
          <div class="flex rounded-md border border-border overflow-hidden text-[11px]">
            <button
              class={`px-2.5 py-1 ${tab() === 'plan' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab('plan')}
            >Plan</button>
            <button
              class={`px-2.5 py-1 ${tab() === 'saved' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab('saved')}
            >Saved blocks</button>
          </div>
        </div>

        {/* ── Plan tab ── */}
        <Show when={tab() === 'plan'}>
          <div class="px-3 pt-2 pb-1">
            <input
              class="input py-1 text-sm w-full"
              placeholder="Search staged tasks — or the backlog…"
              value={planQuery()}
              onInput={(e) => setPlanQuery(e.currentTarget.value)}
            />
          </div>
          <Show
            when={items().length > 0}
            fallback={
              <div class="px-4 py-6 text-center text-sm text-muted-foreground">
                Flight-plan is empty — add tasks or patterns below,
                or press <span class="text-primary font-medium">Fill Plan</span>.
              </div>
            }
          >
            <Show
              when={planSlice().total > 0}
              fallback={<div class="px-4 py-4 text-center text-sm text-muted-foreground">No staged tasks match "{planQuery().trim()}".</div>}
            >
              <ul class="divide-y divide-border">
                <For each={planSlice().rows}>{(row) =>
                  row.kind === 'group'
                    ? <FpGroupHeader patternId={row.patternId} its={row.items} open={row.open} />
                    : <FpRow it={row.item} inGroup={row.inGroup} />
                }</For>
              </ul>
              <Pager slice={planSlice()} onPage={setPlanPage} />
            </Show>
          </Show>

          {/* Add from backlog — only while searching. One click stages the task. */}
          <Show when={backlogActive()}>
            <div class="border-t border-border">
              <div class="px-3 pt-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Add from backlog</div>
              <Show
                when={backlogMatches().length > 0}
                fallback={<div class="px-3 py-2 text-sm text-muted-foreground">{openTasks.loading ? 'Searching…' : 'No backlog tasks match.'}</div>}
              >
                <ul class="divide-y divide-border">
                  <For each={backlogMatches().slice(0, BACKLOG_CAP)}>{(t) => (
                    <li class="flex items-center gap-2.5 px-3 py-2 group">
                      <span class={`priority-dot p${Math.min(Math.max(t.priority ?? 3, 1), 5)} flex-shrink-0`} />
                      <span class="flex-1 text-sm text-foreground truncate">{t.title}</span>
                      <Show when={t.estimated_minutes}><span class="text-[11px] font-mono text-muted-foreground flex-shrink-0">{t.estimated_minutes}m</span></Show>
                      <button
                        onClick={() => stageFromBacklog(t)}
                        class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors flex-shrink-0"
                        title="Stage this task in the flight-plan"
                      ><Plus size={11} /> Add</button>
                    </li>
                  )}</For>
                </ul>
                <Show when={backlogMatches().length > BACKLOG_CAP}>
                  <div class="px-3 pb-2 text-[11px] text-muted-foreground">…{backlogMatches().length - BACKLOG_CAP} more — refine the search.</div>
                </Show>
              </Show>
            </div>
          </Show>
        </Show>

        {/* ── Saved blocks tab ── */}
        <Show when={tab() === 'saved'}>
          <div class="px-3 pt-2 pb-1">
            <input
              class="input py-1 text-sm w-full"
              placeholder="Search saved blocks…"
              value={savedQuery()}
              onInput={(e) => setSavedQuery(e.currentTarget.value)}
            />
          </div>
          <Show
            when={savedSlice().total > 0}
            fallback={
              <div class="px-4 py-4 text-center text-sm text-muted-foreground">
                {savedQuery().trim()
                  ? `No saved blocks match "${savedQuery().trim()}".`
                  : 'No saved blocks yet — create one below, or save a Time Block as a template from the Planner ★ menu.'}
              </div>
            }
          >
            <ul class="divide-y divide-border">
              <For each={savedSlice().rows}>{(t) => <TemplateRow t={t} />}</For>
            </ul>
            <Pager slice={savedSlice()} onPage={setSavedPage} />
          </Show>
          <CreateTemplate />
        </Show>
      </Show>
    </div>
  );
}
