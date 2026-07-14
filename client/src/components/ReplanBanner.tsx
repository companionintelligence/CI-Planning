import { Show, onMount } from 'solid-js';
import { Sparkles } from 'lucide-solid';
import { api } from '../lib/api.js';
import { replanSuggestion, setReplanSuggestion, showToast, refetchBlocks, aiAvailable } from '../stores/index.js';

/**
 * Phase M B4 — the reactive-reflow escalation banner (MissedReview-style, but a
 * suggestion not an alarm). A big-disruption reflow surfaces an outstanding
 * suggestion (the `replanSuggestion` signal, set by the 'replan:suggested' SSE
 * event). "Re-plan" runs the AI re-author (the only reactive LLM path); "Dismiss"
 * suppresses it until the next big disruption. Survives reload only as long as the
 * SSE event re-arrives — the server holds the outstanding state in memory.
 */
export function ReplanBanner() {
  // Reload-durable: the 'replan:suggested' SSE event fires once and isn't replayed on
  // reconnect, so hydrate from the server's in-memory outstanding state on mount.
  // Don't clobber a fresher live signal (an event that arrived before this resolved).
  onMount(() => {
    void api.plan
      .suggestion()
      .then((r) => { if (r.suggestion && !replanSuggestion()) setReplanSuggestion(r.suggestion); })
      .catch(() => {});
  });

  async function reauthor() {
    const s = replanSuggestion();
    if (!s) return;
    setReplanSuggestion(null); // optimistic — the server clears its copy too
    try {
      await api.plan.reauthor(s.date);
      refetchBlocks();
      // The server broadcasts schedule:done → the B3 toast reports "Re-planned: N moved".
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function dismiss() {
    const s = replanSuggestion();
    setReplanSuggestion(null);
    try { if (s) await api.plan.dismiss(s.date); } catch { /* best-effort */ }
  }

  return (
    <Show when={aiAvailable() && replanSuggestion()}>
      {(s) => (
        <div class="rounded-xl border border-primary/40 bg-primary/5 p-3">
          <div class="flex items-center gap-2">
            <Sparkles size={14} class="text-primary flex-shrink-0" />
            <span class="flex-1 text-sm text-foreground">
              {s().summary ?? 'Your day got crowded'} — re-plan with AI?
            </span>
            <button type="button" onClick={reauthor} class="btn-primary text-xs px-2.5 py-1">Re-plan</button>
            <button type="button" onClick={dismiss} class="btn-secondary text-xs px-2.5 py-1">Dismiss</button>
          </div>
        </div>
      )}
    </Show>
  );
}
