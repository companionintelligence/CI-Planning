import { For, Show } from 'solid-js';
import { Pentagon, CalendarClock, Trash2, ArrowUpRight } from 'lucide-solid';
import { api, type Block } from '../lib/api.js';
import { concepts, refetchConcepts, refetchBlocks, prefs, showToast } from '../stores/index.js';

/**
 * The Concept horizon lane (Phase G, Step 2b). Concepts are unscheduled goals
 * (⬟, dotted) that live off the minute grid — a goal day + duration, no fixed time.
 * **Promote** turns one into a scheduled Plan today (all-day when
 * `plan_daylong_for_promoted` is set, else timed at the next half-hour, sized by the
 * concept's duration). The lane hides itself when there are no concepts.
 */

function fmtDuration(min: number | null | undefined): string {
  const m = min ?? 0;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d}d`, h && `${h}h`, mm && `${mm}m`].filter(Boolean).join(' ') || '0m';
}
function goalLabel(date: string | null | undefined): string {
  if (!date) return 'Someday';
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function nextHalfHourISO(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d.toISOString();
}
function todayMidnightISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function ConceptLane() {
  const items = () => concepts() ?? [];

  async function promote(c: Block) {
    const allDay = prefs()?.plan_daylong_for_promoted ?? false;
    const start = allDay ? todayMidnightISO() : nextHalfHourISO();
    try {
      await api.blocks.promote(c.id, start, { all_day: allDay });
      refetchConcepts();
      refetchBlocks();
      showToast(`"${c.title}" promoted to a Plan${allDay ? ' (all-day)' : ''}`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function remove(c: Block) {
    try { await api.blocks.delete(c.id); refetchConcepts(); showToast(`Deleted "${c.title}"`, 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <Show when={items().length > 0}>
      <div class="rounded-xl border border-border bg-card overflow-hidden">
        <div class="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Pentagon size={12} class="text-muted-foreground" />
          <span class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Concepts</span>
          <span class="text-[10px] text-muted-foreground">· goals, no fixed time</span>
        </div>
        <ul class="divide-y divide-border">
          <For each={items()}>
            {(c) => (
              <li class="flex items-center gap-2.5 px-3 py-2 group">
                {/* ⬟ dotted marker */}
                <span class="w-4 h-4 rounded-sm border-2 border-dotted border-muted-foreground flex-shrink-0" />
                <span class="flex-1 text-sm text-foreground truncate">{c.title}</span>
                <Show when={c.tag}>{(t) => <span class="text-primary text-xs flex-shrink-0">#{t()}</span>}</Show>
                <span class="inline-flex items-center gap-1 text-[11px] text-muted-foreground flex-shrink-0">
                  <CalendarClock size={11} /> {goalLabel(c.goal_start_date)} · {fmtDuration(c.duration_minutes)}
                </span>
                <button onClick={() => promote(c)} class="btn-secondary text-xs px-2.5 py-1 flex-shrink-0" title="Schedule as a Plan today">
                  <ArrowUpRight size={12} /> Promote
                </button>
                <button onClick={() => remove(c)} class="btn-icon opacity-0 group-hover:opacity-100 flex-shrink-0 hover:text-destructive" title="Delete concept">
                  <Trash2 size={13} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
