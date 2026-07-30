import { createResource, For, Show } from 'solid-js';
import { api, type TrialityMetrics } from '../lib/api.js';
import { prefs, showToast } from '../stores/index.js';

/**
 * Triality measurement tiles (design §9.2) — Balance → Metrics stays the
 * measurement surface: acceptance per slot, Novel uptake trend, deficit
 * response, learned weights. NO suggestion chips here (Focus owns those).
 *
 * Honest-zero rules mirror the server's: a null rate renders "no suggestions
 * decided yet", never 0%; a null weights block renders "learning not started";
 * deficit deltas say "moved with", never "because". The reset button exists only
 * once weights exist — no dead buttons.
 *
 * WORDING CONSTRAINT (why this is not just copy): the reset DELETES the weights
 * rows and nothing else. The §6b log it was derived from is untouched, so the
 * weekly `calibrate_triality` pass re-derives byte-identical weights on its next
 * run. "Reset learning" therefore promised a permanence the endpoint cannot
 * deliver; the label and its hint say what actually happens instead.
 */

const SLOT_LABEL = { habitual: 'HABITUAL', contextual: 'CONTEXTUAL', novel: 'NOVEL' } as const;
const pct = (v: number | null) => (v == null ? null : `${Math.round(v * 100)}%`);

export function TrialityMetricsTiles(props: { days: number }) {
  const enabled = () => !!prefs()?.triality_enabled;
  const [metrics, { refetch }] = createResource(
    () => (enabled() ? props.days : null),
    (d) => api.metrics.triality(d).catch(() => null),
  );

  async function resetLearning() {
    try {
      await api.triality.resetWeights();
      showToast('Weights cleared — defaults until the next weekly pass', 'success');
      void refetch();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  const m = () => metrics() as TrialityMetrics | null | undefined;

  return (
    <Show when={enabled() && m()}>
      <div class="mt-4" data-testid="triality-metrics">
        <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground mb-2">
          Suggestions · last {m()!.windowDays} days
        </div>

        {/* Acceptance per slot — pending rows are disclosed, not hidden. */}
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <For each={(['habitual', 'contextual', 'novel'] as const)}>
            {(slot) => {
              const a = () => m()!.acceptance[slot];
              return (
                <div class="rounded-lg bg-muted/30 px-3 py-2">
                  <div class="text-[9px] tracking-[0.1em] text-muted-foreground">TAKEN · {SLOT_LABEL[slot]}</div>
                  <Show
                    when={a().rate != null}
                    fallback={<div class="text-xs text-muted-foreground italic mt-1">no suggestions decided yet</div>}
                  >
                    <div class="text-lg font-semibold text-foreground">{pct(a().rate)}</div>
                    <div class="text-[10px] text-muted-foreground">
                      {a().taken} of {a().shown} shown
                      <Show when={a().pending > 0}> · {a().pending} pending</Show>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        {/* Novel trend — is feasible novelty actually taken? */}
        <Show when={m()!.novelTrend.current != null && m()!.novelTrend.prior != null}>
          <div class="text-[10px] text-muted-foreground mt-2" data-testid="novel-trend">
            Novel uptake {pct(m()!.novelTrend.current)} vs {pct(m()!.novelTrend.prior)} the prior {m()!.windowDays} days.
          </div>
        </Show>

        {/* Deficit response — correlation surfaced honestly. */}
        <Show when={m()!.deficitResponse.some((d) => d.takenPicks > 0)}>
          <div class="mt-3 rounded-lg bg-muted/30 px-3 py-2">
            <div class="text-[9px] tracking-[0.1em] text-muted-foreground mb-1">DEFICIT RESPONSE</div>
            <For each={m()!.deficitResponse.filter((d) => d.takenPicks > 0)}>
              {(d) => (
                <div class="text-[11px] text-muted-foreground capitalize">
                  {d.category}:
                  <Show
                    when={d.currentShare != null && d.priorShare != null}
                    fallback={<span> {d.takenPicks} taken pick{d.takenPicks === 1 ? '' : 's'} — not enough timed minutes to compare yet</span>}
                  >
                    <span class="text-foreground"> {pct(d.currentShare)} of timed minutes</span> (was {pct(d.priorShare)}) — moved with {d.takenPicks} taken pick{d.takenPicks === 1 ? '' : 's'}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Learned weights — visible, resettable, never hand-editable. */}
        <div class="mt-3 rounded-lg bg-muted/30 px-3 py-2">
          <div class="flex items-center justify-between">
            <span class="text-[9px] tracking-[0.1em] text-muted-foreground">LEARNED WEIGHTS</span>
            <Show when={m()!.weights}>
              <button class="text-[10px] text-accent hover:underline" onClick={() => void resetLearning()}>
                Recompute from scratch
              </button>
            </Show>
          </div>
          <Show
            when={m()!.weights}
            fallback={<div class="text-[11px] text-muted-foreground italic mt-1">learning not started — picks use the default weights</div>}
          >
            <For each={m()!.weights!}>
              {(w) => (
                <div class="text-[11px] text-muted-foreground mt-0.5">
                  <span class="uppercase text-[9px] tracking-[0.1em]">{w.slot}</span> ({w.sampleCount} outcomes):{' '}
                  {Object.entries(w.weights).map(([k, v]) => `${k} ${v}`).join(' · ')}
                </div>
              )}
            </For>
            {/* The reset clears the weights, not the evidence — say so. */}
            <div class="text-[10px] text-muted-foreground italic mt-1" data-testid="triality-reset-hint">
              Recomputing drops these weights back to the defaults. Your feedback log is kept, so the next weekly
              pass learns from it again.
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
