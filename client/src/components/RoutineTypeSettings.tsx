import { For, Show, createSignal } from 'solid-js';
import { Check, X, Pencil, Trash2, Plus, Lock } from 'lucide-solid';
import { patternTypes, refetchPatternTypes, showToast } from '../stores/index.js';
import { api, type PatternType } from '../lib/api.js';
import { ShapeIcon } from './ShapeIcon.js';
import { PATTERN_COLORS, SHAPE_OPTIONS, colorVar } from '../lib/pattern-meta.js';

interface EditState {
  name: string;
  icon_shape: string;
  color_token: string;
  default_est_minutes: number;
  notify: boolean;
}

function toEditState(t?: PatternType): EditState {
  return {
    name: t?.name ?? '',
    icon_shape: t?.icon_shape ?? 'circle',
    color_token: t?.color_token ?? 'primary',
    default_est_minutes: t?.default_est_minutes ?? 30,
    notify: t?.notify ?? false,
  };
}

export function RoutineTypeSettings() {
  const [editingId, setEditingId] = createSignal<string | 'new' | null>(null);
  const [editForm, setEditForm] = createSignal<EditState>(toEditState());
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  function startEdit(t: PatternType) {
    setEditingId(t.id);
    setEditForm(toEditState(t));
    setConfirmDelete(null);
  }

  function startNew() {
    setEditingId('new');
    setEditForm(toEditState());
    setConfirmDelete(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setConfirmDelete(null);
  }

  async function saveEdit() {
    const id = editingId();
    if (!id) return;
    const f = editForm();
    if (!f.name.trim()) { showToast('Name is required', 'error'); return; }
    setSaving(true);
    try {
      const body = {
        name: f.name.trim(),
        icon_shape: f.icon_shape,
        color_token: f.color_token,
        default_est_minutes: f.default_est_minutes || null,
        notify: f.notify,
      };
      if (id === 'new') {
        await api.patternTypes.create(body);
      } else {
        await api.patternTypes.update(id, body);
      }
      refetchPatternTypes();
      setEditingId(null);
      showToast(id === 'new' ? 'Type created' : 'Type saved', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function doDelete(id: string) {
    setSaving(true);
    try {
      await api.patternTypes.delete(id);
      refetchPatternTypes();
      setConfirmDelete(null);
      showToast('Type deleted', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <For each={patternTypes() ?? []}>
        {(t) => (
          <div class="rounded-lg border border-border bg-card overflow-hidden">
            {/* Summary row */}
            <div class="flex items-center gap-2.5 px-3 py-2.5">
              <div style={{ color: colorVar(t.color_token) }} class="flex-shrink-0">
                <ShapeIcon shape={t.icon_shape} size={14} strokeWidth={1.5} />
              </div>
              <span class="text-sm font-medium text-foreground flex-1">{t.name}</span>
              <Show when={t.default_est_minutes != null}>
                <span class="text-[11px] text-muted-foreground">{t.default_est_minutes}m</span>
              </Show>
              <Show when={t.is_builtin}>
                <span class="badge-neutral text-[10px] flex items-center gap-0.5 select-none">
                  <Lock size={8} /> built-in
                </span>
              </Show>
              <button
                type="button"
                title={editingId() === t.id ? 'Cancel edit' : 'Edit'}
                onClick={() => editingId() === t.id ? cancelEdit() : startEdit(t)}
                class="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil size={12} />
              </button>
              <Show when={!t.is_builtin}>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => setConfirmDelete(confirmDelete() === t.id ? null : t.id)}
                  class="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </Show>
            </div>

            {/* Inline delete confirmation */}
            <Show when={confirmDelete() === t.id}>
              <div class="border-t border-border bg-destructive/5 px-3 py-2 flex items-center justify-between">
                <span class="text-xs text-destructive">
                  Delete "{t.name}"? Patterns using this type will lose their type.
                </span>
                <div class="flex items-center gap-1.5 ml-3 flex-shrink-0">
                  <button type="button" onClick={() => setConfirmDelete(null)}
                    class="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border transition-colors">
                    Cancel
                  </button>
                  <button type="button" onClick={() => doDelete(t.id)} disabled={saving()}
                    class="text-xs text-destructive hover:text-destructive/80 px-2 py-1 rounded border border-destructive/40 disabled:opacity-50 transition-colors">
                    Delete
                  </button>
                </div>
              </div>
            </Show>

            {/* Inline edit form */}
            <Show when={editingId() === t.id}>
              <TypeEditForm
                form={editForm()}
                onChange={setEditForm}
                onSave={saveEdit}
                onCancel={cancelEdit}
                saving={saving()}
              />
            </Show>
          </div>
        )}
      </For>

      {/* New-type form */}
      <Show when={editingId() === 'new'}>
        <div class="rounded-lg border border-primary/40 bg-card overflow-hidden">
          <div class="px-3 pt-2.5 text-xs font-medium text-muted-foreground">New type</div>
          <TypeEditForm
            form={editForm()}
            onChange={setEditForm}
            onSave={saveEdit}
            onCancel={cancelEdit}
            saving={saving()}
          />
        </div>
      </Show>

      <Show when={editingId() !== 'new'}>
        <button
          type="button"
          onClick={startNew}
          class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 py-1 self-start"
        >
          <Plus size={12} /> Add custom type
        </button>
      </Show>
    </div>
  );
}

function TypeEditForm(props: {
  form: EditState;
  onChange: (s: EditState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const set = (patch: Partial<EditState>) => props.onChange({ ...props.form, ...patch });

  return (
    <div class="border-t border-border px-3 py-3 flex flex-col gap-3">
      {/* Name */}
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Name</span>
        <input
          type="text"
          maxlength="40"
          class="input text-sm flex-1"
          value={props.form.name}
          onInput={(e) => set({ name: e.currentTarget.value })}
          placeholder="Type name"
        />
      </div>

      {/* Shape */}
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Shape</span>
        <div class="flex flex-wrap gap-1">
          <For each={SHAPE_OPTIONS}>
            {(s) => (
              <button
                type="button"
                title={s}
                onClick={() => set({ icon_shape: s })}
                class="w-7 h-7 rounded-md border flex items-center justify-center transition-colors"
                classList={{
                  'border-primary text-primary': props.form.icon_shape === s,
                  'border-border text-muted-foreground hover:border-muted-foreground': props.form.icon_shape !== s,
                }}
              >
                <ShapeIcon shape={s} size={12} strokeWidth={1} />
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Color */}
      <div class="flex items-start gap-2">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0 mt-0.5">Color</span>
        <div class="flex flex-wrap gap-1.5">
          <For each={PATTERN_COLORS}>
            {(c) => (
              <button
                type="button"
                title={c.label}
                onClick={() => set({ color_token: c.token })}
                class="w-5 h-5 rounded-full border-2 transition-all"
                classList={{
                  'border-foreground scale-110': props.form.color_token === c.token,
                  'border-transparent hover:scale-105': props.form.color_token !== c.token,
                }}
                style={{ 'background-color': colorVar(c.token) }}
              />
            )}
          </For>
        </div>
      </div>

      {/* Default minutes */}
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Default</span>
        <input
          type="number"
          min="5"
          step="5"
          class="input text-sm w-20"
          value={props.form.default_est_minutes}
          onInput={(e) => set({ default_est_minutes: Number(e.currentTarget.value) || 0 })}
        />
        <span class="text-[11px] text-muted-foreground">min estimate</span>
      </div>

      {/* Notify toggle */}
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Notify</span>
        <button
          type="button"
          onClick={() => set({ notify: !props.form.notify })}
          class="relative inline-flex h-4 w-7 items-center rounded-full border transition-colors flex-shrink-0"
          classList={{
            'bg-primary border-primary': props.form.notify,
            'bg-muted border-border': !props.form.notify,
          }}
        >
          <span
            class="inline-block h-3 w-3 rounded-full bg-white shadow transition-transform"
            classList={{
              'translate-x-3.5': props.form.notify,
              'translate-x-0.5': !props.form.notify,
            }}
          />
        </button>
        <span class="text-[11px] text-muted-foreground">enable reminders for this type</span>
      </div>

      {/* Actions */}
      <div class="flex items-center justify-end gap-2 pt-1 border-t border-border/50">
        <button
          type="button"
          onClick={props.onCancel}
          class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border transition-colors"
        >
          <X size={11} /> Cancel
        </button>
        <button
          type="button"
          onClick={props.onSave}
          disabled={props.saving}
          class="flex items-center gap-1 text-xs text-primary hover:text-primary/80 px-2 py-1 rounded border border-primary/40 disabled:opacity-50 transition-colors"
        >
          <Check size={11} /> {props.saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
