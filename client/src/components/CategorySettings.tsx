import { For, Show, createSignal } from 'solid-js';
import { CATEGORIES_EDITABLE } from '../lib/flags.js';
import { Check, X, Pencil, Trash2, Plus, Hash } from 'lucide-solid';
import { tags, refetchTags, categoryPrefs, refetchCategoryPrefs, showToast } from '../stores/index.js';
import { api, type Tag } from '../lib/api.js';
import { PATTERN_COLORS, colorVar } from '../lib/pattern-meta.js';
import { sortCategories, displayTag } from '../lib/tag-tax.js';

/**
 * Time Block Category catalog (0069/0126). The same `tags.kind='category'` tags shown
 * on the Tags "Time Block Categories" tab, managed here as expandable rows with a
 * per-category color. Duration defaults live on Pattern Tags, not here (owner ruling
 * 2026-07-12); the stored category default_minutes is left untouched. Base categories
 * (personal/professional/social) are rename/recolor-only — no delete, no badge.
 */

interface EditState {
  name: string;
  color_token: string;
}

export function CategorySettings() {
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editForm, setEditForm] = createSignal<EditState>({ name: '', color_token: 'primary' });
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [newName, setNewName] = createSignal('');

  const cats = () => sortCategories((tags() ?? []).filter((t) => t.kind === 'category'));
  const prefsOf = (id: string) => categoryPrefs()?.prefs?.[id] ?? { color_token: 'primary', default_minutes: 60 };

  function startEdit(c: Tag) {
    const p = prefsOf(c.id);
    setEditForm({ name: c.name, color_token: p.color_token });
    setEditingId(c.id);
    setConfirmDelete(null);
  }
  function cancelEdit() { setEditingId(null); setConfirmDelete(null); }

  async function saveEdit() {
    const id = editingId();
    if (!id) return;
    const f = editForm();
    if (!f.name.trim()) { showToast('Name is required', 'error'); return; }
    const cat = cats().find((c) => c.id === id);
    setSaving(true);
    try {
      // Rename only when changed — the server normalizes + 409s on a name clash.
      // default_minutes is deliberately untouched (duration lives on Pattern Tags).
      if (cat && f.name.trim() !== cat.name) await api.tags.update(id, { name: f.name.trim() });
      await api.categoryPrefs.set(id, { color_token: f.color_token });
      refetchTags(); refetchCategoryPrefs();
      setEditingId(null);
      showToast('Category saved', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function doDelete(id: string) {
    setSaving(true);
    try {
      await api.tags.remove(id); // server 409s if base or in use (categoryIsReferenced)
      refetchTags(); refetchCategoryPrefs();
      setConfirmDelete(null);
      showToast('Category deleted', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function addCategory(e: Event) {
    e.preventDefault();
    if (!newName().trim()) return;
    setSaving(true);
    try {
      await api.tags.create(newName().trim(), { kind: 'category' });
      refetchTags(); refetchCategoryPrefs();
      setNewName('');
      showToast('Category added', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <For each={cats()}>
        {(c) => {
          const p = () => prefsOf(c.id);
          return (
            <div class="rounded-lg border border-border bg-card overflow-hidden">
              {/* Summary row */}
              <div class="flex items-center gap-2.5 px-3 py-2.5">
                <span class="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ 'background-color': colorVar(p().color_token) }} />
                <span class="text-sm font-medium text-foreground flex-1">{displayTag(c.name)}</span>
                <button
                  type="button"
                  title={editingId() === c.id ? 'Cancel edit' : 'Edit'}
                  onClick={() => (editingId() === c.id ? cancelEdit() : startEdit(c))}
                  class="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                ><Pencil size={12} /></button>
                <Show when={!c.is_base}>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => setConfirmDelete(confirmDelete() === c.id ? null : c.id)}
                    class="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                  ><Trash2 size={12} /></button>
                </Show>
              </div>

              {/* Inline delete confirmation */}
              <Show when={confirmDelete() === c.id}>
                <div class="border-t border-border bg-destructive/5 px-3 py-2 flex items-center justify-between">
                  <span class="text-xs text-destructive">Delete "{displayTag(c.name)}"? Blocks already placed keep their colour.</span>
                  <div class="flex items-center gap-1.5 ml-3 flex-shrink-0">
                    <button type="button" onClick={() => setConfirmDelete(null)}
                      class="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border transition-colors">Cancel</button>
                    <button type="button" onClick={() => doDelete(c.id)} disabled={saving()}
                      class="text-xs text-destructive hover:text-destructive/80 px-2 py-1 rounded border border-destructive/40 disabled:opacity-50 transition-colors">Delete</button>
                  </div>
                </div>
              </Show>

              {/* Inline edit form */}
              <Show when={editingId() === c.id}>
                <div class="border-t border-border px-3 py-3 flex flex-col gap-3">
                  <div class="flex items-center gap-2">
                    <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Name</span>
                    <input type="text" maxlength="40" class="input text-sm flex-1"
                      value={editForm().name} onInput={(e) => setEditForm({ ...editForm(), name: e.currentTarget.value })} placeholder="Category name" />
                  </div>
                  <div class="flex items-start gap-2">
                    <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0 mt-0.5">Color</span>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={PATTERN_COLORS}>
                        {(col) => (
                          <button type="button" title={col.label}
                            onClick={() => setEditForm({ ...editForm(), color_token: col.token })}
                            class="w-5 h-5 rounded-full border-2 transition-all"
                            classList={{
                              'border-foreground scale-110': editForm().color_token === col.token,
                              'border-transparent hover:scale-105': editForm().color_token !== col.token,
                            }}
                            style={{ 'background-color': colorVar(col.token) }} />
                        )}
                      </For>
                    </div>
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

      {/* Add a category — gated OFF this delivery (0134): categories == the fixed six
          Balance dimensions; adding one means adding a Balance dimension (a later phase). */}
      <Show when={CATEGORIES_EDITABLE} fallback={
        <p class="text-[11px] text-muted-foreground mt-1">
          Categories mirror your Balance dimensions — rename or recolour them here; adding new ones is coming soon.
        </p>
      }>
        <form onSubmit={addCategory} class="flex gap-2 mt-1">
          <div class="relative flex-1">
            <Hash size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input class="input text-sm pl-7" placeholder="New category…" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} />
          </div>
          <button type="submit" disabled={saving() || !newName().trim()} class="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"><Plus size={12} /> Add</button>
        </form>
      </Show>
    </div>
  );
}
