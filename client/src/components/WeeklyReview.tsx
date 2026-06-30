import { Show, For } from 'solid-js';
import { CheckCircle2, AlertTriangle, CalendarRange, Target, Check, TrendingUp } from 'lucide-solid';
import type { WeekReview, Calibration } from '../lib/api.js';

/**
 * Phase N3/N4 — Weekly Review panel.
 * Rendered inside the Calendar week view when the "Review" toggle is active.
 * Shows the week's completed/overdue counts, block density, weekly goals,
 * objectives rot count, and the estimate calibration insight (N4).
 */
export function WeeklyReview(props: { data: WeekReview | undefined; calibration?: Calibration | undefined }) {
  const d = () => props.data;

  const weekLabel = () => {
    const data = d();
    if (!data?.days?.length) return '';
    const first = new Date(data.days[0] + 'T12:00:00Z');
    const last = new Date(data.days[6] + 'T12:00:00Z');
    const a = first.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const b = last.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${a} – ${b}`;
  };

  const completionRate = () => {
    const data = d();
    if (!data) return null;
    const total = data.tasks_completed + data.tasks_overdue;
    if (total === 0) return null;
    return Math.round((data.tasks_completed / total) * 100);
  };

  const goalsCompleted = () => d()?.weekly_goals.filter((g) => g.done_at != null).length ?? 0;
  const goalsTotal = () => d()?.weekly_goals.length ?? 0;

  return (
    <Show when={d()}>
      {(data) => (
        <div class="rounded-xl border border-border bg-card p-4 mb-4">
          {/* Header */}
          <div class="flex items-center justify-between mb-4">
            <div>
              <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary mb-0.5">
                Weekly Review
              </div>
              <span class="text-xs text-muted-foreground">{weekLabel()}</span>
            </div>
            <span class="text-xs text-muted-foreground font-mono">{data().week_key}</span>
          </div>

          {/* Stats row */}
          <div class="grid grid-cols-3 gap-3 mb-4">
            {/* Completed tasks */}
            <div class="rounded-lg border border-border bg-background/40 p-3 text-center">
              <div class="flex items-center justify-center gap-1 mb-1">
                <CheckCircle2 size={14} class="text-primary" />
                <span class="text-xs text-muted-foreground">Done</span>
              </div>
              <div class="text-xl font-semibold text-foreground">{data().tasks_completed}</div>
              <Show when={completionRate() != null}>
                <div class="text-[10px] text-muted-foreground mt-0.5">{completionRate()}% rate</div>
              </Show>
            </div>

            {/* Overdue */}
            <div class="rounded-lg border border-border bg-background/40 p-3 text-center"
                 classList={{ 'border-amber-500/40 bg-amber-500/5': data().tasks_overdue > 0 }}>
              <div class="flex items-center justify-center gap-1 mb-1">
                <AlertTriangle size={14} classList={{ 'text-amber-400': data().tasks_overdue > 0, 'text-muted-foreground': data().tasks_overdue === 0 }} />
                <span class="text-xs text-muted-foreground">Still open</span>
              </div>
              <div class="text-xl font-semibold"
                   classList={{ 'text-amber-400': data().tasks_overdue > 0, 'text-foreground': data().tasks_overdue === 0 }}>
                {data().tasks_overdue}
              </div>
              <div class="text-[10px] text-muted-foreground mt-0.5">due this week</div>
            </div>

            {/* Time blocks */}
            <div class="rounded-lg border border-border bg-background/40 p-3 text-center">
              <div class="flex items-center justify-center gap-1 mb-1">
                <CalendarRange size={14} class="text-muted-foreground" />
                <span class="text-xs text-muted-foreground">Blocks</span>
              </div>
              <div class="text-xl font-semibold text-foreground">{data().blocks_count}</div>
              <div class="text-[10px] text-muted-foreground mt-0.5">scheduled</div>
            </div>
          </div>

          {/* Weekly goals */}
          <Show when={goalsTotal() > 0}>
            <div class="border-t border-border/50 pt-3 mb-3">
              <div class="flex items-center justify-between mb-2">
                <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Weekly Intentions</span>
                <span class="text-[10px] text-muted-foreground">{goalsCompleted()}/{goalsTotal()} done</span>
              </div>
              <ul class="flex flex-col gap-1.5">
                <For each={data().weekly_goals}>
                  {(g) => (
                    <li class="flex items-start gap-2 text-sm">
                      <Show
                        when={g.done_at}
                        fallback={<span class="w-4 h-4 rounded-full border border-border flex-shrink-0 mt-0.5" />}
                      >
                        <span class="w-4 h-4 rounded-full bg-primary flex-shrink-0 mt-0.5 flex items-center justify-center">
                          <Check size={9} class="text-primary-foreground" />
                        </span>
                      </Show>
                      <span class="text-foreground" classList={{ 'line-through text-muted-foreground': !!g.done_at }}>
                        {g.body}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          {/* Objectives health */}
          <Show when={data().objectives_rotting > 0}>
            <div class="border-t border-border/50 pt-3 flex items-center gap-2 text-sm text-amber-400">
              <Target size={14} class="flex-shrink-0" />
              <span>
                {data().objectives_rotting} objective{data().objectives_rotting === 1 ? '' : 's'} need{data().objectives_rotting === 1 ? 's' : ''} a next action
              </span>
            </div>
          </Show>

          <Show when={goalsTotal() === 0 && data().objectives_rotting === 0 && data().tasks_completed === 0 && data().tasks_overdue === 0}>
            <div class="text-center text-sm text-muted-foreground py-2">
              No activity recorded for this week yet.
            </div>
          </Show>

          {/* N4 — Estimate calibration insight */}
          <Show when={props.calibration?.calibrated}>
            {(_) => {
              const cal = props.calibration as Extract<Calibration, { calibrated: true }>;
              const pct = Math.round(Math.abs(cal.bias_ratio - 1) * 100);
              const over = cal.bias_ratio > 1.1;
              const under = cal.bias_ratio < 0.9;
              return (
                <div class="border-t border-border/50 pt-3 flex items-start gap-2 text-sm"
                     classList={{ 'text-amber-400': over, 'text-primary': under, 'text-muted-foreground': !over && !under }}>
                  <TrendingUp size={14} class="flex-shrink-0 mt-0.5" />
                  <div class="min-w-0">
                    <span class="block">{cal.label}</span>
                    <span class="text-[10px] text-muted-foreground">
                      Based on {cal.sample_count} timed task{cal.sample_count === 1 ? '' : 's'}
                      <Show when={pct > 0}> · spread {Math.round((cal.p75 - cal.p25) * 100)}%</Show>
                    </span>
                  </div>
                </div>
              );
            }}
          </Show>
        </div>
      )}
    </Show>
  );
}
