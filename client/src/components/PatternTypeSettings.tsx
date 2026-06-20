import { createSignal, For, Show } from 'solid-js';
import { Plus, Trash2, Save, Bell, BellOff } from 'lucide-solid';
import { patternTypes, refetchPatternTypes, showToast } from '../stores/index.js';
import { api, type PatternType } from '../lib/api.js';
import { ShapeIcon } from './ShapeIcon.js';
import { textureStyle } from '../lib/textures.js';
import { PATTERN_COLORS, SHAPE_OPTIONS, colorVar } from '../lib/pattern-meta.js';

/**
 * Pattern Settings (Step 1): edit each pattern category's display/config defaults
 * — icon shape, token colour, default est, and the per-type reminder toggle — plus
 * add/remove custom types. Colours come from the CI-Hub token palette (no hex), and
 * the live preview shows the type's motif tinted by the chosen colour. Reminder
 * *firing* is Phase H; this only persists the `notify` toggle.
 */
export function PatternTypeSettings() {
  const [newName, setNewName] = createSignal('');
  const [newShape, setNewShape] = createSignal<string>('circle');

  async function addType() {
    if (!newName().trim()) return;
    try {
      await api.patternTypes.create({ name: newName().trim(), icon_shape: newShape(), color_token: 'primary', default_est_minutes: 30, notify: false });
      refetchPatternTypes();
      showToast(`Type "${newName().trim()}" added`, 'success');
      setNewName('');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="flex flex-col gap-3">
      <For each={patternTypes() ?? []}>{(t) => <TypeCard type={t} />}</For>

      {/* Add a custom type */}
      <div class="flex items-center gap-2 rounded-lg border border-dashed border-border p-2">
        <span style={{ color: 'var(--muted-foreground)' }}><ShapeIcon shape={newShape()} size={16} /></span>
        <input class="input py-1 text-sm flex-1" placeholder="New type name (e.g. Errand-run)" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} />
        <div class="flex gap-1">
          <For each={SHAPE_OPTIONS}>
            {(s) => (
              <button type="button" onClick={() => setNewShape(s)} title={s}
                class="p-1 rounded-md border" classList={{ 'border-primary text-primary': newShape() === s, 'border-border text-muted-foreground': newShape() !== s }}>
                <ShapeIcon shape={s} size={14} />
              </button>
            )}
          </For>
        </div>
        <button type="button" onClick={addType} disabled={!newName().trim()} class="btn-primary text-xs px-3 py-1.5"><Plus size={12} /> Add</button>
      </div>
    </div>
  );
}

function TypeCard(props: { type: PatternType }) {
  const [shape, setShape] = createSignal(props.type.icon_shape);
  const [color, setColor] = createSignal(props.type.color_token ?? 'primary');
  const [est, setEst] = createSignal(props.type.default_est_minutes ?? 30);
  const [notify, setNotify] = createSignal(props.type.notify);
  const [saving, setSaving] = createSignal(false);

  async function save() {
    setSaving(true);
    try {
      await api.patternTypes.update(props.type.id, {
        icon_shape: shape(), color_token: color(), default_est_minutes: est(), notify: notify(),
      });
      refetchPatternTypes();
      showToast(`${props.type.name} updated`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setSaving(false); }
  }
  async function remove() {
    try { await api.patternTypes.delete(props.type.id); refetchPatternTypes(); showToast(`Deleted ${props.type.name}`, 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="rounded-lg border border-border bg-card p-3 flex flex-col gap-2.5">
      {/* Header: live texture preview + name */}
      <div class="flex items-center gap-2.5">
        <div class="relative w-10 h-7 rounded-md border border-border overflow-hidden flex items-center justify-center flex-shrink-0"
          style={{ color: colorVar(color()) }}>
          <div style={textureStyle(shape(), props.type.name)} />
          <span class="relative"><ShapeIcon shape={shape()} size={14} /></span>
        </div>
        <span class="text-sm font-medium text-foreground flex-1">{props.type.name}</span>
        <Show when={props.type.is_builtin} fallback={
          <button type="button" onClick={remove} class="btn-icon hover:text-destructive" title="Delete type"><Trash2 size={13} /></button>
        }>
          <span class="badge-neutral text-[10px]">built-in</span>
        </Show>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {/* Shape — fixed for built-ins (Habit ◯ / Routine ▢ / Ritual △), editable for custom types. */}
        <div>
          <div class="text-[11px] text-muted-foreground mb-1">Shape</div>
          <Show
            when={!props.type.is_builtin}
            fallback={
              <div class="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-border text-muted-foreground">
                <ShapeIcon shape={props.type.icon_shape} size={15} />
                <span class="text-[11px]">fixed</span>
              </div>
            }
          >
            <div class="flex gap-1">
              <For each={SHAPE_OPTIONS}>
                {(s) => (
                  <button type="button" onClick={() => setShape(s)} title={s}
                    class="p-1.5 rounded-md border" classList={{ 'border-primary text-primary': shape() === s, 'border-border text-muted-foreground': shape() !== s }}>
                    <ShapeIcon shape={s} size={15} />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Color (token swatches) */}
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

        {/* Est duration */}
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-muted-foreground">Default est. (minutes)</span>
          <input type="number" min="5" step="5" class="input py-1 text-sm" value={est()} onInput={(e) => setEst(Number(e.currentTarget.value) || 0)} />
        </label>

        {/* Notify toggle */}
        <div class="flex flex-col gap-1">
          <span class="text-[11px] text-muted-foreground">Reminders</span>
          <button type="button" onClick={() => setNotify((v) => !v)}
            class="inline-flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-md border self-start"
            classList={{ 'border-primary text-primary': notify(), 'border-border text-muted-foreground': !notify() }}>
            <Show when={notify()} fallback={<><BellOff size={13} /> Off</>}><Bell size={13} /> On</Show>
          </button>
        </div>
      </div>

      <button type="button" onClick={save} disabled={saving()} class="btn-secondary text-xs px-3 py-1.5 self-end">
        <Save size={12} /> {saving() ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
