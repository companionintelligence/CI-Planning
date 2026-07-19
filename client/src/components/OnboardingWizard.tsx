import { createSignal, createResource, createEffect, For, Show } from 'solid-js';
import { api } from '../lib/api.js';
import { prefs, refetchPrefs, showToast } from '../stores/index.js';

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();

type TrustMode = 'cautious' | 'balanced' | 'hands_off';

const TRUST_OPTIONS: { value: TrustMode; label: string; hint: string }[] = [
  { value: 'cautious', label: 'Cautious', hint: 'Review everything yourself' },
  { value: 'balanced', label: 'Balanced', hint: 'High-confidence items auto-promote' },
  { value: 'hands_off', label: 'Hands-off', hint: 'Auto-promote and auto-schedule estimate-bearing work' },
];

/**
 * FTUE · T11 (#347) — the first-run onboarding overlay: identity, time + place, trust
 * dial (docs/ftue-plan.md §5 steps 1/2/4; steps 3/5 — connect a source, first sync —
 * are T12). Gated on the owner's own `onboarded_at` flag (0132), never on route, so it
 * covers every screen the same way `ElementWizard` does.
 *
 * T2 ("Plan my week") defines no exported, form-generic stepper to reuse: its
 * `PlanWeekAssistant` is a self-contained modal driven by its own fixed 3-branch menu,
 * and its one exported primitive (`PromptStep`) is a question+chips+free-text shape —
 * not remotely suited to name/email fields, a TZ confirm + two time inputs, or a
 * 3-option dial. This owns its own small step signal instead of forcing a fake reuse.
 */
export function OnboardingWizard() {
  const shouldOnboard = () => {
    const p = prefs();
    return p !== undefined && p !== null && p.onboarded_at == null;
  };

  const [step, setStep] = createSignal<1 | 2 | 3>(1);
  const [busy, setBusy] = createSignal(false);

  const [me] = createResource(() => api.auth.me().catch(() => null));

  // Step 1 — identity
  const [name, setName] = createSignal('');
  const [email, setEmail] = createSignal('');
  createEffect(() => {
    const m = me();
    if (m) { setName(m.name ?? ''); setEmail(m.email ?? ''); }
  });

  // Step 2 — time + place
  const [workdayStart, setWorkdayStart] = createSignal('09:00');
  const [workdayEnd, setWorkdayEnd] = createSignal('18:00');

  // Step 3 — trust dial (Balanced preselected, matching docs/ftue-plan.md §4)
  const [trustMode, setTrustMode] = createSignal<TrustMode>('balanced');

  /**
   * Finish or Skip, from any step. Records `onboarded_at` first — that's the gate the
   * overlay itself watches, so it must land before anything else. The planning-session
   * log is best-effort afterward: a failed log write must never reopen or block the
   * wizard (mirrors PlanWeekAssistant's own "log must never block the UI" contract).
   */
  async function completeOnboarding() {
    setBusy(true);
    try {
      await api.prefs.update({ onboarded_at: new Date().toISOString() });
      await refetchPrefs();
      try {
        const { session } = await api.planWeek.session.open('onboarding');
        await api.planWeek.session.close(session.id, { status: 'completed' });
      } catch { /* best-effort */ }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function nextFromIdentity() {
    const trimmed = name().trim();
    if (!trimmed) { setStep(2); return; } // nothing to write — move on rather than 400
    setBusy(true);
    try {
      await api.owner.updateProfile({ name: trimmed, email: email().trim() || null });
      setStep(2);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function nextFromTimePlace() {
    setBusy(true);
    try {
      await api.prefs.update({ timezone: BROWSER_TZ, workday_start: workdayStart(), workday_end: workdayEnd() });
      setStep(3);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await api.prefs.update({ trust_mode: trustMode() });
    } catch (err) {
      showToast((err as Error).message, 'error');
      setBusy(false);
      return;
    }
    await completeOnboarding();
  }

  return (
    <Show when={shouldOnboard()}>
      <div
        class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,.7)', 'backdrop-filter': 'blur(6px)' }}
      >
        <div class="card w-full max-w-md flex flex-col gap-4">
          <Show when={step() === 1}>
            <div class="flex flex-col gap-3">
              <div>
                <h2 class="text-base font-semibold text-foreground">Welcome</h2>
                <p class="text-xs text-muted-foreground mt-0.5">Let's get your planner set up — every step is skippable.</p>
              </div>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-xs text-muted-foreground">Your name</span>
                <input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="Your name" />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-xs text-muted-foreground">Email</span>
                <input class="input" type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} placeholder="you@example.com" />
              </label>
              <div class="flex justify-between items-center pt-1">
                <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => void completeOnboarding()}>Skip</button>
                <button type="button" class="btn-primary text-xs" disabled={busy()} onClick={() => void nextFromIdentity()}>Next</button>
              </div>
            </div>
          </Show>

          <Show when={step() === 2}>
            <div class="flex flex-col gap-3">
              <div>
                <h2 class="text-base font-semibold text-foreground">Time and place</h2>
                <p class="text-xs text-muted-foreground mt-0.5">Detected timezone: <span class="text-foreground">{BROWSER_TZ}</span></p>
              </div>
              <div class="flex gap-3">
                <label class="flex flex-col gap-1 text-sm flex-1">
                  <span class="text-xs text-muted-foreground">Workday start</span>
                  <input class="input" type="time" value={workdayStart()} onInput={(e) => setWorkdayStart(e.currentTarget.value)} />
                </label>
                <label class="flex flex-col gap-1 text-sm flex-1">
                  <span class="text-xs text-muted-foreground">Workday end</span>
                  <input class="input" type="time" value={workdayEnd()} onInput={(e) => setWorkdayEnd(e.currentTarget.value)} />
                </label>
              </div>
              <div class="flex justify-between items-center pt-1">
                <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => void completeOnboarding()}>Skip</button>
                <div class="flex gap-2">
                  <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => setStep(1)}>Back</button>
                  <button type="button" class="btn-primary text-xs" disabled={busy()} onClick={() => void nextFromTimePlace()}>Next</button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={step() === 3}>
            <div class="flex flex-col gap-3">
              <div>
                <h2 class="text-base font-semibold text-foreground">Trust dial</h2>
                <p class="text-xs text-muted-foreground mt-0.5">How much should the planner do on its own?</p>
              </div>
              <div class="flex flex-col gap-2">
                <For each={TRUST_OPTIONS}>
                  {(opt) => (
                    <button
                      type="button"
                      class="btn-ghost text-sm justify-start flex-col items-start gap-0.5 py-2"
                      classList={{ 'bg-primary/10 border-primary': trustMode() === opt.value }}
                      onClick={() => setTrustMode(opt.value)}
                    >
                      <span class="text-foreground">{opt.label}</span>
                      <span class="text-[11px] text-muted-foreground font-normal">{opt.hint}</span>
                    </button>
                  )}
                </For>
              </div>
              <div class="flex justify-between items-center pt-1">
                <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => void completeOnboarding()}>Skip</button>
                <div class="flex gap-2">
                  <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => setStep(2)}>Back</button>
                  <button type="button" class="btn-primary text-xs" disabled={busy()} onClick={() => void finish()}>Finish</button>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
