import { Show } from 'solid-js';
import { X } from 'lucide-solid';
import { ItemColorPicker } from './ItemColorPicker.js';
import { colorVar } from '../lib/pattern-meta.js';

/**
 * Texture picker (0135) as a pop-up, plus the trigger pill that opens it.
 *
 * It used to live inline in the ElementWizard's left pane: an On/Off chip, an Auto chip,
 * and a 14-swatch grid that wrapped to THREE rows in the 290px column. Collapsing it to
 * one pill is what makes room for the two people fields directly above, and the swatch
 * grid itself is now the shared `ItemColorPicker` the other three screens already use
 * rather than a fourth hand-rolled copy.
 *
 * Purely presentational — it owns no state. The wizard keeps `textureEnabled` /
 * `textureColorToken` exactly as before, so nothing about the save payload changes.
 */

/** The collapsed control: current state at a glance, opens the modal on click. */
export function TextureTrigger(props: {
  enabled: boolean;
  colorToken: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors"
      aria-haspopup="dialog"
    >
      <Show
        when={props.enabled}
        fallback={<span class="w-3 h-3 rounded-full border border-border bg-transparent" aria-hidden="true" />}
      >
        {/* An "Auto" colour has no token to show, so the dot falls back to the
            category-derived hue the stripe will actually use. */}
        <span
          class="w-3 h-3 rounded-full border border-border"
          style={{ 'background-color': colorVar(props.colorToken ?? undefined) }}
          aria-hidden="true"
        />
      </Show>
      {props.enabled ? (props.colorToken ? 'On' : 'On · Auto') : 'Off'}
    </button>
  );
}

export function TextureModal(props: {
  enabled: boolean;
  colorToken: string | null;
  onToggle: (on: boolean) => void;
  onColor: (token: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="texture-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}
    >
      <div class="w-full max-w-xs rounded-lg border border-border bg-popover shadow-xl">
        <div class="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="texture-modal-title" class="text-sm font-semibold text-foreground">Texture</h2>
          <button type="button" onClick={props.onClose} class="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div class="p-4 flex flex-col gap-3">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-muted-foreground">Show the striped texture</span>
            <button
              type="button"
              onClick={() => props.onToggle(!props.enabled)}
              class="text-xs px-2.5 py-1 rounded-full border transition-colors"
              classList={{
                'border-primary text-primary bg-primary/10': props.enabled,
                'border-border text-muted-foreground hover:text-foreground': !props.enabled,
              }}
              aria-pressed={props.enabled}
            >
              {props.enabled ? 'On' : 'Off'}
            </button>
          </div>

          <Show when={props.enabled}>
            <div class="flex flex-col gap-2">
              <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Colour</div>
              {/* The inherit chip IS "Auto" here: null means derive the colour from the
                  element's categories, which is what the old Auto pill did. */}
              <ItemColorPicker
                value={props.colorToken}
                onChange={props.onColor}
                inheritLabel="Auto — derive the colour from this item's categories"
              />
              <p class="text-[11px] text-muted-foreground">
                {props.colorToken ? 'Fixed colour.' : 'Auto — derived from the categories above.'}
              </p>
            </div>
          </Show>

          <button type="button" onClick={props.onClose} class="btn-primary text-xs py-1.5 mt-1">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
