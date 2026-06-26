import { For, Show, createSignal, createMemo } from 'solid-js';
import { Zap, CalendarCheck, X, ChevronDown, ChevronRight, Repeat2, Undo2, Trash2 } from 'lucide-solid';
import { api, type FlightPlanItem } from '../lib/api.js';
import {
  flightPlan, refetchFlightPlan, refetchBlocks, prefs, refetchPrefs, showToast, selectedDay,
} from '../stores/index.js';
import { isSelected, toggleSelection } from '../stores/selection.js';
import { useDraggable } from '../lib/draggable.js';

/**
 * The Flight-plan (Phase G, G5 + G4 cockpit-v2 redesign): the persisted staging
 * area with **two explicit buttons** and no hidden-state branching.
 *
 *  - **Fill Flight Plan**: always proposes candidates *into* the flight-plan.
 *    Never places anything on the calendar.
 *  - **Auto Schedule**: always places the selected staged tasks — tag-matched into
 *    Plans, then direction windows, then leftover workday capacity ordered by the
 *    Priority / Over-Due toggle. Never proposes candidates.
 *
 * The Suggest / Schedule toggle has moved to the Day Overview header (Today.tsx).
 * Per-direction fill is configured in Settings → Schedule Patterns.
 * The general workday fallback is configured in Settings → Schedule Patterns →
 * "Fill work hours for undirected tasks".
 *
 * Manual placement (CON-5): each row is a drag source (`kind: 'flight-task'`) —
 * drag one onto the Planner grid to schedule it at that time.
 */
export function FlightPlan() {
  const [running, setRunning] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [canUndo, setCanUndo] = createSignal(false);
  const [undoConfirm, setUndoConfirm] = createSignal(false);
  const items = () => flightPlan() ?? [];
  const selectedCount = () => items().filter((i) => i.selected).length;

  const fillOrder = () => prefs()?.fill_order ?? 'priority';
  async function setFillOrder(o: 'priority' | 'overdue') {
    if (o === fillOrder()) return;
    try { await api.prefs.update({ fill_order: o }); refetchPrefs(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  const patternName = createMemo(() => {
    const m = new Map<string, string>();
    // patterns store is not imported here — patternName falls back to 'Pattern' for groups
    return m;
  });

  const grouped = createMemo(() => {
    const groups = new Map<string, FlightPlanItem[]>();
    const solo: FlightPlanItem[] = [];
    for (const it of items()) {
      if (it.source_pattern_id != null) {
        const arr = groups.get(it.source_pattern_id) ?? [];
        arr.push(it);
        groups.set(it.source_pattern_id, arr);
      } else solo.push(it);
    }
    return { groups: [...groups.entries()], solo };
  });

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
  async function runSchedule() {
    setRunning(true);
    try {
      const { result } = await api.auto.run({ date: selectedDay() });
      const span = (result.days ?? 1) > 1 ? ` across ${result.days} days` : '';
      const bits = [`Scheduled ${result.placed ?? 0}${span}`];
      if (result.unplaced) bits.push(`${result.unplaced} didn't fit`);
      showToast(bits.join(' · '), 'success');
      if ((result.blocksCreated ?? 0) > 0) setCanUndo(true);
      refetchFlightPlan();
      refetchBlocks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  }

  async function undo() {
    try {
      const { result } = await api.auto.undo();
      setCanUndo(false);
      setUndoConfirm(false);
      showToast(result.removed ? `Undid ${result.removed} block${result.removed === 1 ? '' : 's'}` : 'Nothing to undo', 'default');
      refetchFlightPlan();
      refetchBlocks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

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
      setCanUndo(false);
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
        classList={{ 'pl-7': props.inGroup, 'ring-2 ring-chart-1 bg-chart-1/5': selected() }}
        onClick={(e) => { if (e.metaKey || e.ctrlKey) { e.stopPropagation(); toggleSelection({ kind: 'flight-plan-task', id: props.it.task_id }); } }}
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

  const FpGroup = (props: { patternId: string; its: FlightPlanItem[] }) => {
    const [open, setOpen] = createSignal(true);
    const allSelected = () => props.its.every((i) => i.selected);
    return (
      <li class="block">
        <div class="flex items-center gap-2.5 px-3 py-2 bg-sidebar-accent/40 group">
          <button onClick={() => toggleMany(props.its, !allSelected())} class="checkbox flex-shrink-0" classList={{ 'checkbox-checked': allSelected() }} title={allSelected() ? 'Deselect all' : 'Select all'}>
            <Check on={allSelected()} />
          </button>
          <button onClick={() => setOpen((v) => !v)} class="text-muted-foreground"><Show when={open()} fallback={<ChevronRight size={13} />}><ChevronDown size={13} /></Show></button>
          <span class="flex-1 text-sm font-medium text-foreground truncate">{patternName().get(props.patternId) ?? 'Pattern'}</span>
          <span class="text-[11px] text-muted-foreground">{props.its.length} task{props.its.length === 1 ? '' : 's'}</span>
          <button onClick={() => removeMany(props.its)} class="btn-icon opacity-0 group-hover:opacity-100 flex-shrink-0" title="Remove group"><X size={13} /></button>
        </div>
        <Show when={open()}>
          <ul><For each={props.its}>{(it) => <FpRow it={it} inGroup />}</For></ul>
        </Show>
      </li>
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

        {/* Priority / Due Date toggle — workday fill ordering. The "Due Date" value is
            the existing `fill_order='overdue'` (Phase M places soonest-due first). */}
        <div
          class="inline-flex rounded-full border border-border overflow-hidden text-[11px] flex-shrink-0"
          role="group"
          title="Priority: place highest-priority tasks first. Due Date: place soonest-due tasks first."
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

        {/* Schedule — places selected staged items + workday fill */}
        <button
          onClick={runSchedule}
          disabled={running()}
          class="btn-primary !rounded-full !py-0.5 !px-2.5 text-[11px] flex items-center gap-1 flex-shrink-0"
          title={`Place the ${selectedCount()} included task${selectedCount() === 1 ? '' : 's'} into the day`}
        >
          <CalendarCheck size={12} classList={{ 'animate-pulse': running() }} /> Schedule
        </button>

        {/* Undo — topaz outline; appears after Auto Schedule; tap to confirm or dismiss */}
        <Show when={canUndo()}>
          <Show when={undoConfirm()} fallback={
            <button
              onClick={() => setUndoConfirm(true)}
              class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors hover:opacity-80 flex-shrink-0"
              style={{ 'border-color': '#d7a37a', color: '#d7a37a' }}
              title="Undo the last Schedule run"
            >
              <Undo2 size={11} /> Undo
            </button>
          }>
            {/* Confirm prompt */}
            <div class="inline-flex items-center gap-1 flex-shrink-0">
              <span class="text-[11px]" style={{ color: '#d7a37a' }}>Undo?</span>
              <button
                onClick={undo}
                class="text-[11px] px-1.5 py-0.5 rounded border transition-colors hover:opacity-90"
                style={{ 'border-color': '#d7a37a', color: '#d7a37a', background: 'rgba(215,163,122,0.12)' }}
                title="Confirm undo"
              >Yes</button>
              <button
                onClick={() => { setUndoConfirm(false); setCanUndo(false); }}
                class="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                title="Dismiss"
              ><X size={11} /></button>
            </div>
          </Show>
        </Show>
      </div>

      {/* Staged items */}
      <Show when={!collapsed()}>
        <Show
          when={items().length > 0}
          fallback={
            <div class="px-4 py-6 text-center text-sm text-muted-foreground">
              Flight-plan is empty — add tasks or patterns below,
              or press <span class="text-primary font-medium">Fill Plan</span>.
            </div>
          }
        >
          <ul class="divide-y divide-border">
            <For each={grouped().groups}>{([pid, its]) => <FpGroup patternId={pid} its={its} />}</For>
            <For each={grouped().solo}>{(it) => <FpRow it={it} />}</For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}
