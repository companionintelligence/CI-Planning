import { createResource, createSignal, For, Show } from 'solid-js';
import { CalendarCog, ChevronDown, ChevronRight } from 'lucide-solid';
import { patternBlocks, refetchPatternBlocks, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';
import { SchedulePatternEditor } from './SchedulePatternEditor.js';

/**
 * T-SCHED-1 — assign a specific date's day type and edit that type's availability
 * windows, from Today and Calendar. The resolved key drives Auto placement
 * (server-side resolveDayType) and the Planner shading.
 *
 * The resolve fetch is keyed on the shared patternBlocks store signal so it refreshes
 * whenever a day-type mutation calls refetchPatternBlocks() (assign/clear/window-edit).
 */
export function DayTypeControl(props: { date: string }) {
  const [resolved] = createResource(
    () => [props.date, patternBlocks()] as const,
    ([d]) => api.dayTypes.resolve(d),
  );
  const [types] = createResource(() => api.dayTypes.list().then((r) => r.day_types));
  const [open, setOpen] = createSignal(false);

  const currentKey = () => resolved()?.key;
  const isOverride = () => resolved()?.source === 'assignment';
  const nameOf = (key?: string) => types()?.find((t) => t.key === key)?.name ?? key ?? '';

  async function choose(val: string) {
    try {
      if (val === '') await api.dayTypes.clearAssignment(props.date);
      else await api.dayTypes.assign(props.date, val);
      refetchPatternBlocks(); // re-resolve here + refresh the Planner overlay
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <CalendarCog size={13} class="text-muted-foreground" />
        <span class="text-[11px] uppercase tracking-wide text-muted-foreground">Day type</span>
        <select
          class="input w-auto py-0.5 text-sm"
          value={isOverride() ? currentKey() : ''}
          onChange={(e) => choose(e.currentTarget.value)}
        >
          <option value="">Default{currentKey() && !isOverride() ? ` · ${nameOf(currentKey())}` : ''}</option>
          <For each={types()}>{(t) => <option value={t.key}>{t.name}</option>}</For>
        </select>
        <Show when={isOverride()}>
          <span class="text-[10px] rounded-full border border-primary/40 text-primary px-1.5 py-0.5">override</span>
        </Show>
        <button
          type="button"
          class="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          onClick={() => setOpen((v) => !v)}
        >
          <Show when={open()} fallback={<ChevronRight size={13} />}><ChevronDown size={13} /></Show>
          Edit windows
        </button>
      </div>
      <Show when={open() && currentKey()}>
        <div class="rounded-lg border border-border bg-card p-3">
          <p class="text-[11px] text-muted-foreground mb-2">
            Availability windows for <span class="text-foreground">{nameOf(currentKey())}</span> — shared by every day of this type.
          </p>
          <SchedulePatternEditor dayType={currentKey()!} />
        </div>
      </Show>
    </div>
  );
}
