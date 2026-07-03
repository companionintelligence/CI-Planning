import { createSignal, createEffect, createResource, For } from 'solid-js';
import { Plus, Trash2 } from 'lucide-solid';
import { tags, patternPrefs, refetchPatternPrefs, refetchPatternBlocks, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';

/**
 * Per-direction availability windows (Pattern-blocks) for ONE day type, plus the
 * per-direction "fill work hours" toggle. Mounts in Settings (T-SCHED-4), Today and
 * Calendar (T-SCHED-1). As of T-SCHED-3/4 it targets any day-type **key** (builtin
 * workday/weekend or a custom one), fetching that key's windows directly rather than
 * reading the two-key store — so a custom day type can own its own windows.
 *
 * Local edit state is keyed by dirTagId, seeded from the fetch and re-seeded only when
 * `dayType` changes; edits commit to the server on blur (and refresh dependents via
 * refetchPatternBlocks), so editing never clobbers an in-progress change.
 */

interface Range { start_time: string; end_time: string }

export interface SchedulePatternEditorProps {
  dayType: string;
}

export function SchedulePatternEditor(props: SchedulePatternEditorProps) {
  const patternTagList = () => (tags() ?? []).filter((t) => t.kind === 'direction');

  // Re-fetched whenever the targeted day type changes.
  const [data] = createResource(() => props.dayType, (dt) => api.patternBlocks.forDay(dt).then((r) => r.windows));

  const [windows, setWindows] = createSignal<Record<string, Range[]>>({});
  createEffect(() => {
    const w = data();
    if (!w) return;
    const out: Record<string, Range[]> = {};
    for (const [dirId, ranges] of Object.entries(w)) out[dirId] = ranges.map((r) => ({ start_time: r.start_time, end_time: r.end_time }));
    setWindows(out);
  });

  const getRanges = (dirId: string) => windows()[dirId] ?? [];
  const addRange = (dirId: string) =>
    setWindows((w) => ({ ...w, [dirId]: [...getRanges(dirId), { start_time: '09:00', end_time: '17:00' }] }));
  const removeRange = (dirId: string, idx: number) =>
    setWindows((w) => ({ ...w, [dirId]: getRanges(dirId).filter((_, i) => i !== idx) }));
  const updateRange = (dirId: string, idx: number, field: keyof Range, val: string) =>
    setWindows((w) => ({ ...w, [dirId]: getRanges(dirId).map((r, i) => (i === idx ? { ...r, [field]: val } : r)) }));

  async function save(dirId: string) {
    try {
      await api.patternBlocks.set(dirId, props.dayType, getRanges(dirId));
      refetchPatternBlocks(); // refresh the Planner overlay + other store consumers
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  const fill = (tagId: string) => patternPrefs()?.prefs?.[tagId]?.auto_fill ?? true;
  async function toggleFill(tagId: string) {
    try {
      await api.patternPrefs.set(tagId, { auto_fill: !fill(tagId) });
      refetchPatternPrefs();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  return (
    <div class="flex flex-col gap-5">
      <For each={patternTagList()}>
        {(dir) => (
          <div class="flex flex-col gap-2">
            <div class="text-sm font-medium text-foreground capitalize">{dir.name}</div>
            <For each={getRanges(dir.id)}>
              {(r, i) => (
                <div class="flex items-center gap-2">
                  <input
                    type="time"
                    class="input py-1 text-sm flex-1"
                    value={r.start_time}
                    onInput={(e) => updateRange(dir.id, i(), 'start_time', e.currentTarget.value)}
                    onBlur={() => save(dir.id)}
                  />
                  <span class="text-muted-foreground text-xs">–</span>
                  <input
                    type="time"
                    class="input py-1 text-sm flex-1"
                    value={r.end_time}
                    onInput={(e) => updateRange(dir.id, i(), 'end_time', e.currentTarget.value)}
                    onBlur={() => save(dir.id)}
                  />
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-destructive transition-colors"
                    onClick={() => { removeRange(dir.id, i()); save(dir.id); }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </For>
            <button
              type="button"
              class="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors self-start"
              onClick={() => addRange(dir.id)}
            >
              <Plus size={12} /> Add window
            </button>
            <label class="flex items-start gap-2 cursor-pointer select-none mt-1">
              <button
                type="button"
                role="switch"
                aria-checked={fill(dir.id)}
                onClick={() => toggleFill(dir.id)}
                class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
                classList={{ 'bg-primary': fill(dir.id), 'bg-muted border border-border': !fill(dir.id) }}
              >
                <span
                  class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
                  classList={{ 'translate-x-4': fill(dir.id) }}
                />
              </button>
              <div>
                <div class="text-sm text-foreground leading-tight">Fill work hours</div>
                <div class="text-[11px] text-muted-foreground capitalize">
                  Auto Schedule fills open {dir.name} windows with leftover tasks
                </div>
              </div>
            </label>
          </div>
        )}
      </For>
    </div>
  );
}
