import { createSignal, createEffect, For, Show } from 'solid-js';
import { X, ChevronLeft } from 'lucide-solid';
import { api, type PlanWeekEntryBranch } from '../lib/api.js';
import { planWeekModal, setPlanWeekModal, showToast } from '../stores/index.js';

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

/** The fixed top-3 menu. Keys are T1 `entry_branch` values, so a pick maps straight through. */
const BRANCHES: { key: Extract<Step, PlanWeekEntryBranch>; label: string; question: string }[] = [
  { key: 'fill_week', label: 'Fill next week', question: 'Which days next week should I fill?' },
  { key: 'schedule_tasks', label: 'Schedule tasks', question: 'Which tasks should I find time for?' },
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
    if (open()) { setStep('menu'); setSessionId(null); }
  });

  const branch = () => BRANCHES.find((b) => b.key === step());

  /** Session open/close/append are best-effort: the log must never block the UI. */
  const pickBranch = async (key: Extract<Step, PlanWeekEntryBranch>, label: string) => {
    setStep(key); // advance first — a failed log must not strand the user on the menu
    try {
      const { session } = await api.planWeek.session.open(key);
      setSessionId(session.id);
      await api.planWeek.session.append(session.id, { role: 'user', text: label });
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const logAnswer = async (text: string) => {
    const id = sessionId();
    if (!id) return;
    try {
      await api.planWeek.session.append(id, { role: 'user', text });
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
    const id = sessionId();
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
                          class="btn-ghost text-sm justify-start"
                          onClick={() => void pickBranch(b.key, b.label)}
                        >
                          {b.label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              }
            >
              {(b) => (
                <PromptStep
                  question={b().question}
                  onSubmit={(text) => void logAnswer(text)}
                  onBack={() => setStep('menu')}
                />
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
