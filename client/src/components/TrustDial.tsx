import { For, Show } from 'solid-js';
import { api, type TrustMode } from '../lib/api.js';
import { TRUST_OPTIONS, TRUST_TITLE, resolveTrustValue, blurbFor } from '../lib/trust.js';
import { prefs, refetchPrefs, showToast } from '../stores/index.js';

/**
 * The automation **trust dial** (FTUE gaps 5 & 6) — a Setting, not a glossary noun.
 * One control over two levers: how aggressively the Inbox auto-promotes, and whether
 * promoted (estimate-bearing) Tasks auto-block onto the day. Server maps each state via
 * resolveTrustPolicy(); placement itself stays deterministic.
 *
 *   Cautious  — nothing auto-promotes; nothing auto-blocks (review everything).
 *   Balanced  — high-confidence Inbox items auto-promote; you place them (the default).
 *   Hands-off — auto-promote AND auto-block tasks that carry an estimate (fewest clicks).
 *
 * Self-contained: it reads the current value from `prefs` and writes via api.prefs.update.
 * The pure model (options, default, blurbs) lives in lib/trust.ts and is unit-tested there.
 * `compact` renders the top-bar pill; otherwise it renders labelled rows for Settings.
 */
export function TrustDial(props: { compact?: boolean }) {
  const value = (): TrustMode => resolveTrustValue(prefs()?.trust_mode);

  async function set(m: TrustMode) {
    if (m === value()) return;
    try {
      await api.prefs.update({ trust_mode: m });
      refetchPrefs();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  return (
    <Show
      when={!props.compact}
      fallback={
        <div class="inline-flex rounded-full border border-surface-700/60 overflow-hidden text-[11px]" role="group" title={TRUST_TITLE}>
          <For each={TRUST_OPTIONS}>
            {(o) => (
              <button
                onClick={() => set(o.value)}
                class="px-2.5 py-0.5 transition-colors"
                classList={{
                  'bg-primary text-primary-foreground': value() === o.value,
                  'text-muted-foreground hover:text-foreground': value() !== o.value,
                }}
              >
                {o.label}
              </button>
            )}
          </For>
        </div>
      }
    >
      <div class="flex flex-col gap-2">
        <div class="inline-flex rounded-full border border-surface-700/60 overflow-hidden text-xs w-fit" role="group">
          <For each={TRUST_OPTIONS}>
            {(o) => (
              <button
                onClick={() => set(o.value)}
                class="px-3 py-1 transition-colors"
                classList={{
                  'bg-primary text-primary-foreground': value() === o.value,
                  'text-muted-foreground hover:text-foreground': value() !== o.value,
                }}
              >
                {o.label}
              </button>
            )}
          </For>
        </div>
        <div class="text-[11px] text-muted-foreground leading-snug">
          {blurbFor(value())}
        </div>
      </div>
    </Show>
  );
}
