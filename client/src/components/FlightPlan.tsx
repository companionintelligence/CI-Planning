import { For, Show, createSignal, createMemo } from 'solid-js';
import { Zap, RotateCcw, X, ChevronDown, ChevronRight, Clock } from 'lucide-solid';
import { api, type FlightPlanItem } from '../lib/api.js';
import {
  flightPlan, refetchFlightPlan, refetchBlocks, patterns, prefs, refetchPrefs, showToast,
} from '../stores/index.js';
import { isSelected, toggleSelection } from '../stores/selection.js';
import { useDraggable } from '../lib/draggable.js';

/**
 * The Flight-plan (Phase G, G5 + G4): the persisted, owner-scoped staging area the
 * two-step Auto runs over, with **Auto Schedule** pinned at its top and a **Reset**.
 *
 * Manual placement (CON-5): each row is a drag source (`kind: 'flight-task'`) — drag
 * one onto the Planner grid to schedule it at that time (the Planner is the drop
 * target). A near-zero move falls through as a normal click (checkbox / multi-select).
 *
 *  - Auto with **nothing selected** → step 1: proposes candidates *into* the
 *    flight-plan and schedules nothing.
 *  - Auto with **selected** items → step 2: places them into the day's free gaps.
 *
 * Toggling an item's checkbox sets `selected`; the × removes it; Reset clears all.
 */
export function FlightPlan() {
  const [running, setRunning] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const items = () => flightPlan() ?? [];
  const selectedCount = () => items().filter((i) => i.selected).length;

  const patternName = createMemo(() => {
    const m = new Map<string, string>();
    for (const p of patterns() ?? []) m.set(p.id, p.name);
    return m;
  });

  // Group staged items by their source pattern — a staged routine/ritual reads as one
  // unit (header + members), not separated rows. Directly-added tasks stay solo.
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

  async function runAuto() {
    setRunning(true);
    try {
      const { result } = await api.auto.run();
      if (result.step === 'fill') {
        showToast(
          result.candidatesAdded
            ? `Proposed ${result.candidatesAdded} candidate${result.candidatesAdded === 1 ? '' : 's'} — select some and run Auto again to schedule`
            : 'No open tasks to propose',
          'default',
        );
      } else {
        const bits = [`Scheduled ${result.placed ?? 0}`];
        if (result.unplaced) bits.push(`${result.unplaced} didn't fit`);
        showToast(bits.join(' · '), 'success');
      }
      refetchFlightPlan();
      refetchBlocks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
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
    try { const r = await api.flightPlan.reset(); refetchFlightPlan(); showToast(`Cleared ${r.cleared}`, 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Fill-work-hours toggle (cockpit-v2 Phase 2): flips the auto_fill_workday pref —
  // Auto's secondary pass that fills the workday with leftover tasks after Plans.
  const fillWorkday = () => prefs()?.auto_fill_workday ?? true;
  async function toggleFill() {
    try { await api.prefs.update({ auto_fill_workday: !fillWorkday() }); refetchPrefs(); }
    catch (err) { showToast((err as Error).message, 'error'); }
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
    // Drag source (CON-5): drop onto the Planner grid to schedule. The shared
    // CLICK_PX threshold lets a clean click still reach the row/checkbox onClick.
    const drag = useDraggable(() => ({ kind: 'flight-task', id: props.it.task_id }));
    return (
      <li
        onPointerDown={drag.onPointerDown}
        class="flex items-center gap-2.5 px-3 py-2 group rounded-md cursor-grab select-none touch-none"
        classList={{ 'pl-7': props.inGroup, 'ring-2 ring-chart-1 bg-chart-1/5': selected() }}
        // Cmd/Ctrl-click anywhere on the row toggles multi-select (Phase F).
        // The Auto-step-2 selection (the checkbox) is a separate axis, intentionally.
        onClick={(e) => { if (e.metaKey || e.ctrlKey) { e.stopPropagation(); toggleSelection({ kind: 'flight-plan-task', id: props.it.task_id }); } }}
      >
        <button onClick={(e) => { if (e.metaKey || e.ctrlKey) return; toggle(props.it.task_id, !props.it.selected); }} class="checkbox flex-shrink-0" classList={{ 'checkbox-checked': props.it.selected }} title={props.it.selected ? 'Deselect' : 'Select for Auto'}>
          <Check on={props.it.selected} />
        </button>
        <span class={`priority-dot p${p()} flex-shrink-0`} />
        <span class="flex-1 text-sm text-foreground truncate" classList={{ 'opacity-50': !props.it.selected }}>{props.it.title}</span>
        <Show when={props.it.estimated_minutes}><span class="text-[11px] font-mono text-muted-foreground flex-shrink-0">{props.it.estimated_minutes}m</span></Show>
        <button onClick={(e) => { e.stopPropagation(); remove(props.it.task_id); }} class="btn-icon opacity-0 group-hover:opacity-100 flex-shrink-0" title="Remove from flight-plan"><X size={13} /></button>
      </li>
    );
  };

  // A staged pattern as one collapsible unit — its members travel together.
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
      {/* Header: collapse toggle · label · Auto Schedule (top) · Reset */}
      <div class="flex items-center gap-2 px-3 py-2" classList={{ 'border-b border-border': !collapsed() }}>
        <button onClick={() => setCollapsed((v) => !v)} class="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-primary mr-auto" title={collapsed() ? 'Expand flight-plan' : 'Collapse flight-plan'}>
          <Show when={collapsed()} fallback={<ChevronDown size={13} />}><ChevronRight size={13} /></Show>
          Flight-plan
          <Show when={items().length > 0}>
            <span class="ml-1 normal-case font-normal tracking-normal text-muted-foreground">· {selectedCount()}/{items().length} selected</span>
          </Show>
        </button>
        <Show when={items().length > 0}>
          <button onClick={reset} class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors" title="Clear the flight-plan">
            <RotateCcw size={12} /> Reset
          </button>
        </Show>
        <button
          onClick={toggleFill}
          class="inline-flex items-center gap-1 text-xs transition-colors"
          classList={{ 'text-primary': fillWorkday(), 'text-muted-foreground hover:text-foreground': !fillWorkday() }}
          title="Fill the workday with leftover tasks after Plans (Auto's secondary pass)"
        >
          <Clock size={12} /> Fill work hours
        </button>
        <button
          onClick={runAuto}
          disabled={running()}
          class="btn-primary !rounded-full !p-2 flex-shrink-0"
          title={selectedCount() > 0 ? `Schedule ${selectedCount()} selected into the day` : 'Propose candidates into the flight-plan'}
        >
          <Zap size={15} classList={{ 'animate-pulse': running() }} />
        </button>
      </div>

      {/* Staged items — hidden when the flight-plan is collapsed */}
      <Show when={!collapsed()}>
      <Show
        when={items().length > 0}
        fallback={
          <div class="px-4 py-6 text-center text-sm text-muted-foreground">
            Flight-plan is empty — add tasks or patterns from the drawer below,
            or hit <span class="text-primary font-medium">Auto · Propose</span>.
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
