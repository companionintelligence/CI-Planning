import { createResource, For, Show, onCleanup } from 'solid-js';
import { AlertTriangle } from 'lucide-solid';
import { api } from '../lib/api.js';
import { on } from '../lib/sse.js';
import { refetchBlocks, showToast } from '../stores/index.js';

/**
 * Missed-task review surface (PR-C+, Workstream B). The nightly review marks
 * high-priority tasks whose planned time passed un-started as `status='missed'`
 * (low-priority ones auto-defer silently). This banner lists them on TODAY with
 * +1 / +3 / +7-day reschedule buttons. Hidden when nothing is missed.
 */
export function MissedReview() {
  const [missed, { refetch }] = createResource(() => api.tasks.list({ status: 'missed' }).then((r) => r.tasks));
  const off = on('task:updated', () => refetch());
  onCleanup(off);

  async function reschedule(id: number, title: string, days: number) {
    try {
      await api.tasks.reschedule(id, days);
      refetch();
      refetchBlocks();
      showToast(`"${title}" moved +${days}d`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <Show when={(missed() ?? []).length > 0}>
      <div class="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
        <div class="flex items-center gap-2 mb-2">
          <AlertTriangle size={14} class="text-destructive flex-shrink-0" />
          <span class="text-sm font-semibold text-foreground">
            {missed()!.length} task{missed()!.length === 1 ? '' : 's'} missed — reschedule?
          </span>
        </div>
        <div class="flex flex-col gap-1.5">
          <For each={missed()}>
            {(t) => (
              <div class="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
                <span class="flex-1 text-sm text-foreground truncate">{t.title}</span>
                <Show when={t.tags?.length}><span class="text-primary text-xs">#{t.tags[0]}</span></Show>
                <For each={[1, 3, 7]}>
                  {(d) => (
                    <button onClick={() => reschedule(t.id, t.title, d)} class="btn-secondary text-xs px-2 py-0.5" title={`Reschedule +${d} day${d === 1 ? '' : 's'}`}>
                      +{d}d
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
