import { createSignal, createResource, createEffect, onMount, For, Show } from 'solid-js';
import { editableOwnerName } from '../lib/owner-name.js';
import { api } from '../lib/api.js';
import {
  prefs, refetchPrefs, showToast, onboardingStep, setOnboardingStep, onboardingForceOpen, setOnboardingForceOpen,
  setOnboardingSampleDataAllowed, plannerAxisState, setPlannerCollapseBounds,
} from '../stores/index.js';
import { FTUE_RESUME_KEY } from '../lib/onboarding.js';
import { topCollapseEnd, bottomCollapseStart } from '../lib/day-axis.js';
import { buildPlannerViewPrefs } from '../lib/view-prefs.js';
import { TRUST_OPTIONS, type TrustMode } from './TrustModal.js';
import { ConnectSourceStep } from './onboarding/ConnectSourceStep.js';
import { RunFirstSyncStep } from './onboarding/RunFirstSyncStep.js';
import { PatternTagsSetup, DayTypeSetup, WeekdayTypesStep } from './onboarding/PlanningSetupSteps.js';
import { useNavigate } from '@solidjs/router';

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();

/** `540` → `"09:00"`. The collapse bounds are stored as minutes from midnight. */
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** `"09:00"` → `540`; falsy/malformed input falls back to `fallback`. */
function hhmmToMinutes(hhmm: string, fallback = 0): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

function clampMinutes(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(Math.round(v), lo), hi);
}

// Trust dial choices come from the same source the top-bar trust control uses, so the
// wizard and the modal can never describe the dial differently. (They did: this file's
// copy still promised Balanced "auto-promotes high-confidence items" long after AF-3
// retired auto-promotion.)

/**
 * FTUE — first-run setup for identity, time, tags, availability, integrations and planning preferences.
 * Gated on the owner's own `onboarded_at` flag (0132), never on
 * route, so it covers every screen the same way `ElementWizard` does.
 *
 * T2 ("Plan my week") defines no exported, form-generic stepper to reuse: its
 * `PlanWeekAssistant` is a self-contained modal driven by its own fixed 3-branch menu,
 * and its one exported primitive (`PromptStep`) is a question+chips+free-text shape —
 * not remotely suited to name/email fields, a TZ confirm + two time inputs, a 3-option
 * dial, or the Connect/Run-sync steps. This owns its own step signal instead — but
 * (T12) that signal now lives in the store (`onboardingStep`), not locally, because
 * the empty-state "Connect a source" CTA is a SIBLING of this component (it lives in
 * Focus/Today/AllTasks), not a descendant, and needs to jump the already-mounted
 * wizard to the Connect step from outside.
 */
export function OnboardingWizard() {
  const navigate = useNavigate();
  const shouldOnboard = () => {
    const p = prefs();
    const notYetOnboarded = p !== undefined && p !== null && p.onboarded_at == null;
    return notYetOnboarded || onboardingForceOpen();
  };

  const [busy, setBusy] = createSignal(false);
  const [setupDayType, setSetupDayType] = createSignal('workday');

  const [me] = createResource(() => api.auth.me().catch(() => null));

  // Step 1 — identity
  const [name, setName] = createSignal('');
  const [email, setEmail] = createSignal('');
  createEffect(() => {
    const m = me();
    if (m) { setName(editableOwnerName(m.name)); setEmail(m.email ?? ''); }
  });

  /**
   * The identity inputs are ALSO read straight from the DOM on submit, not only from the
   * signals above.
   *
   * Browser autofill sets `input.value` without dispatching an `input` event, so `onInput`
   * never runs and the signal stays ''. The submit path then reads an empty name, takes
   * its "nothing to write" branch, and advances to step 2 having saved nothing — the form
   * looks filled, the wizard looks like it worked, and the account details are silently
   * dropped. Chrome does this for its own address/email autofill and for password-manager
   * fills that land before the first user interaction.
   *
   * Reading the element is the only reliable source of truth here: it covers autofill,
   * extensions, and any other programmatic write, none of which are obliged to fire events.
   */
  let nameEl: HTMLInputElement | undefined;
  let emailEl: HTMLInputElement | undefined;
  /** Signal value, or the DOM value when something set it without firing `input`. */
  const liveName = () => (nameEl?.value ?? name()) || name();
  const liveEmail = () => (emailEl?.value ?? email()) || email();

  /**
   * Wake / bed times drive the planner's night collapse — the hours the day grid folds
   * away so the useful part of the day fills the screen. They are the SAME setting as
   * Settings → Planner display ("Collapse night until" / "Collapse night from"), stored
   * as view_prefs.planner.topEndMin / bottomStartMin in minutes from midnight.
   *
   * Hydrated from the live store so re-opening the wizard shows what is actually set,
   * rather than resetting an owner's tuned values to the defaults.
   */
  const [wakeTime, setWakeTime] = createSignal(minutesToHHMM(topCollapseEnd(plannerAxisState())));
  const [bedTime, setBedTime] = createSignal(minutesToHHMM(bottomCollapseStart(plannerAxisState())));

  // Trust dial (Balanced preselected pre-completion, matching
  // docs/ftue-plan.md §4; hydrated from prefs() for the same reopen reason as above).
  const [trustMode, setTrustMode] = createSignal<TrustMode>('balanced');
  createEffect(() => {
    const p = prefs();
    if (p?.trust_mode) setTrustMode(p.trust_mode);
  });

  /**
   * Finish or Skip, from any step. Records `onboarded_at` first — that's the gate the
   * overlay itself watches, so it must land before anything else. The planning-session
   * log is best-effort afterward: a failed log write must never reopen or block the
   * wizard (mirrors PlanWeekAssistant's own "log must never block the UI" contract).
   */
  async function completeOnboarding(): Promise<boolean> {
    setBusy(true);
    try {
      await api.prefs.update({ onboarded_at: new Date().toISOString() });
      await refetchPrefs();
      try {
        const { session } = await api.planWeek.session.open('onboarding');
        await api.planWeek.session.close(session.id, { status: 'completed' });
      } catch { /* best-effort */ }
      setOnboardingForceOpen(false); // reopened-via-CTA case: onboarded_at may already
                                      // have been set, so the force flag is what closes it
      setOnboardingSampleDataAllowed(true); // don't leak a quick-connect's `false` into
                                             // the next genuine restart
      return true;
    } catch (err) {
      showToast((err as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function finishToBalance() {
    if (await completeOnboarding()) navigate('/priorities');
  }

  /** Shared shape behind every "save this step, then advance" transition: busy-guard,
   *  write, advance on success, toast + stay put on failure. */
  async function advance(write: () => Promise<unknown>, nextStep: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10) {
    setBusy(true);
    try {
      await write();
      setOnboardingStep(nextStep);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function nextFromIdentity() {
    // liveName/liveEmail, not the signals — see the autofill note above.
    const trimmed = liveName().trim();
    if (!trimmed) { setOnboardingStep(2); return Promise.resolve(); } // genuinely blank — move on rather than 400
    return advance(() => api.owner.updateProfile({ name: trimmed, email: liveEmail().trim() || null }), 2);
  }

  function nextFromTimePlace() {
    // The collapse bounds are clamped the same way day-axis.ts clamps them on read, so a
    // hand-typed 23:00 wake time cannot produce an inverted axis.
    const topEndMin = clampMinutes(hhmmToMinutes(wakeTime()), 0, 12 * 60);
    const bottomStartMin = clampMinutes(hhmmToMinutes(bedTime()), 12 * 60, 24 * 60);

    return advance(async () => {
      // Apply in-memory first so the planner behind the wizard updates immediately.
      setPlannerCollapseBounds(topEndMin, bottomStartMin);
      // Then write timezone + view_prefs in one awaited PATCH.
      //
      // Deliberately not leaning on the store's view_prefs persist effect: that path is
      // debounced 400ms and fire-and-forget (`.catch(() => {})`), so a user who clicks
      // Next and finishes onboarding quickly could navigate away before it flushes and
      // silently lose the setting — the same shape as the autofill bug this wizard just
      // had. Merging over the existing blob keeps the sibling `calendar` section intact.
      const existing = prefs()?.view_prefs ?? {};
      await api.prefs.update({
        timezone: BROWSER_TZ,
        view_prefs: { ...existing, planner: buildPlannerViewPrefs({ ...plannerAxisState(), topEndMin, bottomStartMin }) },
      });
    }, 3);
  }

  function nextFromTrust() {
    return advance(() => api.prefs.update({ trust_mode: trustMode() }), 9);
  }

  /**
   * OAuth-return resume (T12) — the callback always redirects to `/settings?google=…`
   * via a real server-side 302 (server-side, unconditionally; see oauth.ts), so this
   * only acts when the wizard itself set the marker before navigating away. Settings.tsx's
   * own onMount checks the same marker and stands down when it's present, so only one
   * of the two ever toasts/strips the param for a given return.
   *
   * A full-page redirect reloads the whole SPA, so every module-level signal — including
   * `onboardingStep` and `onboardingForceOpen` — resets to its default. For a NOT-yet-
   * onboarded owner that's harmless (`shouldOnboard()`'s other branch already keeps the
   * overlay open). But an ALREADY-onboarded owner who reopened the wizard via the
   * empty-state CTA (`onboardingForceOpen`) would otherwise land back on a bare Settings
   * page with only a toast — the force-open flag must be re-armed here too, and the step
   * explicitly set on BOTH outcomes (on error nothing else sets it, so it would silently
   * default back to step 1 instead of staying on Connect where the user can retry).
   */
  onMount(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem(FTUE_RESUME_KEY)) return;
    const q = new URLSearchParams(window.location.search);
    const g = q.get('google');
    if (!g) return; // marker set but no return param yet — still out on the consent screen
    localStorage.removeItem(FTUE_RESUME_KEY);
    if (g === 'connected') {
      showToast('Google account connected', 'success');
      setOnboardingStep(8);
    } else {
      showToast(`Google connect failed${q.get('reason') ? `: ${q.get('reason')}` : ''}`, 'error');
      setOnboardingStep(7); // back to Connect so the user can retry, not the step-1 default
    }
    setOnboardingForceOpen(true);
    q.delete('google'); q.delete('reason');
    const qs = q.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  });

  return (
    <Show when={shouldOnboard()}>
      <div
        class="fixed inset-0 z-[1000] flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,.7)', 'backdrop-filter': 'blur(6px)' }}
      >
        <div class="card w-full max-w-md flex flex-col gap-4">
          <p class="text-[11px] text-muted-foreground -mb-1">Step {onboardingStep()} of 10</p>
          <Show when={onboardingStep() === 1}>
            <div class="flex flex-col gap-3">
              <div>
                <h2 class="text-base font-semibold text-foreground">Welcome</h2>
                <p class="text-xs text-muted-foreground mt-0.5">Let's get your planner set up — every step is skippable.</p>
              </div>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-xs text-muted-foreground">Your name</span>
                <input ref={nameEl} class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="Your name" />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-xs text-muted-foreground">Email</span>
                <input ref={emailEl} class="input" type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} placeholder="you@example.com" />
              </label>
              <div class="flex justify-between items-center pt-1">
                <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => void completeOnboarding()}>Skip</button>
                <button type="button" class="btn-primary text-xs" disabled={busy()} onClick={() => void nextFromIdentity()}>Next</button>
              </div>
            </div>
          </Show>

          <Show when={onboardingStep() === 2}>
            <div class="flex flex-col gap-3">
              <div>
                <h2 class="text-base font-semibold text-foreground">Time and place</h2>
                <p class="text-xs text-muted-foreground mt-0.5">
                  Block your days and weeks intelligently. Detected timezone:{' '}
                  <span class="text-foreground">{BROWSER_TZ}</span>
                </p>
              </div>
              <div class="flex gap-3">
                <label class="flex flex-col gap-1 text-sm flex-1">
                  <span class="text-xs text-muted-foreground">Usually wake up</span>
                  <input class="input" type="time" value={wakeTime()} onInput={(e) => setWakeTime(e.currentTarget.value)} />
                </label>
                <label class="flex flex-col gap-1 text-sm flex-1">
                  <span class="text-xs text-muted-foreground">Usually go to bed</span>
                  <input class="input" type="time" value={bedTime()} onInput={(e) => setBedTime(e.currentTarget.value)} />
                </label>
              </div>
              <p class="text-[11px] text-muted-foreground -mt-1">
                The planner folds the hours outside this away, so your real day fills the screen.
                Change it any time in Settings → Planner display.
              </p>
              <div class="flex justify-between items-center pt-1">
                <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => void completeOnboarding()}>Skip</button>
                <div class="flex gap-2">
                  <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => setOnboardingStep(1)}>Back</button>
                  <button type="button" class="btn-primary text-xs" disabled={busy()} onClick={() => void nextFromTimePlace()}>Next</button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={onboardingStep() === 3}>
            <PatternTagsSetup onBack={() => setOnboardingStep(2)} onNext={() => setOnboardingStep(4)} busy={busy()} />
          </Show>

          <Show when={onboardingStep() === 4}>
            <DayTypeSetup dayType={setupDayType()} onBack={() => setOnboardingStep(3)} onNext={() => { setSetupDayType('workday'); setOnboardingStep(5); }} onAddType={async () => {
              const label = window.prompt('Name your day type (for example, Holiday):')?.trim();
              if (!label) return;
              const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `day-${Date.now()}`;
              try {
                await api.dayTypes.create(key, label);
                const directions = (await api.tags.list()).tags.filter((tag) => tag.kind === 'direction');
                await Promise.all(directions.map((tag) => api.patternBlocks.set(tag.id, key, [])));
                setSetupDayType(key);
                showToast(`${label} added. Set its availability windows now.`, 'success');
              } catch (err) { showToast((err as Error).message, 'error'); }
            }} busy={busy()} />
          </Show>

          <Show when={onboardingStep() === 5}>
            <DayTypeSetup dayType="weekend" onBack={() => setOnboardingStep(4)} onNext={() => setOnboardingStep(6)} onSkip={() => setOnboardingStep(6)} busy={busy()} />
          </Show>

          <Show when={onboardingStep() === 6}>
            <WeekdayTypesStep onBack={() => setOnboardingStep(5)} onNext={() => setOnboardingStep(7)} busy={busy()} />
          </Show>

          <Show when={onboardingStep() === 7}>
            <ConnectSourceStep
              onNext={() => setOnboardingStep(8)}
              onBack={() => setOnboardingStep(6)}
              onSkip={() => void completeOnboarding()}
            />
          </Show>

          <Show when={onboardingStep() === 8}>
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
                  <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => setOnboardingStep(7)}>Back</button>
                  <button type="button" class="btn-primary text-xs" disabled={busy()} onClick={() => void nextFromTrust()}>Next</button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={onboardingStep() === 9}>
            <RunFirstSyncStep
              onBack={() => setOnboardingStep(8)}
              onFinish={() => setOnboardingStep(10)}
              onGoToConnect={() => setOnboardingStep(7)}
            />
          </Show>

          <Show when={onboardingStep() === 10}>
            <div class="flex flex-col gap-3">
              <div><h2 class="text-base font-semibold text-foreground">You’re ready to plan</h2><p class="text-xs text-muted-foreground mt-0.5">Your setup is saved. Want to set your life priorities and weekly balance now?</p></div>
              <div class="flex justify-between items-center pt-1"><button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => void completeOnboarding()}>Finish</button><div class="flex gap-2"><button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={() => setOnboardingStep(9)}>Back</button><button type="button" class="btn-primary text-xs" disabled={busy()} onClick={() => void finishToBalance()}>Set up Life Balance</button></div></div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
