import { Show, For, createSignal } from 'solid-js';
import { RefreshCw, Zap, ArrowRight, Cpu } from 'lucide-solid';
import type { DaySummary } from '../lib/api.js';
import { api } from '../lib/api.js';
import { showToast } from '../stores/index.js';

/**
 * Phase N3 — Morning Briefing panel in the Today cockpit.
 * Shows the AI-generated (or deterministic) prose briefing, up to 3 focus items,
 * and a capacity bar (scheduled time vs workday budget).
 */
export function MorningBriefing(props: {
  date: string;
  summary: DaySummary | undefined;
  onRefresh: (updated: DaySummary) => void;
}) {
  const [refreshing, setRefreshing] = createSignal(false);

  async function refresh() {
    setRefreshing(true);
    try {
      const updated = await api.summary.refresh(props.date);
      props.onRefresh(updated);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  }

  const capacity = () => props.summary?.capacity;

  const capacityPct = () => {
    const c = capacity();
    if (!c || c.workday_minutes === 0) return 0;
    return Math.min(100, Math.round((c.scheduled_minutes / c.workday_minutes) * 100));
  };

  const capacityLabel = () => {
    const c = capacity();
    if (!c) return '';
    return `${c.scheduled_minutes}m scheduled / ${c.workday_minutes}m workday`;
  };

  const capacityTone = () => {
    const pct = capacityPct();
    if (pct >= 90) return 'text-destructive';
    if (pct >= 70) return 'text-amber-400';
    return 'text-primary';
  };

  return (
    <Show when={props.summary}>
      {(s) => (
        <div class="rounded-xl border border-border bg-card p-4">
          {/* Header */}
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">
              <Cpu size={11} />
              Morning Briefing
              <Show when={s().llm}>
                <span class="normal-case text-[10px] text-muted-foreground font-normal tracking-normal ml-0.5">(AI)</span>
              </Show>
            </div>
            <button
              class="btn-icon opacity-50 hover:opacity-100"
              onClick={refresh}
              disabled={refreshing()}
              title="Regenerate briefing"
            >
              <RefreshCw size={13} classList={{ 'animate-spin': refreshing() }} />
            </button>
          </div>

          {/* Prose */}
          <p class="text-sm text-muted-foreground leading-relaxed mb-3 whitespace-pre-line">
            {s().prose}
          </p>

          {/* Capacity bar */}
          <Show when={capacity() && capacity()!.workday_minutes > 0}>
            <div class="mb-3">
              <div class="flex items-center justify-between mb-1">
                <span class="text-[10px] text-muted-foreground">Capacity</span>
                <span class={`text-[10px] tabular-nums ${capacityTone()}`}>
                  {capacityLabel()}
                </span>
              </div>
              <div class="relative h-1.5 rounded-full bg-background border border-border overflow-hidden">
                <div
                  class="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
                  classList={{ 'bg-amber-400': capacityPct() >= 70, 'bg-destructive': capacityPct() >= 90 }}
                  style={{ width: `${capacityPct()}%` }}
                />
              </div>
            </div>
          </Show>

          {/* Focus items */}
          <Show when={s().focus.length > 0}>
            <div class="border-t border-border/50 pt-3">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
                <Zap size={10} />
                Focus
              </div>
              <ul class="flex flex-col gap-1.5">
                <For each={s().focus}>
                  {(item) => (
                    <li class="flex items-start gap-2 text-sm">
                      <ArrowRight size={13} class="text-primary flex-shrink-0 mt-0.5" />
                      <div class="min-w-0">
                        <span class="text-foreground font-medium truncate block">{item.title}</span>
                        <span class="text-[11px] text-muted-foreground">{item.reason}</span>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
