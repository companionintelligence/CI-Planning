import { For, Show } from 'solid-js';
import { X } from 'lucide-solid';

/**
 * The trust dial (`scheduling_prefs.trust_mode`, 0070) as a pop-up, plus the trigger
 * button that opens it and shows the mode currently in force.
 *
 * This replaces the old Suggest/Schedule segmented toggle in the top bar. That control
 * was a two-state view of a three-state column: it rendered 'cautious' as "Suggest" and
 * could never set it, so a third of the dial was invisible and unreachable from the main
 * UI — and an owner who had picked Cautious in onboarding saw a control claiming they
 * were on Balanced. One button showing the real mode, opening the real three-way choice,
 * is both smaller (the top bar is over-subscribed at 360px — see App.tsx) and honest.
 *
 * Presentational: it owns no state. The caller holds the current mode and persists it.
 */

export type TrustMode = 'cautious' | 'balanced' | 'hands_off';

/**
 * The dial's three positions.
 *
 * Each option states what it does on BOTH axes the dial actually governs, because the
 * two are what distinguish the tiers from each other:
 *   • placement — whether work lands on the calendar without being asked
 *     (`resolveTrustPolicy().autoBlock`, server/src/engine/autoplan.ts);
 *   • ordering  — which inferred bands sort the day
 *     (`orderingBandsFor`, server/src/agents/plan.ts).
 *
 * Deliberately NOT mentioned: promotion. The old copy here promised "high-confidence
 * items auto-promote" for Balanced, which stopped being true when AF-3 retired the
 * auto-promote facet — every possible task now promotes on ingest in every mode.
 *
 * Ordering QUALITY (the deterministic sort vs the LLM generate→judge→revise loop) is a
 * separate preference in Settings and is not implied by any tier here.
 */
export const TRUST_OPTIONS: { value: TrustMode; label: string; hint: string }[] = [
  {
    value: 'cautious',
    label: 'Cautious',
    hint: 'Nothing is scheduled for you. Plain deadline-and-priority order — nothing reshuffled by anything you did not set.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    hint: 'Nothing is scheduled until you ask. Areas you are behind on for the week lead the list.',
  },
  {
    value: 'hands_off',
    label: 'Hands-off',
    hint: 'New work is scheduled as it arrives, a week ahead. Ordering also follows the day’s theme and what you have been working on.',
  },
];

export const trustLabel = (mode: string | null | undefined): string =>
  TRUST_OPTIONS.find((o) => o.value === mode)?.label ?? 'Balanced';

/** The collapsed control: current mode at a glance, opens the modal on click. */
export function TrustTrigger(props: { mode: string | null | undefined; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="inline-flex flex-shrink-0 items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-surface-700/60 text-muted-foreground hover:text-foreground transition-colors"
      aria-haspopup="dialog"
      title={`Automation: ${trustLabel(props.mode)} — click to change how much the planner does on its own`}
    >
      <span
        class="w-1.5 h-1.5 rounded-full flex-shrink-0"
        classList={{
          'bg-primary': props.mode === 'hands_off',
          'bg-muted-foreground': props.mode !== 'hands_off',
        }}
        aria-hidden="true"
      />
      {trustLabel(props.mode)}
    </button>
  );
}

export function TrustModal(props: {
  mode: string | null | undefined;
  busy?: boolean;
  onPick: (mode: TrustMode) => void;
  onClose: () => void;
}) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trust-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}
    >
      <div class="w-full max-w-sm rounded-lg border border-border bg-popover shadow-xl">
        <div class="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="trust-modal-title" class="text-sm font-semibold text-foreground">Automation</h2>
          <button type="button" onClick={props.onClose} class="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div class="p-4 flex flex-col gap-2">
          <p class="text-xs text-muted-foreground -mt-1 mb-1">How much should the planner do on its own?</p>
          <For each={TRUST_OPTIONS}>
            {(opt) => (
              <button
                type="button"
                disabled={props.busy}
                class="btn-ghost text-sm justify-start flex-col items-start gap-0.5 py-2 text-left disabled:opacity-50"
                classList={{ 'bg-primary/10 border-primary': props.mode === opt.value }}
                aria-pressed={props.mode === opt.value}
                onClick={() => props.onPick(opt.value)}
              >
                <span class="text-foreground">{opt.label}</span>
                <span class="text-[11px] text-muted-foreground font-normal whitespace-normal">{opt.hint}</span>
              </button>
            )}
          </For>
          <Show when={props.mode === 'hands_off'}>
            <p class="text-[11px] text-muted-foreground mt-1 pt-2 border-t border-border">
              Hands-off places work without asking. You can still undo anything it does.
            </p>
          </Show>
        </div>
      </div>
    </div>
  );
}
