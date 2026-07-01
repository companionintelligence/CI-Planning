import { For, Show, createResource, onCleanup } from 'solid-js';
import { Star } from 'lucide-solid';
import { api } from '../lib/api.js';
import { starSlots, STAR_GOLD } from '../lib/stars.js';
import { tasks, scheduledByTaskId } from '../stores/index.js';
import { on as onSse } from '../lib/sse.js';

/**
 * Phase O · O3 — the header's small day-stars tally.
 *
 * ~14px 5-pointed stars, gold (#f4d35e) when earned / muted teal-navy when empty,
 * plus an `n/5` count. Reads today's LIVE stars from GET /api/stars (a frozen
 * past day returns the same value; today recomputes). Deliberately understated —
 * the calendar is where stars are celebrated; the header is just today's running
 * tally. Tapping a star shows a what's-needed hint (title tooltip). Visually
 * distinct from the objective EightPointStar by shape (5-point), color (gold),
 * and clustering.
 *
 * Reactivity (the spec's "header updates as you check things off"): the resource
 * is keyed on the store signals that move today's live stars — task completions
 * (S2/S3/S4/S5) via `tasks()`, and planning/placement (S3/S4) via
 * `scheduledByTaskId()`. Reflection changes (the intention's done state → S1, the
 * day note → S5) don't flow through a store, so a reflection SSE event refetches.
 * A past (frozen) day returns the same value regardless, so this never flickers.
 */
export function DayStarsRow(props: { date: string }) {
  const [stars, { refetch }] = createResource(
    () => [props.date, tasks(), scheduledByTaskId()] as const,
    async ([d]) => {
      try {
        const rows = await api.stars.range(d, d);
        return rows[0] ?? null;
      } catch {
        return null;
      }
    },
  );

  // The intention done-state (S1) and day note (S5) are written via the
  // reflections routes, which broadcast reflection:updated / reflection:deleted.
  // Those don't touch the tasks store, so subscribe and refetch on them.
  const offUpdated = onSse('reflection:updated', () => void refetch());
  const offDeleted = onSse('reflection:deleted', () => void refetch());
  onCleanup(() => { offUpdated(); offDeleted(); });

  const slots = () => (stars() ? starSlots(stars()!) : []);
  const total = () => stars()?.total ?? 0;

  return (
    <Show when={stars()}>
      <div class="flex items-center gap-1" title={`${total()} of 5 stars today`}>
        <div class="flex items-center gap-0.5">
          <For each={slots()}>
            {(slot) => (
              <button
                type="button"
                class="leading-none"
                title={`${slot.earned ? '★ ' : ''}${slot.hint}`}
                aria-label={slot.hint}
              >
                <Star size={14} color={slot.color} fill={slot.earned ? STAR_GOLD : 'none'} />
              </button>
            )}
          </For>
        </div>
        <span class="text-[11px] tabular-nums text-muted-foreground ml-0.5">{total()}/5</span>
      </div>
    </Show>
  );
}
