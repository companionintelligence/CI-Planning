import { For, Show, createSignal, createMemo } from 'solid-js';
import { Zap, RotateCcw, X } from 'lucide-solid';
import { api } from '../lib/api.js';
import {
  flightPlan, refetchFlightPlan, refetchBlocks, patterns, showToast,
} from '../stores/index.js';

/**
 * The Flight-plan (Phase G, G5 + G4): the persisted, owner-scoped staging area the
 * two-step Auto runs over, with **Auto Schedule** pinned at its top and a **Reset**.
 *
 *  - Auto with **nothing selected** → step 1: proposes candidates *into* the
 *    flight-plan and schedules nothing.
 *  - Auto with **selected** items → step 2: places them into the day's free gaps.
 *
 * Toggling an item's checkbox sets `selected`; the × removes it; Reset clears all.
 */
export function FlightPlan() {
  const [running, setRunning] = createSignal(false);
  const items = () => flightPlan() ?? [];
  const selectedCount = () => items().filter((i) => i.selected).length;

  const patternName = createMemo(() => {
    const m = new Map<number, string>();
    for (const p of patterns() ?? []) m.set(p.id, p.name);
    return m;
  });

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

  async function toggle(taskId: number, selected: boolean) {
    try { await api.flightPlan.update(taskId, { selected }); refetchFlightPlan(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function remove(taskId: number) {
    try { await api.flightPlan.remove(taskId); refetchFlightPlan(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function reset() {
    try { const r = await api.flightPlan.reset(); refetchFlightPlan(); showToast(`Cleared ${r.cleared}`, 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header: label · Auto Schedule (top) · Reset */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary mr-auto">
          Flight-plan
          <Show when={items().length > 0}>
            <span class="ml-1.5 text-muted-foreground">· {selectedCount()}/{items().length} selected</span>
          </Show>
        </span>
        <Show when={items().length > 0}>
          <button onClick={reset} class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors" title="Clear the flight-plan">
            <RotateCcw size={12} /> Reset
          </button>
        </Show>
        <button onClick={runAuto} disabled={running()} class="btn-primary text-xs px-3 py-1.5"
          title={selectedCount() > 0 ? 'Place the selected items into the day' : 'Propose candidates into the flight-plan'}>
          <Zap size={13} />
          {running() ? 'Running…' : selectedCount() > 0 ? `Auto Schedule (${selectedCount()})` : 'Auto · Propose'}
        </button>
      </div>

      {/* Staged items */}
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
          <For each={items()}>
            {(it) => {
              const p = () => Math.min(Math.max(it.priority ?? 3, 1), 5);
              return (
                <li class="flex items-center gap-2.5 px-3 py-2 group">
                  <button
                    onClick={() => toggle(it.task_id, !it.selected)}
                    class="checkbox flex-shrink-0"
                    classList={{ 'checkbox-checked': it.selected }}
                    title={it.selected ? 'Deselect' : 'Select for Auto'}
                  >
                    <Show when={it.selected}>
                      <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
                        <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </Show>
                  </button>
                  <span class={`priority-dot p${p()} flex-shrink-0`} />
                  <span class="flex-1 text-sm text-foreground truncate" classList={{ 'opacity-50': !it.selected }}>
                    {it.title}
                  </span>
                  <Show when={it.source_pattern_id != null && patternName().get(it.source_pattern_id)}>
                    {(name) => <span class="badge-neutral text-[10px] flex-shrink-0">{name()}</span>}
                  </Show>
                  <Show when={it.estimated_minutes}>
                    <span class="text-[11px] font-mono text-muted-foreground flex-shrink-0">{it.estimated_minutes}m</span>
                  </Show>
                  <button onClick={() => remove(it.task_id)} class="btn-icon opacity-0 group-hover:opacity-100 flex-shrink-0" title="Remove from flight-plan">
                    <X size={13} />
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}
