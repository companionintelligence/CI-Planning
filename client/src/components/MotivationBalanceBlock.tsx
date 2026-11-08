import { For, Show } from 'solid-js';
import type { MotivationBalance, MotivationMinutes } from '../lib/api.js';
import { formatDuration } from '../lib/open-time.js';

/**
 * The weekly recap's "Me, us, them" block (0176, opt-in in Settings, off by default).
 *
 * How last week's TIMED hours split between work for yourself (me), for the people you do it with
 * (us) and for others (them), for the week as a whole and per category. Read-only, no LLM.
 *
 * Reading it right, which the copy below says out loud rather than leaving to the chart:
 *  - Time on tasks with no label is "unlabeled" and is its own segment: it is never counted as us.
 *  - A task's minutes count in each of its categories, so the category rows can add up to more than
 *    the whole week. "Whole week" counts every timed minute once.
 *  - Each bar is drawn over ALL of that row's minutes, so a mostly-unlabeled row looks mostly grey
 *    instead of looking like a confident split. The three words under it carry the exact minutes.
 */

const SEGMENTS = [
  { key: 'me', label: 'me', bar: 'bg-primary' },
  { key: 'us', label: 'us', bar: 'bg-accent-hi' },
  { key: 'them', label: 'them', bar: 'bg-accent' },
  { key: 'unlabeled', label: 'unlabeled', bar: 'bg-muted' },
] as const;

function Row(props: { name: string; m: MotivationMinutes }) {
  const pct = (n: number) => (props.m.total > 0 ? (n / props.m.total) * 100 : 0);
  return (
    <div class="flex flex-col gap-1" data-testid="motivation-row">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-xs text-foreground">{props.name}</span>
        <span class="text-[11px] text-muted-foreground">{formatDuration(props.m.total)}</span>
      </div>
      {/* The words below are the data; the bar is a picture of them, so it is hidden from a screen reader. */}
      <div class="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/40" aria-hidden="true">
        <For each={SEGMENTS}>
          {(s) => <div class={s.bar} style={{ width: `${pct(props.m[s.key])}%` }} />}
        </For>
      </div>
      <span class="text-[11px] text-muted-foreground">
        <For each={SEGMENTS.filter((s) => props.m[s.key] > 0)}>
          {(s, i) => <>{i() > 0 ? ' · ' : ''}{s.label} {formatDuration(props.m[s.key])}</>}
        </For>
      </span>
    </div>
  );
}

export function MotivationBalanceBlock(props: { data: MotivationBalance }) {
  return (
    <div class="flex flex-col gap-2" data-testid="motivation-balance">
      <span class="text-[11px] text-muted-foreground">Me, us, them</span>
      <Show
        when={props.data.overall.total > 0}
        fallback={<span class="text-xs text-muted-foreground">No timed work last week.</span>}
      >
        <Row name="Whole week" m={props.data.overall} />
        <For each={props.data.categories}>{(c) => <Row name={c.category} m={c} />}</For>
        <span class="text-[11px] text-muted-foreground">
          Timed hours, by the label each task has now. Time on unlabeled tasks is shown separately. A task counts in
          each of its categories, so the rows can add up to more than the week.
        </span>
      </Show>
    </div>
  );
}
