import { Show, type JSX } from 'solid-js';
import { formatRemaining, type FocusPhase } from '../lib/focus.js';
import { FOCUS_STYLES, type FocusStyle } from '../lib/focus-appearance.js';

/**
 * Phase Z · Z3b — the Focus Ritual's *visual* layer, split out from the ritual's
 * logic so the two can move independently.
 *
 * `FocusRitual` owns the clock, the cues, and the "what's next" engine calls; this
 * file owns what that state looks like. It renders one of two surfaces — **Breath**
 * (the default) and **Signal** — from the same three numbers, so a style can never
 * drift from the real timing:
 *
 *   `--focus-tint`     the colour the ritual is lit with (a token var, never a literal)
 *   `--focus-elapsed`  0 → 1 across the block          (positional ramps)
 *   `--focus-settle`   0 → 1 across start → the 3-min warning (depletion)
 *
 * Everything visual reads those custom properties in `index.css` (search
 * "FOCUS RITUAL"); nothing here re-derives time. The owner picks the style in
 * Settings → Routine Settings; `lib/focus-appearance.ts` owns that pref.
 *
 * Motion is decorative in every layer: the stage carries `data-motion` and the
 * stylesheet drops all animation under it (and under `prefers-reduced-motion`),
 * leaving the property ramps — which are data, not decoration — still tracking.
 */

export { FOCUS_STYLES, type FocusStyle };

export interface FocusSurfaceProps {
  style: FocusStyle;
  /** The anchor — the task/block name (§1.0). */
  title: string;
  phase: FocusPhase;
  /** 0 → 1 across the whole block. */
  elapsedFrac: number;
  /** 0 → 1 across start → the 3-minute warning. */
  depletionFrac: number;
  remainingMs: number;
  /** CSS colour to light the surface with — always `var(--token)`, never a literal. */
  tint: string;
  /** Z5: the ambient colour layer is per-owner opt-out; false renders the bare surface. */
  ambient?: boolean;
  /** Force the motion opt-out (the Lab's switch; the media query covers real users). */
  reducedMotion?: boolean;
  /** Disclosure row + open panel, placed under the anchor by each layout. */
  details?: JSX.Element;
  /** The "what's next" card, pinned to the bottom of the surface. */
  footer?: JSX.Element;
  /** Absolutely-positioned overlay chrome (the close button). */
  chrome?: JSX.Element;
  /**
   * Extra classes on the stage. It is a *size* container, so the caller MUST give
   * it a definite height (`h-full` inside a fixed parent, `h-[15rem]` for a preview
   * card) — with `container-type: size` an auto height resolves to zero.
   */
  class?: string;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function FocusSurface(props: FocusSurfaceProps) {
  const elapsed = () => clamp01(props.elapsedFrac);
  const settle = () => clamp01(props.depletionFrac);
  const breathing = () => props.phase === 'warning';

  // The depletion ramp: strong at the start, faint by the warning. During the
  // warning the `focus-breath` keyframes own opacity, so it is left unset.
  const washOpacity = () => (breathing() ? undefined : props.phase === 'ended' ? 0.45 : 0.85 - 0.5 * settle());

  return (
    <div
      class={`focus-stage flex flex-col ${props.class ?? ''}`}
      classList={{ 'fx-breath': props.style === 'breath' }}
      data-phase={props.phase}
      data-motion={props.reducedMotion ? 'reduced' : undefined}
      style={{
        '--focus-tint': props.tint,
        '--focus-elapsed': String(elapsed()),
        '--focus-settle': String(settle()),
      }}
    >
      <Show when={props.ambient !== false}>
        {/* Signal is lit from below; Breath keeps a quieter room so the ring leads. */}
        <div
          class="focus-layer focus-wash transition-opacity duration-1000"
          classList={{ 'focus-breath': breathing() && props.style === 'signal' }}
          style={{ opacity: props.style === 'breath' ? 0.4 : washOpacity() }}
        />
      </Show>

      {/* Grain + vignette sit over the ambience in both styles: they are the film
          stock, not the light, and they read even with ambient colour off. */}
      <div class="focus-layer focus-vignette" />
      <div class="focus-layer focus-grain" />

      <Show when={props.style === 'signal'} fallback={<BreathLayout {...props} />}>
        <SignalLayout {...props} />
      </Show>

      {/* The "what's next" card is in flow, not overlaid: on a short screen it has
          to push the readout up rather than sit on top of it. */}
      <Show when={props.footer}>
        <div class="relative z-[3] flex-shrink-0 flex justify-center px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {props.footer}
        </div>
      </Show>
      {props.chrome}
    </div>
  );
}

/** The countdown readout, shared by both layouts (§1.2 — a glance, not a ticker). */
function Clock(props: { ms: number; phase: FocusPhase; class?: string }) {
  return (
    <div class={`focus-clock ${props.class ?? ''}`} data-phase={props.phase} aria-live="off">
      {formatRemaining(props.ms)}
    </div>
  );
}

// ── Layouts ────────────────────────────────────────────────────────────────
// The same three pieces (anchor · details · readout) arranged for each style.
// Both share `focus-rise` so content settles in after the light, never with it.

function SignalLayout(props: FocusSurfaceProps) {
  return (
    <div class="focus-lay relative z-[1] flex-1 min-h-0 flex flex-col items-center justify-center px-6 text-center focus-rise">
      <div class="max-w-2xl w-full flex flex-col items-center gap-4">
        <h1 class="focus-title">{props.title}</h1>
        {props.details}
      </div>
      <div class="flex flex-col items-center gap-5">
        <Clock ms={props.remainingMs} phase={props.phase} />
        {/* The one line of measurable progress — a glance down, then gone again. */}
        <div class="focus-rule"><i /></div>
      </div>
    </div>
  );
}

function BreathLayout(props: FocusSurfaceProps) {
  // pathLength=1 lets the arc be expressed directly as the remaining fraction —
  // no circumference arithmetic, and it stays correct at any viewBox scale.
  const remaining = () => Math.max(0, Math.min(1, 1 - clamp01(props.elapsedFrac)));
  return (
    <div class="focus-lay relative z-[1] flex-1 min-h-0 flex flex-col items-center justify-center px-6 text-center focus-rise">
      {/* The ring leads and the name sits under it: the pacer is the thing to rest
          your eyes on, and a title above it would pull them back up every glance. */}
      <div class="focus-ring-box relative flex items-center justify-center flex-shrink-0">
        {/* The pacer is tinted decoration, so it follows the Z5 ambient-colour pref;
            the ring arc below is the clock and stays whatever the pref says. */}
        <Show when={props.ambient !== false}>
          <div class="fx-halo w-full h-full" />
          <div class="fx-halo w-[76%] h-[76%]" style={{ 'animation-delay': '-1.6s' }} />
          <div class="fx-halo w-[52%] h-[52%]" style={{ 'animation-delay': '-3.2s' }} />
        </Show>
        <svg class="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="fx-ring-track" cx="50" cy="50" r="46" fill="none" stroke-width="0.6" />
          <circle
            class="fx-ring-arc"
            cx="50" cy="50" r="46" fill="none"
            stroke-width="1.2" stroke-linecap="round"
            pathLength="1"
            stroke-dasharray={`${remaining()} 1`}
          />
        </svg>
        <Clock ms={props.remainingMs} phase={props.phase} class="focus-clock--ring relative" />
      </div>

      <div class="max-w-md w-full flex flex-col items-center gap-3">
        <h1 class="focus-title focus-title--quiet">{props.title}</h1>
        {props.details}
      </div>
    </div>
  );
}
