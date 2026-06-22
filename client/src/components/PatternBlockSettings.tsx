import { For, Show, createSignal, createEffect } from 'solid-js';
import { tags, patternPrefs, refetchPatternPrefs, showToast } from '../stores/index.js';
import { api, type Tag, type PatternPref } from '../lib/api.js';
import { ShapeIcon } from './ShapeIcon.js';
import { textureStyle } from '../lib/textures.js';
import { PATTERN_COLORS, SHAPE_OPTIONS, BASE_TAG_DEFAULTS, colorVar } from '../lib/pattern-meta.js';

const DEFAULT_PREF: PatternPref = {
  auto_fill: true,
  reminder_offsets: [],
  icon_shape: 'circle',
  color_token: 'primary',
};

/**
 * Pattern Block Settings: per-pattern-tag visual config — icon shape + token colour.
 * State is lifted here; cards register getters so a single Save can flush all changes
 * at once. Colours use inline CSS variables to bypass Tailwind purging of dynamic
 * class names.
 */
export function PatternBlockSettings(props: { onReady?: (save: () => Promise<void>) => void }) {
  const patternTags = () => (tags() ?? []).filter((t) => t.kind === 'pattern');
  const cardGetters = new Map<Tag['id'], () => { shape: string; color: string }>();

  async function saveAll() {
    try {
      await Promise.all(
        patternTags().map((t) => {
          const s = cardGetters.get(t.id)?.();
          if (!s) return;
          return api.patternPrefs.set(t.id, { icon_shape: s.shape, color_token: s.color });
        })
      );
      refetchPatternPrefs();
      showToast('Pattern settings saved', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  props.onReady?.(saveAll);

  return (
    <div class="flex flex-col gap-2">
      <For each={patternTags()}>
        {(t) => <PatternBlockCard tag={t} onRegister={(g) => cardGetters.set(t.id, g)} />}
      </For>
      <Show when={patternTags().length === 0}>
        <p class="text-sm text-muted-foreground">No pattern tags yet. Add one on the Tags page.</p>
      </Show>
    </div>
  );
}

function PatternBlockCard(props: {
  tag: Tag;
  onRegister: (getter: () => { shape: string; color: string }) => void;
}) {
  const pref = (): PatternPref => {
    const saved = patternPrefs()?.prefs?.[props.tag.id];
    if (saved) return saved;
    const base = BASE_TAG_DEFAULTS[props.tag.name.toLowerCase()];
    return base ? { ...DEFAULT_PREF, ...base } : DEFAULT_PREF;
  };
  const [shape, setShape] = createSignal(pref().icon_shape);
  const [color, setColor] = createSignal(pref().color_token);

  createEffect(() => {
    const p = pref();
    setShape(p.icon_shape);
    setColor(p.color_token);
  });

  props.onRegister(() => ({ shape: shape(), color: color() }));

  return (
    <div class="rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
      {/* Preview + name */}
      <div class="flex items-center gap-2">
        <div
          class="relative w-9 h-6 rounded-md border border-border overflow-hidden flex items-center justify-center flex-shrink-0"
          style={{ color: colorVar(color()) }}
        >
          <div style={textureStyle(shape(), props.tag.name)} />
          <span class="relative"><ShapeIcon shape={shape()} size={13} strokeWidth={1.5} /></span>
        </div>
        <span class="text-sm font-medium text-foreground flex-1 capitalize">{props.tag.name}</span>
        <Show when={props.tag.is_base}>
          <span class="badge-neutral text-[10px]">base</span>
        </Show>
      </div>

      {/* Shape picker */}
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-muted-foreground w-9 flex-shrink-0">Shape</span>
        <div class="flex flex-wrap gap-1">
          <For each={SHAPE_OPTIONS}>
            {(s) => (
              <button
                type="button"
                onClick={() => setShape(s)}
                title={s}
                class="w-7 h-7 rounded-md border flex items-center justify-center transition-colors"
                classList={{
                  'border-primary text-primary': shape() === s,
                  'border-border text-muted-foreground hover:border-muted-foreground': shape() !== s,
                }}
              >
                <ShapeIcon shape={s} size={12} strokeWidth={1} />
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Color picker — inline style avoids Tailwind purging dynamic bg-${token} */}
      <div class="flex items-start gap-2">
        <span class="text-[11px] text-muted-foreground w-9 flex-shrink-0 mt-1">Color</span>
        <div class="flex flex-wrap gap-1.5">
          <For each={PATTERN_COLORS}>
            {(c) => (
              <button
                type="button"
                onClick={() => setColor(c.token)}
                title={c.label}
                class="w-5 h-5 rounded-full border-2 transition-all"
                classList={{
                  'border-foreground scale-110': color() === c.token,
                  'border-transparent hover:scale-105': color() !== c.token,
                }}
                style={{ 'background-color': colorVar(c.token) }}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
