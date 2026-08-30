import { createSignal, createMemo, onCleanup, onMount, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { X, Check } from 'lucide-solid';
import { FocusSurface } from './FocusSurface.js';
import { focusState } from '../lib/focus.js';
import { PATTERN_COLORS, colorVar } from '../lib/pattern-meta.js';
import { SESSION_MINUTES, FOCUS_STYLES } from '../lib/focus-appearance.js';
import { focusAppearance, setFocusAppearance, prefs } from '../stores/index.js';

/**
 * FOCUS LAB — the pop-up behind the FOCUS header's tuner button.
 *
 * Two settings, both display-only: how long a **Start now** session runs, and what
 * colour the ritual is lit with. Neither is written onto a task or a block — the
 * colour in particular only changes what you look at while the timer runs, and is
 * recorded in `view_prefs.focus.colorToken` so the choice survives. Leaving it on
 * "Direction" (the default) follows the task's own Work / Home / Community colour.
 *
 * The **style** is deliberately not here: it is a standing preference, so it lives
 * in Settings → Routine Settings. What this pop-up shows is the style the owner has
 * already chosen, running at a fixed mid-block moment so the colour choice is
 * visible rather than guessed from a swatch.
 */

/** Where in the block the preview sits — past the opening, before the warning. */
const PREVIEW_AT = 0.42;

export function FocusLab(props: {
  onClose: () => void;
  /** The tint the ritual would use right now with no override — the live "Direction" colour. */
  directionTint?: string;
}) {
  const appearance = () => focusAppearance();
  const styleName = () => FOCUS_STYLES.find((s) => s.id === appearance().style)?.name ?? 'Breath';

  // A still frame of the real ritual maths, so the preview cannot drift from it.
  const spanMs = () => (appearance().sessionMinutes ?? 25) * 60_000;
  const state = createMemo(() => focusState(PREVIEW_AT * spanMs(), 0, spanMs()));

  const previewTint = () =>
    appearance().colorToken ? colorVar(appearance().colorToken!) : (props.directionTint ?? 'var(--primary)');

  // Escape closes, matching the ritual itself.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); props.onClose(); } };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <Portal>
      <div class="modal-backdrop" role="dialog" aria-label="Focus Lab" onClick={props.onClose}>
        <div class="modal max-w-md" onClick={(e) => e.stopPropagation()}>
          <div class="flex items-start justify-between gap-3 px-4 pt-4">
            <div>
              <div class="text-sm font-semibold text-foreground">Focus Lab</div>
              <div class="text-[11px] text-muted-foreground mt-0.5">
                How long a “Start now” session runs, and what the timer is lit with. Neither changes the task.
              </div>
            </div>
            <button class="btn-icon flex-shrink-0" onClick={props.onClose} title="Close (Esc)"><X size={16} /></button>
          </div>

          {/* Live preview — the style chosen in Settings, at a mid-block moment. */}
          <div class="px-4 pt-3">
            <FocusSurface
              style={appearance().style}
              class="h-[15rem] rounded-xl border border-border overflow-hidden"
              title="Draft the Q3 planning memo"
              phase={state().phase}
              elapsedFrac={state().elapsedFrac}
              depletionFrac={state().depletionFrac}
              remainingMs={state().remainingMs}
              tint={previewTint()}
              ambient={prefs()?.ambient_color_enabled !== false}
            />
            <div class="text-[11px] text-muted-foreground mt-1.5 text-center">
              {styleName()} — change the style in Settings → Routine Settings.
            </div>
          </div>

          <div class="px-4 py-4 flex flex-col gap-4">
            {/* ── Timing ─────────────────────────────────────────────────── */}
            <div>
              <div class="text-xs font-semibold text-foreground mb-1">Session length</div>
              <div class="text-[11px] text-muted-foreground mb-2">
                Used when you start a task from FOCUS. “Task estimate” keeps each task’s own length.
              </div>
              <div class="flex flex-wrap gap-1.5">
                <Choice
                  label="Task estimate"
                  on={appearance().sessionMinutes === null}
                  onClick={() => setFocusAppearance({ sessionMinutes: null })}
                />
                <For each={SESSION_MINUTES}>
                  {(m) => (
                    <Choice
                      label={`${m}m`}
                      on={appearance().sessionMinutes === m}
                      onClick={() => setFocusAppearance({ sessionMinutes: m })}
                    />
                  )}
                </For>
              </div>
            </div>

            {/* ── Colour ─────────────────────────────────────────────────── */}
            <div>
              <div class="text-xs font-semibold text-foreground mb-1">Colour</div>
              <div class="text-[11px] text-muted-foreground mb-2">
                Only the focus screen changes — the task keeps its own colour everywhere else.
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <Choice
                  label="Direction"
                  title="Follow the task's Work / Home / Community colour"
                  on={appearance().colorToken === null}
                  onClick={() => setFocusAppearance({ colorToken: null })}
                />
                <For each={PATTERN_COLORS}>
                  {(c) => (
                    <button
                      class="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center"
                      style={{ background: colorVar(c.token) }}
                      classList={{
                        'border-foreground': appearance().colorToken === c.token,
                        'border-transparent': appearance().colorToken !== c.token,
                      }}
                      title={c.label}
                      aria-label={c.label}
                      aria-pressed={appearance().colorToken === c.token}
                      onClick={() => setFocusAppearance({ colorToken: c.token })}
                    >
                      <Show when={appearance().colorToken === c.token}>
                        <Check size={12} class="text-background" />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>

          <div class="px-4 pb-4 flex justify-end">
            <button class="btn-primary text-sm px-4 py-1.5" onClick={props.onClose}>Done</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function Choice(props: { label: string; on: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="text-[11px] px-2.5 py-1 rounded-full border transition-colors"
      classList={{
        'border-primary text-primary bg-primary/10': props.on,
        'border-border text-muted-foreground hover:text-foreground': !props.on,
      }}
      title={props.title}
      aria-pressed={props.on}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}
