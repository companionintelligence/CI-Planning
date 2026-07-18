import { createSignal, createEffect, For, Show, type JSX } from 'solid-js';
import { X, ChevronLeft } from 'lucide-solid';
import { api, type PlanWeekEntryBranch } from '../lib/api.js';
import { planWeekModal, setPlanWeekModal, showToast } from '../stores/index.js';
import { PlanWeekFill } from './PlanWeekFill.js';
import { PlanWeekScheduleTasks } from './PlanWeekScheduleTasks.js';

/**
 * PlanWeekAssistant (FTUE · T2, #338) — the "Plan my week" shell.
 *
 * Mounted once in App's Shell and self-driven by the `planWeekModal` signal, exactly
 * like ElementWizard: it renders nothing while closed. A `currentStep` signal is the
 * whole state machine — the fixed top-3 branch menu, then one stubbed branch step.
 * Branch bodies land in T3/T4/T5; every string here is static (no LLM until T7-T9).
 *
 * WHEN THE SESSION OPENS — a deliberate deviation from this ticket's DoD.
 * The ticket says to call `session.open()` on the modal's false→true edge, before a
 * branch is chosen. That is not implementable against T1 as shipped: `entry_branch` is
 * NOT NULL and `openSession` requires it, T1 exposes no way to set it afterwards, and
 * this ticket may not change T1's schema or routes. T1's own client contract has always
 * been `open(entry_branch)` — the two drafts disagreed with each other.
 *
 * So the session opens when the user picks a branch, which is the first moment the
 * required value exists. Dismissing the menu without choosing writes no session at all
 * — better than a row stamped with a fabricated branch.
 */

type Step = 'menu' | PlanWeekEntryBranch;
type BranchKey = Extract<Step, PlanWeekEntryBranch>;

/**
 * What a branch component receives from the shell. `append` is the T1 transcript seam:
 * it resolves the pending session first, so a branch may log from its very first render
 * without racing `session.open()` (see `sessionP` below).
 */
export interface BranchProps {
  append: (text: string, kind?: string) => Promise<void>;
  onBack: () => void;
}

/**
 * The fixed top-3 menu. Keys are T1 `entry_branch` values so a pick maps straight to the
 * column — T3's draft proposed `fill-next-week`, which would 422 against T1's enum.
 * A branch either supplies a `component` (real behavior) or just a `question` (stub).
 */
const BRANCHES: {
  key: BranchKey;
  label: string;
  subtitle?: string;
  question?: string;
  component?: (props: BranchProps) => JSX.Element;
}[] = [
  { key: 'fill_week', label: 'Fill next week', subtitle: 'Deterministic — no AI', component: (p) => <PlanWeekFill {...p} /> },
  { key: 'schedule_tasks', label: 'Schedule tasks', subtitle: 'One at a time — no AI', component: (p) => <PlanWeekScheduleTasks {...p} /> },
  { key: 'review', label: 'Review past data', question: 'What would you like to review?' },
];

/**
 * The reusable conversation primitive: a question, up to three option chips, and a
 * free-text input. T3/T4/T5 drive real flows through it; here each branch renders one.
 * Caps at three chips by contract, so a caller passing more cannot break the layout.
 */
export function PromptStep(props: {
  question: string;
  options?: { label: string; onSelect: () => void }[];
  onSubmit?: (text: string) => void;
  onBack?: () => void;
}) {
  const [text, setText] = createSignal('');

  const submit = () => {
    const value = text().trim();
    if (!value) return;
    props.onSubmit?.(value);
    setText('');
  };

  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm text-foreground">{props.question}</p>

      <Show when={props.options?.length}>
        <div class="flex flex-wrap gap-2">
          <For each={props.options!.slice(0, 3)}>
            {(opt) => (
              <button type="button" class="btn-ghost text-xs" onClick={opt.onSelect}>
                {opt.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <input
        class="input text-sm"
        placeholder="Or type your answer…"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />

      <Show when={props.onBack}>
        <button type="button" class="btn-ghost text-xs self-start inline-flex items-center gap-1" onClick={() => props.onBack!()}>
          <ChevronLeft size={13} /> Back
        </button>
      </Show>
    </div>
  );
}

export function PlanWeekAssistant() {
  const open = () => planWeekModal().open;
  const [step, setStep] = createSignal<Step>('menu');
  const [sessionId, setSessionId] = createSignal<string | null>(null);

  // Reset on every open so a reopened shell never inherits the last run's branch or id.
  createEffect(() => {
    if (open()) { setStep('menu'); setSessionId(null); sessionP = Promise.resolve(null); }
  });

  const branch = () => BRANCHES.find((b) => b.key === step());

  /**
   * The in-flight `session.open()`. A branch component mounts the instant its key is
   * selected — before the POST resolves — so `append` awaits THIS rather than reading the
   * `sessionId` signal. Reading the signal would silently drop any entry logged in that
   * window, which is exactly the first step of a multi-step branch (T3 logs on entry).
   */
  let sessionP: Promise<string | null> = Promise.resolve(null);

  /** Session open/close/append are best-effort: the log must never block the UI. */
  const pickBranch = (key: BranchKey, label: string) => {
    setStep(key); // advance first — a failed log must not strand the user on the menu
    sessionP = api.planWeek.session
      .open(key)
      .then(({ session }) => { setSessionId(session.id); return session.id; })
      .catch((err: Error) => { showToast(err.message, 'error'); return null; });
    void append(label, `plan_week:${key}`);
  };

  const append = async (text: string, kind?: string) => {
    const id = await sessionP;
    if (!id) return; // open() failed — already toasted; the branch keeps working
    try {
      await api.planWeek.session.append(id, { role: 'user', text, ...(kind ? { kind } : {}) });
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  /**
   * `completed` when the user finishes via Done, `abandoned` when they dismiss mid-flow —
   * T1's status enum exists precisely to tell those apart, and without this every dropped
   * session would sit `open` with a null `ended_at` forever, filling T6's Logs tab with
   * rows that never resolve. The modal always closes locally, even if the close call fails.
   */
  const close = async (status: 'completed' | 'abandoned') => {
    const id = await sessionP; // may still be in flight if the user is quick
    if (id) {
      try {
        await api.planWeek.session.close(id, { status });
      } catch (err) {
        showToast((err as Error).message, 'error');
      }
    }
    setPlanWeekModal({ open: false });
  };

  return (
    <Show when={open()}>
      <div class="modal-backdrop" onClick={() => void close('abandoned')}>
        <div class="modal max-w-lg" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div class="px-4 py-3 border-b border-border flex items-center justify-between">
            <span class="text-sm font-semibold text-foreground">Plan my week</span>
            <button class="btn-icon" aria-label="Close" onClick={() => void close('abandoned')}>
              <X size={15} />
            </button>
          </div>

          {/* Body */}
          <div class="p-4 flex flex-col gap-3">
            <Show
              when={branch()}
              fallback={
                <div class="flex flex-col gap-3">
                  <p class="text-sm text-foreground">What would you like to do?</p>
                  <div class="flex flex-col gap-2">
                    <For each={BRANCHES}>
                      {(b) => (
                        <button
                          type="button"
                          class="btn-ghost text-sm justify-start flex-col items-start gap-0.5 py-2"
                          onClick={() => pickBranch(b.key, b.label)}
                        >
                          <span>{b.label}</span>
                          <Show when={b.subtitle}>
                            <span class="text-[11px] text-muted-foreground font-normal">{b.subtitle}</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              }
            >
              {(b) => (
                <Show
                  when={b().component}
                  fallback={
                    <PromptStep
                      question={b().question!}
                      onSubmit={(text) => void append(text)}
                      onBack={() => setStep('menu')}
                    />
                  }
                >
                  {(Comp) => Comp()({ append, onBack: () => setStep('menu') })}
                </Show>
              )}
            </Show>
          </div>

          {/* Footer */}
          <div class="px-4 py-3 border-t border-border flex justify-end gap-2">
            <button type="button" class="btn-primary text-xs" onClick={() => void close('completed')}>
              Done
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
