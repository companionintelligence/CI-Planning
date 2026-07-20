import { createSignal, createResource, For, Show } from 'solid-js';
import { ChevronLeft } from 'lucide-solid';
import { api, type Task } from '../lib/api.js';
import { localISODate } from '../lib/dates.js';
import {
  showToast, selectedDay, flightPlanTaskIds, aiAvailable,
  refetchFlightPlan, refetchBlocks, refetchTasks,
} from '../stores/index.js';
import type { BranchProps } from './PlanWeekAssistant.js';
import { InstructBox } from './InstructBox.js';

/**
 * "Schedule tasks" (FTUE · T4, #340) — the deterministic one-at-a-time branch: list the
 * owner's undated open tasks, pick one, then either date it manually or hand it to Auto.
 * Client-only; every API method already existed. No LLM, no task creation, no new route.
 *
 * THE HONESTY RULE THIS BRANCH IS BUILT AROUND (verified, not assumed):
 * `api.tasks.update({ scheduled_for, task_time })` on an UNPLACED task only *dates* it —
 * it does not create a Planner block. `updateTask` calls `syncBlockFromTask`, which bails
 * with `null` when the task has no existing planned block (block-task-sync.ts:275). Only
 * Auto (or quick-add / create-with-auto_place) materializes a block. So the two actions
 * say different things on purpose: "Set" reports a DATE, "Let Auto place it" reports a
 * BLOCK. Never let the manual path claim a calendar entry appeared.
 *
 * Placement is likewise derived, not assumed: after `auto.run` this task counts as placed
 * only if it is ABSENT from the returned flight_plan. `result.placed` is an aggregate and
 * may include other pre-staged items, so it cannot answer "did MY task land?".
 *
 * Props are T2's shipped `BranchProps`. The ticket sketched
 * `{ appendTranscript({role:'assistant'|'action', text}), onDone }`, but T1 validates
 * roles against {'system','user'} and 422s anything else — hence the shell's own seam.
 *
 * T7 HYBRID LAYER — wired here only. T7 assumed every branch has a generic
 * "fixed deterministic question + top-3 options" moment to enhance; only this
 * branch's "Which task should I find time for?" step actually has that shape (T3 is
 * a multi-field wizard — horizon number, source checkboxes — with no such moment, and
 * T5 is a read-only recap with no question at all). ADDITIVE, not a restructure: the
 * full candidate list below is untouched; the top-3 AI chips are a shortcut on top of
 * it, gated on `aiAvailable()` and on there being exactly 3 candidates (the endpoint
 * requires exactly 3 `fallbackOptions`). Chip label i always traces back to
 * `topThree()[i]` by array position — `renderCopy` only rephrases the seed string, it
 * never reorders — so a model rewrite of the label can never pick the wrong task.
 */

/** Undated, schedulable, not already staged — the only things this branch can act on. */
function schedulable(tasks: Task[], staged: Set<string>): Task[] {
  return tasks.filter(
    (t) => !t.scheduled_for && !t.is_habit && !t.recurrence_rule && !t.recurrence_parent_id && !staged.has(t.id),
  );
}

export function PlanWeekScheduleTasks(props: BranchProps) {
  // Local resource on purpose: mutating the global `taskFilter` would perturb AllTasks.
  const [openTasks, { refetch }] = createResource(() => api.tasks.list({ status: 'open' }));
  const [picked, setPicked] = createSignal<Task | null>(null);
  const [day, setDay] = createSignal(localISODate());
  const [time, setTime] = createSignal('');
  const [running, setRunning] = createSignal(false);

  const candidates = () => schedulable(openTasks()?.tasks ?? [], flightPlanTaskIds());

  // T7: the top-3 AI chip layer. `suggestKey` is a stable joined-id string (not the
  // array itself) so the resource only re-fetches when the actual top-3 changes.
  const topThree = () => candidates().slice(0, 3);
  const suggestKey = () => (aiAvailable() && topThree().length === 3 ? topThree().map((t) => t.id).join(',') : '');

  const [suggestion] = createResource(
    () => suggestKey() || null,
    async () => {
      const top = topThree();
      // Soft-degrade on any transport failure: fall through to the static question +
      // full list below rather than surfacing an error for a nice-to-have suggestion.
      try {
        const res = await api.planWeek.nextStep({
          branch: 'schedule_tasks',
          context: { openCount: candidates().length },
          fallbackQuestion: 'Which task should I find time for?',
          fallbackOptions: top.map((t) => t.title),
        });
        void props.append(`Suggested: ${res.question} (${res.source})`, 'plan_week:next_step');
        // #387: llm_used mirrors the server-reported source — a 'fallback' rewrite
        // used no model even though aiAvailable() gated the request.
        if (res.source === 'model') props.reportAiUse();
        return { ...res, tasks: top };
      } catch {
        return null;
      }
    },
  );

  const afterPlacement = () => {
    setPicked(null);
    setTime('');
    void refetch();
    refetchTasks();
  };

  /** Manual: give the task a day (and optional time). Dates only — no block. */
  const setDate = async () => {
    const t = picked();
    if (!t || running()) return;
    setRunning(true);
    try {
      // Explicit null clears the time; `undefined` would be dropped by JSON.stringify
      // and silently no-op server-side.
      await api.tasks.update(t.id, { scheduled_for: day(), task_time: time() || null });
      const when = time() ? `${day()} at ${time()}` : day();
      showToast(`Scheduled for ${when}`, 'success');
      void props.append(`Scheduled "${t.title}" for ${when}`, 'plan_week:schedule_set');
      afterPlacement();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  /** Auto: stage it, make sure it's selected, then run. This one really does place. */
  const autoPlace = async () => {
    const t = picked();
    if (!t || running()) return;
    setRunning(true);
    try {
      const staged = await api.flightPlan.addTask(t.id);
      // addTask can land unselected; an unselected staged item is skipped by the run.
      if (staged.flight_plan.find((i) => i.task_id === t.id)?.selected === false) {
        await api.flightPlan.update(t.id, { selected: true });
      }
      const after = await api.auto.run({ date: selectedDay() });

      // Absence from the post-run staging list is the only reliable signal for THIS task.
      const placed = !after.flight_plan.some((i) => i.task_id === t.id);
      if (placed) {
        showToast(`Placed "${t.title}"`, 'success');
        void props.append(`Auto placed "${t.title}"`, 'plan_week:schedule_auto');
      } else {
        showToast(`"${t.title}" didn't fit — it stays staged`, 'default');
        void props.append(`Auto could not fit "${t.title}"; left staged`, 'plan_week:schedule_auto');
      }
      refetchFlightPlan();
      refetchBlocks();
      afterPlacement();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <Show when={!picked()}>
        <p class="text-sm text-foreground">{suggestion()?.question ?? 'Which task should I find time for?'}</p>

        <Show when={suggestion()?.options.length}>
          <div class="flex flex-wrap gap-2">
            <For each={suggestion()!.options}>
              {(label, i) => (
                <button type="button" class="btn-ghost text-xs" onClick={() => setPicked(suggestion()!.tasks[i()])}>
                  {label}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* #387: free-text constraints ("block off Tuesday mornings…") — parsed to a
            preview, applied only on explicit confirm. */}
        <InstructBox date={selectedDay} append={props.append} reportAiUse={props.reportAiUse} />

        <Show when={!openTasks.loading} fallback={<p class="text-xs text-muted-foreground">Loading…</p>}>
          <Show
            when={candidates().length}
            fallback={
              <div class="flex flex-col gap-2">
                <p class="text-xs text-muted-foreground">Nothing to schedule — every open task already has a day.</p>
                <button type="button" class="btn-ghost text-xs self-start" onClick={props.onBack}>Back to menu</button>
              </div>
            }
          >
            <ul class="flex flex-col gap-1 max-h-56 overflow-y-auto">
              <For each={candidates()}>
                {(t) => (
                  <li>
                    <button
                      type="button"
                      class="btn-ghost text-sm w-full justify-start flex-col items-start gap-0.5 py-1.5"
                      onClick={() => setPicked(t)}
                    >
                      <span>{t.title}</span>
                      <Show when={t.estimated_minutes}>
                        <span class="text-[11px] text-muted-foreground font-normal">{t.estimated_minutes}m</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>

      <Show when={picked()}>
        {(t) => (
          <div class="flex flex-col gap-3">
            <p class="text-sm text-foreground">{t().title}</p>

            <div class="flex items-center gap-2">
              <input
                type="date" class="input text-sm" aria-label="Day"
                value={day()} onInput={(e) => setDay(e.currentTarget.value)}
              />
              <input
                type="time" step={900} class="input text-sm" aria-label="Time"
                value={time()} onInput={(e) => setTime(e.currentTarget.value)}
              />
            </div>

            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn-primary text-xs" disabled={running()} onClick={() => void setDate()}>
                Set
              </button>
              <button type="button" class="btn-ghost text-xs" disabled={running()} onClick={() => void autoPlace()}>
                Let Auto place it
              </button>
            </div>

            {/* The distinction the ticket insists on: Set dates, Auto places. The second
                line is load-bearing honesty — Auto runs against the day the cockpit is on
                (selectedDay), NOT the day/time typed above, and silently ignoring a value
                the user just entered is worse than saying so. */}
            <p class="text-[11px] text-muted-foreground">
              “Set” gives it the day and time above. “Let Auto place it” ignores them and
              finds a slot on {selectedDay()}, adding it to your calendar.
            </p>

            <button type="button" class="btn-ghost text-xs self-start" onClick={() => setPicked(null)}>
              Pick another
            </button>
          </div>
        )}
      </Show>

      <button type="button" class="btn-ghost text-xs self-start inline-flex items-center gap-1" onClick={props.onBack}>
        <ChevronLeft size={13} /> Back
      </button>
    </div>
  );
}
