import { Show, For, createSignal, createResource } from 'solid-js';
import { AlertTriangle, ArrowRight, Lock, Inbox } from 'lucide-solid';
import { api, type ReflowProposal } from '../lib/api.js';
import { selectedDay, dayConflicts, refetchDayConflicts, refetchBlocks, refetchTasks, showToast } from '../stores/index.js';

/**
 * Phase 7 — the day-type conflict banner and its confirmation.
 *
 * Changing a day's type can strand tasks outside their direction's hours. The app
 * never fixes that silently, and never surprises: this is a PERSISTENT banner (not a
 * toast — a toast that vanishes is not an offer), the preview lists every move and
 * every unschedule before anything happens, and cancelling leaves the day untouched
 * with the red treatment still on.
 *
 * The preview is fetched on open, from the same deterministic engine that applies it,
 * so what the dialog promises is what runs.
 */

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function DayReflowBanner() {
  const [open, setOpen] = createSignal(false);
  const [applying, setApplying] = createSignal(false);

  const conflicts = () => dayConflicts() ?? [];
  const count = () => conflicts().length;

  // Only fetched while the dialog is open — the banner itself costs one conflicts read.
  const [proposal, { refetch: refetchProposal }] = createResource(
    () => (open() ? selectedDay() : null),
    (date: string) => api.dayReflow.preview(date),
  );

  async function confirm() {
    if (applying()) return;
    setApplying(true);
    try {
      const res = await api.dayReflow.apply(selectedDay());
      refetchBlocks();
      refetchTasks();
      refetchDayConflicts();
      setOpen(false);
      const bits: string[] = [];
      if (res.moved) bits.push(`moved ${res.moved}`);
      if (res.unscheduled) bits.push(`unscheduled ${res.unscheduled}`);
      showToast(bits.length ? `Reflowed — ${bits.join(', ')}` : 'Nothing to reflow', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setApplying(false);
    }
  }

  const nothingToDo = (p: ReflowProposal) => p.moves.length === 0 && p.unschedule.length === 0;

  return (
    <Show when={count() > 0}>
      <div class="rounded-xl border border-destructive/50 bg-destructive/10 px-3 py-2.5 mb-3 flex items-center gap-3">
        <AlertTriangle size={16} class="text-destructive flex-shrink-0" />
        <span class="text-sm text-foreground flex-1 min-w-0">
          {count()} task{count() === 1 ? '' : 's'} fall{count() === 1 ? 's' : ''} outside this day's windows
        </span>
        <button
          type="button"
          class="btn-ghost text-xs px-2.5 py-1 flex-shrink-0"
          onClick={() => { setOpen(true); refetchProposal(); }}
        >
          Reflow…
        </button>
      </div>

      <Show when={open()}>
        <div
          class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => !applying() && setOpen(false)}
        >
          <div
            class="w-full max-w-lg max-h-[80vh] overflow-auto rounded-xl border border-border bg-card p-4 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm reflow"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="text-base font-semibold text-foreground mb-1">Reflow this day?</h2>
            <p class="text-xs text-muted-foreground mb-3">
              Nothing changes until you confirm.
            </p>

            <Show when={proposal()} fallback={<p class="text-sm text-muted-foreground py-4">Working out what fits…</p>}>
              {(p) => (
                <>
                  <Show when={p().moves.length > 0}>
                    <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      Moving {p().moves.length}
                    </div>
                    <div class="flex flex-col gap-1 mb-3">
                      <For each={p().moves}>
                        {(m) => (
                          <div class="flex items-center gap-2 text-sm px-2 py-1 rounded bg-muted/40">
                            <span class="flex-1 min-w-0 truncate">{m.title}</span>
                            <span class="text-xs font-mono tabular-nums text-muted-foreground flex-shrink-0">
                              {clock(m.from.start_at)}
                            </span>
                            <ArrowRight size={12} class="text-muted-foreground flex-shrink-0" />
                            <span class="text-xs font-mono tabular-nums text-foreground flex-shrink-0">
                              {clock(m.to.start_at)}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={p().unschedule.length > 0}>
                    <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      Back to the flight plan — {p().unschedule.length} won't fit
                    </div>
                    <div class="flex flex-col gap-1 mb-3">
                      <For each={p().unschedule}>
                        {(u) => (
                          <div class="flex items-center gap-2 text-sm px-2 py-1 rounded bg-muted/40">
                            <Inbox size={12} class="text-muted-foreground flex-shrink-0" />
                            <span class="flex-1 min-w-0 truncate">{u.title}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={p().kept_locked.length > 0}>
                    <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      Staying put — you locked {p().kept_locked.length}
                    </div>
                    <div class="flex flex-col gap-1 mb-3">
                      <For each={p().kept_locked}>
                        {(c) => (
                          <div class="flex items-center gap-2 text-sm px-2 py-1 rounded bg-muted/30 opacity-70">
                            <Lock size={12} class="flex-shrink-0" />
                            <span class="flex-1 min-w-0 truncate">{c.title}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={nothingToDo(p())}>
                    <p class="text-sm text-muted-foreground mb-3">
                      Nothing can be moved — every stranded task is locked, so this day stays as it is.
                    </p>
                  </Show>

                  <div class="flex gap-2 justify-end">
                    <button class="btn-ghost text-sm px-3 py-1.5" disabled={applying()} onClick={() => setOpen(false)}>
                      Cancel
                    </button>
                    <button
                      class="btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
                      disabled={applying() || nothingToDo(p())}
                      onClick={() => void confirm()}
                    >
                      {applying() ? 'Reflowing…' : 'Confirm'}
                    </button>
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  );
}
