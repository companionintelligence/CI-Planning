import { For, Show, createSignal } from 'solid-js';
import { connectionPrefs, refetchConnectionPrefs, showToast } from '../stores/index.js';
import { api, CONNECTION_TEXTURES, type ConnectionTexture } from '../lib/api.js';
import { PATTERN_COLORS, colorVar } from '../lib/pattern-meta.js';
import { connectionTextureStyle } from '../lib/textures.js';

/**
 * Per-connection appearance controls (0145): the colour and stripe texture the calendar
 * paints this source's events with. Rendered inside each Connected-accounts row.
 *
 * Saves immediately on click — there is no Save button, because each control is a single
 * independent value and a half-applied colour/texture pair has no meaning worth staging.
 * The optimistic local signal keeps the swatch responsive while the PUT is in flight.
 */
export function ConnectionAppearance(props: { provider: string; account: string }) {
  const key = () => `${props.provider}:${props.account}`;
  const saved = () => connectionPrefs()?.prefs[key()];
  const [pending, setPending] = createSignal<{ color_token?: string; texture?: ConnectionTexture }>({});

  const colorToken = () => pending().color_token ?? saved()?.color_token ?? 'primary';
  const texture = () => pending().texture ?? saved()?.texture ?? 'none';

  async function save(patch: { color_token?: string; texture?: ConnectionTexture }) {
    setPending((p) => ({ ...p, ...patch }));
    try {
      await api.connectionPrefs.set(props.provider, props.account, patch);
      refetchConnectionPrefs();
    } catch (err) {
      setPending({}); // fall back to the stored value — the swatch must not lie
      showToast((err as Error).message, 'error');
    }
  }

  /** A miniature of exactly what a chip from this source will look like. */
  const previewTexture = () => connectionTextureStyle(texture(), colorVar(colorToken()));

  return (
    <div class="flex flex-col gap-2 pt-1">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Colour</span>
        <For each={PATTERN_COLORS}>
          {(col) => (
            <button
              type="button"
              title={col.label}
              aria-label={`Colour ${col.label}`}
              aria-pressed={colorToken() === col.token}
              onClick={() => save({ color_token: col.token })}
              class="w-4 h-4 rounded-full border-2 transition-transform"
              classList={{
                'border-foreground scale-110': colorToken() === col.token,
                'border-transparent hover:scale-105': colorToken() !== col.token,
              }}
              style={{ 'background-color': colorVar(col.token) }}
            />
          )}
        </For>
      </div>

      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Texture</span>
        <For each={CONNECTION_TEXTURES}>
          {(t) => (
            <button
              type="button"
              aria-pressed={texture() === t}
              onClick={() => save({ texture: t })}
              class="px-2 py-0.5 rounded-full text-[11px] border capitalize transition-colors"
              classList={{
                'bg-accent text-white border-accent': texture() === t,
                'border-surface-700 text-slate-400 hover:text-slate-200': texture() !== t,
              }}
            >
              {t}
            </button>
          )}
        </For>
      </div>

      <div class="flex items-center gap-2">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Preview</span>
        <div
          class="relative overflow-hidden rounded-md border h-6 flex-1 max-w-[220px]"
          style={{
            'background-color': `color-mix(in srgb, ${colorVar(colorToken())} 15%, transparent)`,
            'border-color': colorVar(colorToken()),
            'border-left-width': '3px',
          }}
        >
          <Show when={previewTexture()}>
            <div aria-hidden="true" style={previewTexture()} />
          </Show>
          <span class="relative px-1.5 text-[11px] leading-6 text-slate-100 truncate block">
            {props.account}
          </span>
        </div>
      </div>
    </div>
  );
}
