import { createSignal, For, Show } from 'solid-js';
import { Plus, Trash2, X } from 'lucide-solid';
import { api } from '../lib/api.js';
import { patternTypes, refetchPatternTypes, showToast } from '../stores/index.js';
import { ShapeIcon } from './ShapeIcon.js';
import { ItemColorPicker } from './ItemColorPicker.js';
import { colorVar } from '../lib/pattern-meta.js';

/**
 * PatternTypeManager (#391) — the first UI for the pattern-type CRUD
 * (POST/PATCH/DELETE /api/pattern-types, fully built server-side with zero
 * callers: users were stuck with the three seeded types forever). Lives on the
 * Routines panel — deliberately NOT re-adding the Settings "Routine Types"
 * section removed in PR #331.
 *
 * The server's error contract is surfaced verbatim: deleting a builtin → 400
 * ('built-in types cannot be deleted'), a type with member patterns → 409
 * ('type is in use by patterns'). Builtins can still be RENAMED/recoloured —
 * only deletion is protected. The list stays live via the pattern_type:*
 * broadcasts (the store already refetches on them).
 */

const SHAPES = ['square', 'circle', 'triangle', 'diamond', 'pentagon', 'hexagon'];

export function PatternTypeManager(props: { onClose: () => void }) {
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal('');
  const [shape, setShape] = createSignal('square');
  const [color, setColor] = createSignal<string | null>(null);

  const create = async () => {
    if (!name().trim()) return;
    try {
      await api.patternTypes.create({ name: name().trim(), icon_shape: shape(), color_token: color() });
      setCreating(false); setName(''); setShape('square'); setColor(null);
      refetchPatternTypes();
    } catch (err) { showToast((err as Error).message, 'error'); }
  };

  const patch = async (id: string, body: Parameters<typeof api.patternTypes.update>[1]) => {
    try { await api.patternTypes.update(id, body); refetchPatternTypes(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  };

  const remove = async (id: string) => {
    try { await api.patternTypes.delete(id); refetchPatternTypes(); }
    catch (err) { showToast((err as Error).message, 'error'); } // 400 builtin / 409 in-use, verbatim
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal max-w-md" onClick={(e) => e.stopPropagation()}>
        <div class="px-4 py-3 border-b border-border flex items-center justify-between">
          <span class="text-sm font-semibold text-foreground">Pattern types</span>
          <button class="btn-icon" aria-label="Close" onClick={props.onClose}><X size={15} /></button>
        </div>

        <div class="p-4 flex flex-col gap-2 max-h-[70vh] overflow-auto">
          <For each={patternTypes() ?? []}>
            {(t) => (
              <div class="rounded-lg border border-border bg-card px-3 py-2 flex flex-col gap-2">
                <div class="flex items-center gap-2">
                  <span style={{ color: colorVar(t.color_token) }}><ShapeIcon shape={t.icon_shape} size={14} /></span>
                  <input
                    class="input py-1 text-sm flex-1"
                    aria-label={`Rename ${t.name}`}
                    value={t.name}
                    onChange={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== t.name) void patch(t.id, { name: v }); }}
                  />
                  <Show when={t.is_builtin}>
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground" title="Built-in — rename and recolour freely; cannot be deleted">built-in</span>
                  </Show>
                  <button class="btn-icon hover:text-destructive" title={`Delete ${t.name}`} onClick={() => void remove(t.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <ItemColorPicker
                  value={t.color_token}
                  onChange={(token) => void patch(t.id, { color_token: token })}
                  inheritLabel="Default (primary)"
                />
              </div>
            )}
          </For>

          <Show
            when={creating()}
            fallback={
              <button class="btn-secondary text-xs self-start" onClick={() => setCreating(true)}>
                <Plus size={12} /> New type
              </button>
            }
          >
            <div class="rounded-lg border border-border bg-card px-3 py-2 flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <input class="input py-1 text-sm flex-1" placeholder="Type name" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
                <select class="input py-1 text-sm" aria-label="Icon shape" value={shape()} onChange={(e) => setShape(e.currentTarget.value)}>
                  <For each={SHAPES}>{(s) => <option value={s}>{s}</option>}</For>
                </select>
              </div>
              <ItemColorPicker value={color()} onChange={setColor} inheritLabel="Default (primary)" />
              <div class="flex gap-2">
                <button class="btn-primary text-xs" disabled={!name().trim()} onClick={() => void create()}>Create</button>
                <button class="btn-ghost text-xs" onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
