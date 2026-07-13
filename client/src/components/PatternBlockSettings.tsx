import { For, Show, createSignal } from 'solid-js';
import { Check, X, Pencil } from 'lucide-solid';
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
  default_minutes: 60, // matches the server's canonical default (services/pattern-prefs.ts)
};

interface EditState {
  shape: string;
  color_token: string;
  default_minutes: number;
}

/**
 * Pattern Tag settings — per-direction-tag visual config (icon shape + token colour)
 * plus the default estimate. Expandable rows matching CategorySettings' UX (owner
 * ruling 2026-07-12): a collapsed summary row (shape swatch · name · Xm · pencil)
 * opening an inline edit form with its own Save — no lifted section-level Save.
 * Colours use inline CSS variables to bypass Tailwind purging of dynamic class names.
 */
export function PatternBlockSettings() {
  const patternTags = () => (tags() ?? []).filter((t) => t.kind === 'direction');
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editForm, setEditForm] = createSignal<EditState>({ shape: 'circle', color_token: 'primary', default_minutes: 60 });
  const [saving, setSaving] = createSignal(false);

  const prefOf = (t: Tag): PatternPref => {
    const saved = patternPrefs()?.prefs?.[t.id];
    if (saved) return saved;
    const base = BASE_TAG_DEFAULTS[t.name.toLowerCase()];
    return base ? { ...DEFAULT_PREF, ...base } : DEFAULT_PREF;
  };

  function startEdit(t: Tag) {
    const p = prefOf(t);
    setEditForm({ shape: p.icon_shape, color_token: p.color_token, default_minutes: p.default_minutes });
    setEditingId(t.id);
  }
  function cancelEdit() { setEditingId(null); }

  async function saveEdit() {
    const id = editingId();
    if (!id) return;
    const f = editForm();
    setSaving(true);
    try {
      await api.patternPrefs.set(id, {
        icon_shape: f.shape,
        color_token: f.color_token,
        default_minutes: f.default_minutes || 60,
      });
      refetchPatternPrefs();
      setEditingId(null);
      showToast('Pattern tag saved', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <For each={patternTags()}>
        {(t) => {
          const p = () => prefOf(t);
          return (
            <div class="rounded-lg border border-border bg-card overflow-hidden">
              {/* Summary row — shape swatch, name, default minutes, edit toggle */}
              <div class="flex items-center gap-2.5 px-3 py-2.5">
                <div
                  class="relative w-9 h-6 rounded-md border border-border overflow-hidden flex items-center justify-center flex-shrink-0"
                  style={{ color: colorVar(editingId() === t.id ? editForm().color_token : p().color_token) }}
                >
                  <div style={textureStyle(editingId() === t.id ? editForm().shape : p().icon_shape, t.name)} />
                  <span class="relative"><ShapeIcon shape={editingId() === t.id ? editForm().shape : p().icon_shape} size={13} strokeWidth={1.5} /></span>
                </div>
                <span class="text-sm font-medium text-foreground flex-1 capitalize">{t.name}</span>
                <span class="text-[11px] text-muted-foreground" title="Default time when a task has no intention tag">{p().default_minutes}m</span>
                <button
                  type="button"
                  title={editingId() === t.id ? 'Cancel edit' : 'Edit'}
                  onClick={() => (editingId() === t.id ? cancelEdit() : startEdit(t))}
                  class="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                ><Pencil size={12} /></button>
              </div>

              {/* Inline edit form */}
              <Show when={editingId() === t.id}>
                <div class="border-t border-border px-3 py-3 flex flex-col gap-3">
                  <div class="flex items-center gap-2">
                    <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Shape</span>
                    <div class="flex flex-wrap gap-1">
                      <For each={SHAPE_OPTIONS}>
                        {(s) => (
                          <button
                            type="button"
                            onClick={() => setEditForm({ ...editForm(), shape: s })}
                            title={s}
                            class="w-7 h-7 rounded-md border flex items-center justify-center transition-colors"
                            classList={{
                              'border-primary text-primary': editForm().shape === s,
                              'border-border text-muted-foreground hover:border-muted-foreground': editForm().shape !== s,
                            }}
                          >
                            <ShapeIcon shape={s} size={12} strokeWidth={1} />
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                  <div class="flex items-start gap-2">
                    <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0 mt-0.5">Color</span>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={PATTERN_COLORS}>
                        {(c) => (
                          <button
                            type="button"
                            onClick={() => setEditForm({ ...editForm(), color_token: c.token })}
                            title={c.label}
                            class="w-5 h-5 rounded-full border-2 transition-all"
                            classList={{
                              'border-foreground scale-110': editForm().color_token === c.token,
                              'border-transparent hover:scale-105': editForm().color_token !== c.token,
                            }}
                            style={{ 'background-color': colorVar(c.token) }}
                          />
                        )}
                      </For>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Default</span>
                    <input type="number" min="5" step="5" class="input text-sm w-20"
                      value={editForm().default_minutes}
                      onInput={(e) => setEditForm({ ...editForm(), default_minutes: Number(e.currentTarget.value) || 0 })} />
                    <span class="text-[11px] text-muted-foreground">min — default estimate</span>
                  </div>
                  <div class="flex items-center justify-end gap-2 pt-1 border-t border-border/50">
                    <button type="button" onClick={cancelEdit}
                      class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border transition-colors"><X size={11} /> Cancel</button>
                    <button type="button" onClick={saveEdit} disabled={saving()}
                      class="flex items-center gap-1 text-xs text-primary hover:text-primary/80 px-2 py-1 rounded border border-primary/40 disabled:opacity-50 transition-colors"><Check size={11} /> {saving() ? 'Saving…' : 'Save'}</button>
                  </div>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
      <Show when={patternTags().length === 0}>
        <p class="text-sm text-muted-foreground">No pattern tags yet. Add one on the Tags page.</p>
      </Show>
    </div>
  );
}
