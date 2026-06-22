import { For, Show, createSignal, createEffect } from 'solid-js';
import { Save } from 'lucide-solid';
import { tags, patternPrefs, refetchPatternPrefs, showToast } from '../stores/index.js';
import { api, type Tag, type PatternPref } from '../lib/api.js';
import { ShapeIcon } from './ShapeIcon.js';
import { textureStyle } from '../lib/textures.js';
import { PATTERN_COLORS, SHAPE_OPTIONS, colorVar } from '../lib/pattern-meta.js';

const DEFAULT_PREF: PatternPref = {
  auto_fill: true,
  reminder_offsets: [],
  icon_shape: 'circle',
  color_token: 'primary',
};

/**
 * Pattern Block Settings: per-pattern-tag visual config — icon shape + token colour.
 * Iterates the pattern (direction) tags and reads each tag's display config from
 * `pattern_prefs` (NOT `pattern_types`, which stays the Habit/Routine/Ritual
 * taxonomy). Shapes default per base tag (home=circle, work=square, community=
 * triangle) and stay editable; colours come from the full 17-entry CI-Hub palette.
 */
export function PatternBlockSettings() {
  const patternTags = () => (tags() ?? []).filter((t) => t.kind === 'pattern');

  return (
    <div class="flex flex-col gap-3">
      <For each={patternTags()}>{(t) => <PatternBlockCard tag={t} />}</For>
      <Show when={patternTags().length === 0}>
        <p class="text-sm text-muted-foreground">No pattern tags yet. Add one on the Tags page.</p>
      </Show>
    </div>
  );
}

function PatternBlockCard(props: { tag: Tag }) {
  const pref = (): PatternPref => patternPrefs()?.prefs?.[props.tag.id] ?? DEFAULT_PREF;
  const [shape, setShape] = createSignal(pref().icon_shape);
  const [color, setColor] = createSignal(pref().color_token);
  const [saving, setSaving] = createSignal(false);

  // Sync local edit state when the prefs resource loads/refetches.
  createEffect(() => {
    const p = pref();
    setShape(p.icon_shape);
    setColor(p.color_token);
  });

  async function save() {
    setSaving(true);
    try {
      await api.patternPrefs.set(props.tag.id, { icon_shape: shape(), color_token: color() });
      refetchPatternPrefs();
      showToast(`${props.tag.name} updated`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div class="rounded-lg border border-border bg-card p-3 flex flex-col gap-2.5">
      {/* Header: live texture preview + name */}
      <div class="flex items-center gap-2.5">
        <div class="relative w-10 h-7 rounded-md border border-border overflow-hidden flex items-center justify-center flex-shrink-0"
          style={{ color: colorVar(color()) }}>
          <div style={textureStyle(shape(), props.tag.name)} />
          <span class="relative"><ShapeIcon shape={shape()} size={14} /></span>
        </div>
        <span class="text-sm font-medium text-foreground flex-1 capitalize">{props.tag.name}</span>
        <Show when={props.tag.is_base}>
          <span class="badge-neutral text-[10px]">base</span>
        </Show>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {/* Shape — editable for every pattern; base tags just start at their default. */}
        <div>
          <div class="text-[11px] text-muted-foreground mb-1">Shape</div>
          <div class="flex gap-1">
            <For each={SHAPE_OPTIONS}>
              {(s) => (
                <button type="button" onClick={() => setShape(s)} title={s}
                  class="p-1.5 rounded-md border"
                  classList={{ 'border-primary text-primary': shape() === s, 'border-border text-muted-foreground': shape() !== s }}>
                  <ShapeIcon shape={s} size={15} />
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Color (token swatches — all 17 entries from CORE_COLORS + TAG_COLORS) */}
        <div>
          <div class="text-[11px] text-muted-foreground mb-1">Color</div>
          <div class="flex flex-wrap gap-1">
            <For each={PATTERN_COLORS}>
              {(c) => (
                <button type="button" onClick={() => setColor(c.token)} title={c.label}
                  class={`w-5 h-5 rounded-full bg-${c.token} border-2 transition-transform`}
                  classList={{ 'border-foreground scale-110': color() === c.token, 'border-transparent': color() !== c.token }} />
              )}
            </For>
          </div>
        </div>
      </div>

      <button type="button" onClick={save} disabled={saving()} class="btn-secondary text-xs px-3 py-1.5 self-end">
        <Save size={12} /> {saving() ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
