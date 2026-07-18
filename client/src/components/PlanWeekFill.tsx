import { createSignal, createResource, For, Show } from 'solid-js';
import { ChevronLeft } from 'lucide-solid';
import { api } from '../lib/api.js';
import { selectedDay, showToast, refetchFlightPlan, refetchBlocks } from '../stores/index.js';
import type { BranchProps } from './PlanWeekAssistant.js';

/**
 * "Fill next week" (FTUE · T3, #339) — the deterministic branch: horizon → sources →
 * preview → confirm. It writes nothing itself; confirm drives the EXISTING endpoints
 * `POST /api/auto/fill` then `POST /api/auto/run`, so there is no second placement engine
 * here and `engine/autoplan.ts` / `services/engine-ops.ts` stay untouched.
 *
 * No LLM anywhere and no `aiAvailable()` gate — this branch is always available.
 * (`autoRun` may internally use the LLM for day 0 when the owner is already in a
 * smart/hands-off trust mode; that is pre-existing engine behavior this branch neither
 * triggers nor configures. T9 owns LLM ordering.)
 *
 * SOURCE TOGGLES ARE PREVIEW-SCOPING, with one exception. Flight-plan / Objectives /
 * Recurring only change what the preview summarizes — excluding them from *placement*
 * would need engine changes, which the ticket fences off. Only **Open tasks** has a
 * confirm-side effect: it gates whether `auto/fill` runs at all.
 */

type Step = 'horizon' | 'sources' | 'preview' | 'confirm';

const SOURCES = [
  { key: 'open_tasks', label: 'Open tasks', note: 'Stages your backlog (drives fill)' },
  { key: 'flight_plan', label: 'Flight-plan', note: 'Already-staged items' },
  { key: 'objectives', label: 'Objectives', note: 'Tasks linked to an objective' },
  { key: 'recurring', label: 'Recurring', note: 'Habits & repeats (auto-place)' },
] as const;

type SourceKey = (typeof SOURCES)[number]['key'];

export function PlanWeekFill(props: BranchProps) {
  const [step, setStep] = createSignal<Step>('horizon');
  const [horizon, setHorizon] = createSignal(7);
  const [sources, setSources] = createSignal<Record<SourceKey, boolean>>({
    open_tasks: true, flight_plan: true, objectives: true, recurring: true,
  });
  const [running, setRunning] = createSignal(false);

  // Only fetched once the user reaches the preview step — the earlier steps need no data.
  const [preview] = createResource(
    () => (step() === 'preview' || step() === 'confirm' ? { horizon: horizon(), start: selectedDay() } : null),
    (p) => api.planWeek.candidates(p),
  );

  const toggle = (k: SourceKey) => setSources((s) => ({ ...s, [k]: !s[k] }));

  const goSources = () => {
    void props.append(`Horizon: ${horizon()} day${horizon() === 1 ? '' : 's'} from ${selectedDay()}`, 'plan_week:horizon');
    setStep('sources');
  };

  const goPreview = () => {
    const on = SOURCES.filter((s) => sources()[s.key]).map((s) => s.label);
    void props.append(`Sources: ${on.length ? on.join(', ') : 'none'}`, 'plan_week:sources');
    setStep('preview');
  };

  const goConfirm = () => {
    const p = preview();
    void props.append(
      p ? `Preview: ${p.open_tasks.will_stage} to stage of ${p.open_tasks.count} open, ${p.flight_plan.count} staged`
        : 'Preview: unavailable',
      'plan_week:preview',
    );
    setStep('confirm');
  };

  /** The only writing step. Mirrors FlightPlan.runSchedule's call → toast → refetch idiom. */
  const confirm = async () => {
    setRunning(true);
    try {
      // Fill stages the open backlog; skip it entirely when that source is off, so the
      // run places only what is already staged.
      if (sources().open_tasks) await api.auto.fill({});
      const { result } = await api.auto.run({ date: selectedDay(), horizon_days: horizon() });

      const span = (result.days ?? 1) > 1 ? ` across ${result.days} days` : '';
      const bits = [`Scheduled ${result.placed ?? 0}${span}`];
      if (result.unplaced) bits.push(`${result.unplaced} didn't fit`);
      showToast(bits.join(' · '), 'success');

      void props.append(
        `Confirmed: placed ${result.placed ?? 0}, unplaced ${result.unplaced ?? 0}${result.days ? `, days ${result.days}` : ''}`,
        'plan_week:confirm',
      );
      refetchFlightPlan();
      refetchBlocks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const back = () => {
    const order: Step[] = ['horizon', 'sources', 'preview', 'confirm'];
    const i = order.indexOf(step());
    if (i === 0) props.onBack(); // leave the branch entirely
    else setStep(order[i - 1]);
  };

  return (
    <div class="flex flex-col gap-3">
      <Show when={step() === 'horizon'}>
        <p class="text-sm text-foreground">How far ahead should I plan?</p>
        <label class="flex items-center gap-2">
          <input
            type="number" min="1" max="14" class="input text-sm w-20"
            value={horizon()}
            onInput={(e) => setHorizon(Math.max(1, Math.min(14, Number(e.currentTarget.value) || 1)))}
          />
          <span class="text-xs text-muted-foreground">days from {selectedDay()}</span>
        </label>
        <button type="button" class="btn-primary text-xs self-start" onClick={goSources}>Next</button>
      </Show>

      <Show when={step() === 'sources'}>
        <p class="text-sm text-foreground">What should I draw from?</p>
        <div class="flex flex-col gap-1.5">
          <For each={SOURCES}>
            {(s) => (
              <label class="flex items-start gap-2 text-sm">
                <input type="checkbox" class="mt-0.5" checked={sources()[s.key]} onChange={() => toggle(s.key)} />
                <span class="flex flex-col">
                  <span>{s.label}</span>
                  <span class="text-[11px] text-muted-foreground">{s.note}</span>
                </span>
              </label>
            )}
          </For>
        </div>
        <button type="button" class="btn-primary text-xs self-start" onClick={goPreview}>Preview</button>
      </Show>

      <Show when={step() === 'preview'}>
        <p class="text-sm text-foreground">Here's what I'd do — nothing is scheduled yet.</p>
        <Show when={preview()} fallback={<p class="text-xs text-muted-foreground">Loading…</p>}>
          {(p) => (
            <div class="flex flex-col gap-2">
              <div class="text-xs text-muted-foreground flex flex-col gap-0.5">
                <Show when={sources().open_tasks}>
                  <span>{p().open_tasks.will_stage} of {p().open_tasks.count} open tasks would be staged</span>
                </Show>
                <Show when={sources().flight_plan}><span>{p().flight_plan.count} already staged</span></Show>
                <Show when={sources().objectives}><span>{p().objectives.count} linked to objectives</span></Show>
                <Show when={sources().recurring}><span>{p().recurring.count} recurring / habits (auto-place)</span></Show>
                <Show when={p().horizon !== horizon()}>
                  <span>Horizon clamped to {p().horizon} days by the server.</span>
                </Show>
              </div>
              <Show when={sources().open_tasks && p().open_tasks.items.length}>
                <ul class="text-xs text-foreground flex flex-col gap-0.5 max-h-40 overflow-y-auto">
                  <For each={p().open_tasks.items}>{(t) => <li>· {t.title}</li>}</For>
                </ul>
              </Show>
            </div>
          )}
        </Show>
        <button type="button" class="btn-primary text-xs self-start" onClick={goConfirm}>Continue</button>
      </Show>

      <Show when={step() === 'confirm'}>
        <p class="text-sm text-foreground">
          Schedule {horizon()} day{horizon() === 1 ? '' : 's'} from {selectedDay()}?
          {sources().open_tasks ? ' Your open backlog will be staged first.' : ' Only already-staged items will be placed.'}
        </p>
        <button type="button" class="btn-primary text-xs self-start" disabled={running()} onClick={() => void confirm()}>
          {running() ? 'Scheduling…' : 'Schedule it'}
        </button>
      </Show>

      <button type="button" class="btn-ghost text-xs self-start inline-flex items-center gap-1" onClick={back}>
        <ChevronLeft size={13} /> Back
      </button>
    </div>
  );
}
