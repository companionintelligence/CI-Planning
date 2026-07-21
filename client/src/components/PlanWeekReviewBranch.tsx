import { createResource, For, Show } from 'solid-js';
import { ChevronLeft } from 'lucide-solid';
import { api } from '../lib/api.js';
import { WeeklyReview } from './WeeklyReview.js';
import type { BranchProps } from './PlanWeekAssistant.js';

/**
 * "Review past data" (FTUE · T5, #341) — the deterministic weekly recap.
 *
 * Strictly READ-ONLY: it renders what already happened and offers no edit affordance.
 * No LLM anywhere, so it renders in full with Ollama offline — turning this into prose is
 * T10's job.
 *
 * One `createResource` over `GET /api/plan-week/review`, which composes the whole week
 * server-side. That is the point of the endpoint: the alternative was four or five
 * round-trips, as many loading states, and re-deriving the Mon→Sun week range in the
 * browser just to query stars.
 *
 * The stats block reuses the existing `WeeklyReview` presentational component rather than
 * re-laying-out the same numbers — it already takes `{ data, calibration }`, which is
 * exactly the shape the endpoint returns.
 */
export function PlanWeekReviewBranch(props: BranchProps) {
  // Defaults to the week that just ended (the server picks the anchor).
  const [review] = createResource(() => api.planWeek.review());

  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm text-foreground">Here's how last week went.</p>

      <Show when={!review.loading} fallback={<p class="text-xs text-muted-foreground">Loading…</p>}>
        {/* `review.error` must be checked BEFORE reading review(): Solid re-throws the
            error on access, so testing review() first would escape this inline fallback
            and surface as the root ErrorBoundary's generic panel instead of this
            in-context message. */}
        <Show
          when={!review.error}
          fallback={<p class="text-xs text-muted-foreground">Couldn't load the review.</p>}
        >
        <Show
          when={review()}
          fallback={<p class="text-xs text-muted-foreground">Couldn't load the review.</p>}
        >
          {(r) => (
            <div class="flex flex-col gap-3 max-h-72 overflow-y-auto">
              <WeeklyReview data={r().week} calibration={r().calibration} />

              {/* Five-star days — one line per day that actually scored. */}
              <Show when={r().stars.some((s) => s.total > 0)}>
                <div class="flex flex-col gap-0.5">
                  <span class="text-[11px] text-muted-foreground">Stars</span>
                  <For each={r().stars.filter((s) => s.total > 0)}>
                    {(s) => (
                      <span class="text-xs text-foreground">
                        {s.date} — {s.total}/5{s.frozen ? '' : ' (live)'}
                      </span>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={r().note_dates.length}>
                <span class="text-xs text-muted-foreground">
                  Day notes on {r().note_dates.length} day{r().note_dates.length === 1 ? '' : 's'}
                </span>
              </Show>

              {/* T1's own history — what planning you actually did that week. */}
              <div class="flex flex-col gap-0.5">
                <span class="text-[11px] text-muted-foreground">Planning sessions</span>
                <Show
                  when={r().sessions.length}
                  fallback={<span class="text-xs text-muted-foreground">None last week.</span>}
                >
                  <For each={r().sessions}>
                    {(s) => (
                      <span class="text-xs text-foreground">
                        {s.started_at.slice(0, 10)} — {s.entry_branch.replace(/_/g, ' ')} ({s.status})
                      </span>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          )}
        </Show>
        </Show>
      </Show>

      <button type="button" class="btn-ghost text-xs self-start inline-flex items-center gap-1" onClick={props.onBack}>
        <ChevronLeft size={13} /> Back
      </button>
    </div>
  );
}
