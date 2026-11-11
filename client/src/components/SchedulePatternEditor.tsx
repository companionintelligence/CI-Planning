import { createSignal, createEffect, createResource, For, Show } from 'solid-js';
import { Plus, Trash2 } from 'lucide-solid';
import { A } from '@solidjs/router';
import { tags, patternPrefs, refetchPatternPrefs, refetchPatternBlocks, refetchDayConflicts, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';

/**
 * Per-direction availability windows (Pattern-blocks) for ONE day type, plus the
 * per-direction "fill work hours" and "show free windows" toggles (the latter gates
 * whether this direction's windows appear on the Today "Open Time" card). Mounts in
 * Settings (T-SCHED-4), Today and Calendar (T-SCHED-1). As of T-SCHED-3/4 it targets
 * any day-type **key** (builtin workday/weekend or a custom one), fetching that key's
 * windows directly rather than reading the two-key store — so a custom day type can
 * own its own windows.
 *
 * Local edit state is keyed by dirTagId, seeded from the fetch and re-seeded only when
 * `dayType` changes; edits commit to the server on blur (and refresh dependents via
 * refetchPatternBlocks), so editing never clobbers an in-progress change.
 */

interface Range { start_time: string; end_time: string }

export interface SchedulePatternEditorProps {
  dayType: string;
  /** When present, edits are stored as overrides for this date only. */
  date?: string;
}

export function SchedulePatternEditor(props: SchedulePatternEditorProps) {
  const patternTagList = () => (tags() ?? []).filter((t) => t.kind === 'direction');

  // The date variant includes its resolved defaults and any existing overrides.
  const [data, { refetch }] = createResource(
    () => [props.dayType, props.date] as const,
    async ([dayType, date]) => date
      ? api.patternBlocks.forDate(date)
      : { windows: (await api.patternBlocks.forDay(dayType)).windows, overriddenDirections: [] as string[] },
  );
  const overriddenDirections = () => data()?.overriddenDirections ?? [];

  const [windows, setWindows] = createSignal<Record<string, Range[]>>({});
  createEffect(() => {
    const w = data()?.windows;
    if (!w) return;
    const out: Record<string, Range[]> = {};
    for (const [dirId, ranges] of Object.entries(w)) out[dirId] = ranges.map((r) => ({ start_time: r.start_time, end_time: r.end_time }));
    setWindows(out);
  });

  const getRanges = (dirId: string) => windows()[dirId] ?? [];
  const addRange = (dirId: string) => {
    const next = [...getRanges(dirId), { start_time: '09:00', end_time: '17:00' }];
    setWindows((w) => ({ ...w, [dirId]: next }));
    void save(dirId, next);
  };
  const removeRange = (dirId: string, idx: number) =>
    setWindows((w) => ({ ...w, [dirId]: getRanges(dirId).filter((_, i) => i !== idx) }));
  const updateRange = (dirId: string, idx: number, field: keyof Range, val: string) =>
    setWindows((w) => ({ ...w, [dirId]: getRanges(dirId).map((r, i) => (i === idx ? { ...r, [field]: val } : r)) }));

  async function save(dirId: string, ranges = getRanges(dirId)) {
    try {
      if (props.date) await api.patternBlocks.setForDate(dirId, props.date, ranges);
      else await api.patternBlocks.set(dirId, props.dayType, ranges);
      await refetch();
      refetchPatternBlocks(); // refresh the Planner overlay + other store consumers
      if (props.date) refetchDayConflicts();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function resetDate() {
    if (!props.date) return;
    try {
      await api.patternBlocks.clearDate(props.date);
      await refetch();
      refetchPatternBlocks();
      refetchDayConflicts();
      showToast('This day now uses its default windows', 'success');
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

  // Today's "Open Time" card lists whichever directions this is true for — default
  // on for every direction (including home), so a direction only drops off the card
  // once its own toggle here is turned off.
  const showOpenTime = (tagId: string) => patternPrefs()?.prefs?.[tagId]?.show_open_time ?? true;
  async function toggleShowOpenTime(tagId: string) {
    try {
      await api.patternPrefs.set(tagId, { show_open_time: !showOpenTime(tagId) });
      refetchPatternPrefs();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  return (
    <div class="flex flex-col gap-5">
      <Show when={props.date}>
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <span class="text-[11px] text-muted-foreground">Overrides apply to this date only.</span>
          <div class="flex flex-wrap items-center gap-3">
            <A href="/settings?tab=preferences#schedule-patterns" class="text-[11px] text-primary hover:underline">Default schedule settings</A>
            <Show when={overriddenDirections().length > 0}>
              <button type="button" class="text-[11px] text-muted-foreground hover:text-foreground" onClick={resetDate}>
                Reset this day
              </button>
            </Show>
          </div>
        </div>
      </Show>
      <For each={patternTagList()}>
        {(dir) => (
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2 text-sm font-medium text-foreground capitalize">
              {dir.name}
              <Show when={overriddenDirections().includes(dir.id)}>
                <span class="text-[9px] font-normal uppercase tracking-wide text-primary">day override</span>
              </Show>
            </div>
            <For each={getRanges(dir.id)}>
              {(r, i) => (
                <div class="flex items-center gap-2">
                  <div class={`flex min-w-0 flex-1 ${props.date ? 'flex-col items-stretch' : 'items-center'} gap-2`}>
                    <input
                      type="time"
                      class={`input py-1 text-sm min-w-0 ${props.date ? 'w-full' : 'flex-1'}`}
                      value={r.start_time}
                      aria-label={`${dir.name} window start`}
                      onInput={(e) => updateRange(dir.id, i(), 'start_time', e.currentTarget.value)}
                      onBlur={() => save(dir.id)}
                    />
                    <span class={`text-muted-foreground text-xs ${props.date ? 'self-center' : ''}`}>{props.date ? 'to' : '–'}</span>
                    <input
                      type="time"
                      class={`input py-1 text-sm min-w-0 ${props.date ? 'w-full' : 'flex-1'}`}
                      value={r.end_time}
                      aria-label={`${dir.name} window end`}
                      onInput={(e) => updateRange(dir.id, i(), 'end_time', e.currentTarget.value)}
                      onBlur={() => save(dir.id)}
                    />
                  </div>
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-destructive transition-colors"
                    onClick={() => {
                      const next = getRanges(dir.id).filter((_, idx) => idx !== i());
                      setWindows((w) => ({ ...w, [dir.id]: next }));
                      void save(dir.id, next);
                    }}
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
            <Show when={!props.date}><label class="flex items-start gap-2 cursor-pointer select-none mt-1">
              <button
                type="button"
                role="switch"
                aria-checked={fill(dir.id)}
                onClick={() => toggleFill(dir.id)}
                class="relative w-9 h-5 rounded-sm transition-colors flex-shrink-0 mt-0.5"
                classList={{ 'bg-primary': fill(dir.id), 'bg-muted border border-border': !fill(dir.id) }}
              >
                <span
                  class="absolute top-0.5 left-0.5 w-4 h-4 rounded-circle bg-card transition-transform"
                  classList={{ 'translate-x-4': fill(dir.id) }}
                />
              </button>
              <div>
                {/* The label names the direction this row is for. It read "work" for
                    every direction, so the Home and Community rows both claimed to be
                    about work hours — the subtext below already interpolated correctly. */}
                <div class="text-sm text-foreground leading-tight capitalize">Fill {dir.name} hours</div>
                <div class="text-[11px] text-muted-foreground capitalize">
                  Auto Schedule fills open {dir.name} windows with leftover tasks
                </div>
              </div>
            </label></Show>
            <Show when={!props.date}><label class="flex items-start gap-2 cursor-pointer select-none">
              <button
                type="button"
                role="switch"
                aria-checked={showOpenTime(dir.id)}
                onClick={() => toggleShowOpenTime(dir.id)}
                class="relative w-9 h-5 rounded-sm transition-colors flex-shrink-0 mt-0.5"
                classList={{ 'bg-primary': showOpenTime(dir.id), 'bg-muted border border-border': !showOpenTime(dir.id) }}
              >
                <span
                  class="absolute top-0.5 left-0.5 w-4 h-4 rounded-circle bg-card transition-transform"
                  classList={{ 'translate-x-4': showOpenTime(dir.id) }}
                />
              </button>
              <div>
                <div class="text-sm text-foreground leading-tight capitalize">Show {dir.name} free windows</div>
                <div class="text-[11px] text-muted-foreground capitalize">
                  Today's Open Time card lists this direction's free windows
                </div>
              </div>
            </label></Show>
          </div>
        )}
      </For>
    </div>
  );
}
