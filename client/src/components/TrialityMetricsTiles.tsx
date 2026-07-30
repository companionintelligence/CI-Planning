import { createResource, For, Show } from 'solid-js';
import {
  api,
  type TrialityMetrics,
  type TrialityCalibration,
  type TrialityCalibrationBand,
  type TrialityConfidenceBand,
  type TrialitySlot,
} from '../lib/api.js';
import { prefs, showToast } from '../stores/index.js';

/**
 * Triality measurement tiles (design §9.2) — Balance → Metrics stays the
 * measurement surface: acceptance per slot, Novel uptake trend, confidence
 * calibration, deficit response, learned weights. NO suggestion chips here
 * (Focus owns those).
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

// ── Confidence calibration (v2.2 §4) ─────────────────────────────────────────

/** Server render order, and the order its verdict scans ADJACENT pairs in. */
const BANDS = ['firm', 'tentative', 'guess'] as const;
const BAND_LABEL = { firm: 'FIRM', tentative: 'TENTATIVE', guess: 'GUESS' } as const;
/** The ONE slot order in this file — the acceptance grid renders it and `modalSlot`
 *  breaks ties by it. A second copy would let the tiles and the confound note disagree
 *  about which slot "first" means. */
const SLOT_ORDER = ['habitual', 'contextual', 'novel'] as const;

/** A band with nothing decided prints an em dash inside a sentence, the same way its row
 *  does — the honest-zero rule does not relax because the number is mid-paragraph. */
const pctOrDash = (v: number | null) => pct(v) ?? '—';

const statsFor = (c: TrialityCalibration, b: TrialityConfidenceBand) => c.bands.find((x) => x.band === b);
const shownOf = (c: TrialityCalibration, b: TrialityConfidenceBand) => statsFor(c, b)?.shown ?? 0;
const rateOf = (c: TrialityCalibration, b: TrialityConfidenceBand) => statsFor(c, b)?.rate ?? null;

/** First-wins on a tie — the SAME reduction the server used to set `confounded`, so the
 *  flag and the sentence explaining it can never name different slots. */
const modalSlot = (b: TrialityCalibrationBand | undefined): TrialitySlot =>
  b ? SLOT_ORDER.reduce((best, s) => (b.slotMix[s] > b.slotMix[best] ? s : best), SLOT_ORDER[0]) : SLOT_ORDER[0];

/**
 * The verdict, in words. `inverted` is stated flatly — no "may indicate", no softening:
 * a band ordering that runs backwards is the outcome this whole wave was built to be able
 * to report, and it is a hard block on ever gating a slot on confidence.
 *
 * The verdict itself is NEVER recomputed here. `floor` and `minGap` ride on the wire only
 * so the inverted sentence can name the adjacent pair the server's scan objected to,
 * pointing the owner at two rows they can see rather than at an abstraction.
 */
function verdictLine(c: TrialityCalibration): string {
  const present = BANDS.filter((b) => shownOf(c, b) >= c.floor);
  // The second clause is defensive: a payload whose verdict claims a comparison its own
  // counts cannot support is reported as "not enough", never as a fabricated pair.
  if (c.verdict === 'insufficient' || present.length < 2) {
    return `Not enough decided suggestions to compare bands yet — ${c.floor} needed in at least two bands.`;
  }
  const [f, t, g] = BANDS.map((b) => pctOrDash(rateOf(c, b)));
  if (c.verdict === 'ordered') {
    return `Firm picks taken ${f} · tentative ${t} · guess ${g} — the bands are ordering outcomes correctly.`;
  }
  if (c.verdict === 'flat') {
    return `Firm, tentative and guess picks are taken at about the same rate (${f} · ${t} · ${g}). Confidence isn't telling you anything yet.`;
  }
  // Initialised to the extremes so an `inverted` verdict always renders a sentence: that
  // only shows when a payload's verdict and its own rates disagree, and silently printing
  // nothing would hide the one result this tile exists to report.
  let higher = present[0];
  let lower = present[present.length - 1];
  for (let i = 1; i < present.length; i++) {
    const hi = rateOf(c, present[i - 1]);
    const lo = rateOf(c, present[i]);
    if (hi != null && lo != null && lo - hi >= c.minGap) {
      higher = present[i - 1];
      lower = present[i];
      break;
    }
  }
  return (
    `${lower} picks are taken MORE often than ${higher} ones ` +
    `(${pctOrDash(rateOf(c, lower))} vs ${pctOrDash(rateOf(c, higher))}). ` +
    'The confidence model is wrong — treat the bands as decoration until this flips.'
  );
}

/** Appended to `ordered`, `flat` and `inverted` alike: `firm` runs Habitual-heavy and
 *  `guess` Novel-heavy BY CONSTRUCTION, so the ordering may be the slot difference the
 *  acceptance tiles above already show. Says "may be", never "because" — the
 *  deficit-response humility rule. */
function confoundNote(c: TrialityCalibration): string {
  const present = BANDS.filter((b) => shownOf(c, b) >= c.floor);
  if (!c.confounded || present.length < 2) return '';
  const top = present[0];
  const bottom = present[present.length - 1];
  return (
    ` Most ${top} picks are ${modalSlot(statsFor(c, top))} and most ${bottom} picks are ` +
    `${modalSlot(statsFor(c, bottom))}, so this may be the slot difference the tiles above already show, ` +
    'not confidence working.'
  );
}

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
  // `null` (nothing in the window carries a confidence) and absent (a response predating
  // the field) render the same "not measured yet" state — the owner cannot act on the
  // difference, and inventing a third string would imply they could.
  const cal = () => m()?.calibration ?? null;

  return (
    <Show when={enabled() && m()}>
      <div class="mt-4" data-testid="triality-metrics">
        <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground mb-2">
          Suggestions · last {m()!.windowDays} days
        </div>

        {/* Acceptance per slot — pending rows are disclosed, not hidden. */}
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <For each={SLOT_ORDER}>
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

        {/* Confidence calibration (v2.2 §4) — the ONE tile whose purpose is to falsify
            the confidence model rather than display it. Sits under the acceptance
            reading, so the confound note's "the tiles above" is something the owner has
            just looked at. An inverted ordering is stated flatly and is a hard block on
            ever gating a slot on a band. */}
        <div class="mt-3 rounded-lg bg-muted/30 px-3 py-2" data-testid="triality-calibration">
          <div class="text-[9px] tracking-[0.1em] text-muted-foreground mb-1">CONFIDENCE CALIBRATION</div>
          <Show
            when={cal()}
            fallback={
              <div class="text-[11px] text-muted-foreground italic">
                Confidence isn't measured yet — these suggestions were shown before confidence scoring.
              </div>
            }
          >
            {/* Decided counts first: every rate below is read against these, and the two
                exclusions are disclosed rather than folded in — a pre-v2.2 row and a row
                from an older model are not this model's evidence. */}
            <div class="text-[10px] text-muted-foreground" data-testid="triality-calibration-counts">
              firm {shownOf(cal()!, 'firm')} · tentative {shownOf(cal()!, 'tentative')} · guess {shownOf(cal()!, 'guess')} decided
              <Show when={cal()!.unbanded > 0}> · {cal()!.unbanded} shown before confidence scoring, not counted</Show>
              <Show when={cal()!.otherModel > 0}> · {cal()!.otherModel} scored by an earlier confidence model, not counted</Show>
            </div>
            <For each={cal()!.bands}>
              {(b) => (
                <div class="text-[11px] mt-0.5 flex items-baseline gap-2">
                  <span class="w-[68px] shrink-0 text-[9px] tracking-[0.1em] text-muted-foreground">{BAND_LABEL[b.band]}</span>
                  <Show
                    when={b.rate != null}
                    fallback={
                      <>
                        <span class="text-muted-foreground">—</span>
                        <span class="text-muted-foreground italic">
                          no {b.band} suggestions decided yet<Show when={b.pending > 0}> · {b.pending} pending</Show>
                        </span>
                      </>
                    }
                  >
                    <span class="text-foreground font-medium">{pct(b.rate)}</span>
                    <span class="text-muted-foreground">
                      {b.taken} of {b.shown} decided<Show when={b.pending > 0}> · {b.pending} pending</Show>
                    </span>
                  </Show>
                </div>
              )}
            </For>
            <div class="text-[10px] text-muted-foreground italic mt-1" data-testid="triality-calibration-verdict">
              {verdictLine(cal()!)}{confoundNote(cal()!)}
            </div>
          </Show>
        </div>

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
