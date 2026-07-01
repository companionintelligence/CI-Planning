import { For, Show, createResource } from 'solid-js';
import { Star } from 'lucide-solid';
import { api } from '../lib/api.js';
import { starSlots, STAR_GOLD } from '../lib/stars.js';

/**
 * Phase O · O3 — the header's small day-stars tally.
 *
 * ~14px 5-pointed stars, gold (#f4d35e) when earned / muted teal-navy when empty,
 * plus an `n/5` count. Reads today's LIVE stars from GET /api/stars (never
 * recomputes). Deliberately understated — the calendar is where stars are
 * celebrated; the header is just today's running tally. Tapping a star shows a
 * what's-needed hint (title tooltip). Visually distinct from the objective
 * EightPointStar by shape (5-point), color (gold), and clustering.
 */
export function DayStarsRow(props: { date: string }) {
  const [stars] = createResource(
    () => props.date,
    async (d) => {
      try {
        const rows = await api.stars.range(d, d);
        return rows[0] ?? null;
      } catch {
        return null;
      }
    },
  );

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
