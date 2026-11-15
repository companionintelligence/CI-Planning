import { For, Show, createResource } from 'solid-js';
import { Clock3, Sparkles } from 'lucide-solid';
import { api } from '../lib/api.js';

export function SchedulingPreferences() {
  const [snapshot] = createResource(() => api.metrics.schedulingPreferences());

  return (
    <section class="card p-5 flex flex-col gap-4" aria-label="Learned scheduling preferences">
      <div class="flex items-start gap-2.5">
        <Sparkles class="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
        <div>
          <h2 class="text-sm font-bold text-foreground">How you work</h2>
          <p class="text-[11px] text-muted-foreground mt-1">
            Learned from task completion, close ratings, recap outcomes, and the times you keep or move scheduled work.
          </p>
        </div>
        <Show when={snapshot()}>
          <span class="ml-auto text-[10px] text-muted-foreground flex-shrink-0">
            {snapshot()!.history_samples} examples · last {snapshot()!.history_days} days
          </span>
        </Show>
      </div>

      <Show when={snapshot()} fallback={<div class="text-xs text-muted-foreground">Learning your schedule…</div>}>
        {(data) => (
          <Show
            when={data().history_samples > 0}
            fallback={<div class="border-t border-border pt-3 text-xs text-muted-foreground">As you complete and rate tasks, your preferred actions and time windows will appear here.</div>}
          >
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 border-t border-border pt-3">
              <div>
                <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  <Clock3 size={12} /> Best time windows
                </div>
                <Show when={data().time_preferences.some((p) => p.samples > 0)} fallback={<p class="text-[11px] text-muted-foreground">No time-of-day history yet.</p>}>
                  <div class="flex flex-col gap-2">
                    <For each={data().time_preferences.filter((p) => p.samples > 0).slice(0, 4)}>{(pref) => (
                      <div class="grid grid-cols-[5.5rem_1fr_2.5rem] gap-2 items-center text-[11px]" title={`${pref.samples} examples · ${pref.confidence}% confidence`}>
                        <span class="text-muted-foreground">{pref.band}</span>
                        <div class="h-1.5 bg-muted overflow-hidden rounded-sm">
                          <div class="h-full bg-primary rounded-sm" style={{ width: `${pref.good_probability}%` }} />
                        </div>
                        <span class="text-right font-mono text-foreground">{pref.good_probability}%</span>
                      </div>
                    )}</For>
                  </div>
                </Show>
              </div>
              <div>
                <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Action preferences</div>
                <Show when={data().action_preferences.length > 0} fallback={<p class="text-[11px] text-muted-foreground">No repeated action types yet.</p>}>
                  <div class="flex flex-col divide-y divide-border">
                    <For each={data().action_preferences.slice(0, 5)}>{(pref) => (
                      <div class="flex items-center gap-2 py-1.5 first:pt-0">
                        <span class="text-xs text-foreground flex-1">{pref.action}</span>
                        <span class="text-[10px] text-primary">{pref.good_probability}% good fit</span>
                        <span class="text-[10px] text-muted-foreground" title={`${pref.confidence}% confidence`}>{pref.samples}× · {pref.confidence}%</span>
                        <Show when={pref.preferred_time_band}>
                          <span class="text-[10px] text-muted-foreground">· {pref.preferred_time_band?.toLowerCase()}</span>
                        </Show>
                        <Show when={pref.preferred_window_type}>
                          <span class="text-[10px] text-muted-foreground">· {pref.preferred_window_type}</span>
                        </Show>
                      </div>
                    )}</For>
                  </div>
                </Show>
              </div>
            </div>
            <p class="text-[10px] text-muted-foreground">
              “Good fit” estimates a completed task with a 4–5 close rating; unrated completions count as half evidence. Confidence rises with relevant examples.
            </p>
          </Show>
        )}
      </Show>
    </section>
  );
}
