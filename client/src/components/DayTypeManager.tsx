import { createResource, createSignal, For, Show } from 'solid-js';
import { Plus, Trash2 } from 'lucide-solid';
import { refetchPatternBlocks, showToast } from '../stores/index.js';
import { api, type DayType } from '../lib/api.js';
import { SchedulePatternEditor } from './SchedulePatternEditor.js';

// Display order Mon→Sun over the UTC dow indices (0=Sun … 6=Sat) used by the resolver.
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DOW_NAME: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

/**
 * T-SCHED-4 — manage custom day types (create / rename / delete; builtins are
 * rename-only), edit the weekly default map (dow → day type), and edit the selected
 * day type's availability windows via the shared SchedulePatternEditor.
 */
export function DayTypeManager() {
  const [types, { refetch: refetchTypes }] = createResource(() => api.dayTypes.list().then((r) => r.day_types));
  const [weekMap, { refetch: refetchMap }] = createResource(() => api.dayTypes.weekMap().then((r) => r.map));
  const [selected, setSelected] = createSignal('workday');
  const [adding, setAdding] = createSignal(false);
  const [newKey, setNewKey] = createSignal('');
  const [newName, setNewName] = createSignal('');

  const selectedType = (): DayType | undefined => types()?.find((t) => t.key === selected());

  async function create() {
    const key = newKey().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const name = newName().trim();
    if (!key || !name) return;
    try {
      await api.dayTypes.create(key, name);
      setNewKey(''); setNewName(''); setAdding(false);
      await refetchTypes();
      setSelected(key);
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function rename(t: DayType, name: string) {
    if (!name.trim() || name.trim() === t.name) return;
    try { await api.dayTypes.rename(t.id, name.trim()); refetchTypes(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function remove(t: DayType) {
    if (!confirm(`Delete the "${t.name}" day type? Days using it fall back to the default.`)) return;
    try {
      await api.dayTypes.remove(t.id);
      if (selected() === t.key) setSelected('workday');
      refetchTypes(); refetchMap(); refetchPatternBlocks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function setDow(dow: number, key: string) {
    const next = { ...(weekMap() ?? {}), [dow]: key };
    try { await api.dayTypes.setWeekMap(next); refetchMap(); refetchPatternBlocks(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="flex flex-col gap-4">
      {/* Day-type selector + add */}
      <div class="flex flex-wrap gap-2 items-center">
        <For each={types()}>
          {(t) => (
            <button
              type="button"
              onClick={() => setSelected(t.key)}
              class="px-3 py-1 text-sm rounded-md transition-colors"
              classList={{ 'bg-primary text-primary-foreground': selected() === t.key, 'text-muted-foreground hover:text-foreground border border-border': selected() !== t.key }}
            >
              {t.name}
            </button>
          )}
        </For>
        <Show when={adding()} fallback={
          <button type="button" onClick={() => setAdding(true)} class="btn-secondary text-xs px-2.5 py-1"><Plus size={12} /> Day type</button>
        }>
          <div class="inline-flex items-center gap-1.5">
            <input class="input py-1 text-sm w-24" placeholder="key" value={newKey()} onInput={(e) => setNewKey(e.currentTarget.value)} />
            <input class="input py-1 text-sm w-28" placeholder="Name" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <button type="button" onClick={create} disabled={!newKey().trim() || !newName().trim()} class="btn-primary text-xs px-2 py-1">Add</button>
            <button type="button" onClick={() => { setAdding(false); setNewKey(''); setNewName(''); }} class="btn-ghost text-xs px-2 py-1">Cancel</button>
          </div>
        </Show>
      </div>

      {/* Manage the selected day type: rename (builtins allowed) + delete (custom only) */}
      <Show when={selectedType()}>
        {(t) => (
          <div class="flex items-center gap-2">
            <span class="text-[11px] uppercase tracking-wide text-muted-foreground">Name</span>
            <input
              class="input py-1 text-sm w-44"
              value={t().name}
              onChange={(e) => rename(t(), e.currentTarget.value)}
            />
            <Show when={!t().is_builtin} fallback={<span class="text-[10px] text-muted-foreground">built-in</span>}>
              <button type="button" onClick={() => remove(t())} class="btn-icon hover:text-destructive" title="Delete day type"><Trash2 size={14} /></button>
            </Show>
          </div>
        )}
      </Show>

      {/* Windows for the selected day type */}
      <div class="rounded-lg border border-border bg-background/40 p-3">
        <p class="text-[11px] text-muted-foreground mb-2 capitalize">Windows · {selectedType()?.name ?? selected()}</p>
        <SchedulePatternEditor dayType={selected()} />
      </div>

      {/* Weekly default map */}
      <div>
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Weekly default</div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <For each={DOW_ORDER}>
            {(dow) => (
              <label class="flex items-center gap-2 text-sm">
                <span class="w-9 text-muted-foreground">{DOW_NAME[dow]}</span>
                <select class="input py-1 text-sm flex-1" value={weekMap()?.[dow] ?? ''} onChange={(e) => setDow(dow, e.currentTarget.value)}>
                  <For each={types()}>{(t) => <option value={t.key}>{t.name}</option>}</For>
                </select>
              </label>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
