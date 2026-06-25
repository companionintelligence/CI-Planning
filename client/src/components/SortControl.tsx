import { For, Show } from 'solid-js';

/**
 * Shared sort control: a Priority ⇄ Due Date segmented toggle plus an optional
 * direction (pattern-tag) dropdown. Presentational only — it reads nothing and
 * writes nothing; callers own the state and the sorting (see lib/sort.ts).
 *
 * Visual parity with the legacy inline toggle in FlightPlan.tsx so the Tasks view
 * (T-TASKS-4) and the Flight-plan (T-FP-2) look identical.
 */

export type SortOrder = 'priority' | 'due';

export interface SortControlProps {
  order: SortOrder;
  onOrder: (o: SortOrder) => void;
  /** Show the direction dropdown (Tasks view). Omit for the Flight-plan. */
  showDirection?: boolean;
  /** Selected direction name; '' = All. */
  direction?: string;
  /** Pattern-tag names to offer (e.g. Home / Work / Community). */
  directions?: string[];
  onDirection?: (d: string) => void;
}

export function SortControl(props: SortControlProps) {
  return (
    <div class="flex items-center gap-2">
      <div
        class="inline-flex rounded-full border border-border overflow-hidden text-[11px] flex-shrink-0"
        role="group"
        title="Priority: highest-priority first. Due Date: nearest due date first."
      >
        <button
          type="button"
          onClick={() => props.onOrder('priority')}
          class="px-2 py-0.5 transition-colors"
          classList={{
            'bg-primary text-primary-foreground': props.order === 'priority',
            'text-muted-foreground hover:text-foreground': props.order !== 'priority',
          }}
        >
          Priority
        </button>
        <button
          type="button"
          onClick={() => props.onOrder('due')}
          class="px-2 py-0.5 transition-colors"
          classList={{
            'bg-primary text-primary-foreground': props.order === 'due',
            'text-muted-foreground hover:text-foreground': props.order !== 'due',
          }}
        >
          Due Date
        </button>
      </div>

      <Show when={props.showDirection}>
        <select
          class="input py-0.5 text-[11px]"
          value={props.direction ?? ''}
          onChange={(e) => props.onDirection?.(e.currentTarget.value)}
          title="Filter / group by direction"
        >
          <option value="">All directions</option>
          <For each={props.directions ?? []}>{(d) => <option value={d}>{d}</option>}</For>
        </select>
      </Show>
    </div>
  );
}
