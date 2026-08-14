import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { Integrations } from '../lib/api.js';

/**
 * OnboardingWizard (FTUE · T11, #347 / T12, #348) — gating on the owner's
 * `onboarded_at` flag, the 5-step wiring (identity / time+place / connect a source /
 * trust dial / run first sync), and completion. T12 moved `step` from a component-
 * local signal to the store (`onboardingStep`) and added the Connect/Run-sync step
 * slots — this file was rewritten for that shape, not just extended.
 *
 * SEAMS mocked: `../lib/api.js` (auth.me / owner.updateProfile / prefs.update /
 * planWeek.session.open+close / oauth.googleStart / googleConfig.get+save /
 * jobs.runNow) and `../stores/index.js` (prefs / refetchPrefs / showToast /
 * onboardingStep+setOnboardingStep / onboardingForceOpen+setOnboardingForceOpen /
 * integrations / refetch* / hasConnectedSource) — mirrors PlanWeekFill.test.tsx.
 * `prefs`, `onboardingStep`, and `onboardingForceOpen` are backed by real Solid
 * signals so the mocked setters/refetches actually drive the component, not just
 * record that they were called.
 */

const meMock = vi.fn(async () => ({
  ownerId: 'o1', name: 'Ada', email: 'ada@x.io', username: null,
  backupEmail: null, role: 'operator' as const, isOperator: true,
}));
const updateProfileMock = vi.fn(async (_b: unknown) => ({ ok: true, name: 'Ada', email: 'ada@x.io' }));
const prefsUpdateMock = vi.fn(async (_b: unknown) => ({ prefs: {} }));
const sessionOpenMock = vi.fn(async (_branch: string) => ({ session: { id: 's1' } }));
const sessionCloseMock = vi.fn(async (_id: string, _b: unknown) => ({ session: { id: 's1' } }));
const googleStartMock = vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/consent' }));
const googleConfigGetMock = vi.fn(async () => ({
  source: 'off' as const, mode: 'off' as const, envPinned: false, kekAvailable: true,
  clientId: null, hasClientSecret: false, enabled: false, redirectUri: 'http://x/api/oauth/google/callback',
}));
const googleConfigSaveMock = vi.fn(async (_b: unknown) => googleConfigGetMock());
const runNowMock = vi.fn(async () => ({
  ok: true,
  ran: [{ kind: 'sync_calendar', status: 'done', itemsCreated: 3, itemsUpdated: 1, log: '' }],
}));

vi.mock('../lib/api.js', () => ({
  api: {
    auth: { me: () => meMock() },
    owner: { updateProfile: (b: unknown) => updateProfileMock(b) },
    prefs: { update: (b: unknown) => prefsUpdateMock(b) },
    planWeek: {
      session: {
        open: (branch: string) => sessionOpenMock(branch),
        close: (id: string, b: unknown) => sessionCloseMock(id, b),
      },
    },
    oauth: { googleStart: () => googleStartMock() },
    googleConfig: { get: () => googleConfigGetMock(), save: (b: unknown) => googleConfigSaveMock(b) },
    jobs: { runNow: () => runNowMock() },
  },
}));

type PrefsLike =
  | { onboarded_at: string | null; workday_start?: string; workday_end?: string; trust_mode?: 'cautious' | 'balanced' | 'hands_off' }
  | null | undefined;
// Matches the real Prefs shape's non-null defaults (Drizzle: workday_start/workday_end
// default '09:00'/'18:00') so tests that don't care about T12's reopen-hydration fix
// don't have to spell these out every time.
const DEFAULT_PREFS_FIELDS = { workday_start: '09:00', workday_end: '18:00' } as const;
const [prefsValue, setPrefsValue] = createSignal<PrefsLike>(undefined);
const setPrefs = (p: PrefsLike) => setPrefsValue(p ? { ...DEFAULT_PREFS_FIELDS, ...p } : p);
const refetchPrefsMock = vi.fn(async () => {
  setPrefsValue((p) => ({ ...DEFAULT_PREFS_FIELDS, ...(p ?? {}), onboarded_at: '2026-07-19T00:00:00.000Z' }) as PrefsLike);
});
const [onboardingStepValue, setOnboardingStepValue] = createSignal<1 | 2 | 3 | 4 | 5>(1);
const [onboardingForceOpenValue, setOnboardingForceOpenValue] = createSignal(false);
const [integrationsValue, setIntegrationsValue] = createSignal<Integrations | undefined>(undefined);
const toastMock = vi.fn();
const refetchIntegrationsMock = vi.fn();
const refetchTasksMock = vi.fn();
const refetchBlocksMock = vi.fn();
const refetchFlightPlanMock = vi.fn();

// Planner night-collapse state: a real signal so step 2's wake/bed inputs hydrate from
// it and the setter can be asserted, matching how prefs/onboardingStep are handled.
const [plannerAxisValue, setPlannerAxisValue] = createSignal<{ topEndMin?: number; bottomStartMin?: number }>({});
const setPlannerCollapseBoundsMock = vi.fn((topEndMin: number, bottomStartMin: number) =>
  setPlannerAxisValue({ topEndMin, bottomStartMin }),
);

vi.mock('../stores/index.js', () => ({
  plannerAxisState: () => plannerAxisValue(),
  setPlannerCollapseBounds: (a: number, b: number) => setPlannerCollapseBoundsMock(a, b),
  prefs: () => prefsValue(),
  refetchPrefs: () => refetchPrefsMock(),
  showToast: (...a: unknown[]) => toastMock(...a),
  onboardingStep: () => onboardingStepValue(),
  setOnboardingStep: (s: 1 | 2 | 3 | 4 | 5) => setOnboardingStepValue(s),
  onboardingForceOpen: () => onboardingForceOpenValue(),
  setOnboardingForceOpen: (v: boolean) => setOnboardingForceOpenValue(v),
  integrations: () => integrationsValue(),
  refetchIntegrations: () => refetchIntegrationsMock(),
  refetchTasks: () => refetchTasksMock(),
  refetchBlocks: () => refetchBlocksMock(),
  refetchFlightPlan: () => refetchFlightPlanMock(),
  runIngestNowAndRefetch: async () => {
    const { ran } = await runNowMock();
    refetchTasksMock(); refetchBlocksMock(); refetchFlightPlanMock(); refetchIntegrationsMock();
    return ran;
  },
  hasConnectedSource: () => {
    const i = integrationsValue();
    if (!i) return false;
    if (i.google.mode === 'fixture') return true;
    return i.google.connections.some((c) => c.status === 'connected');
  },
}));

const OFF_INTEGRATIONS: Integrations = {
  ollama: { available: false, models: [], fastModel: '', qualityModel: '', embedModel: '' },
  google: { mode: 'off', liveEnabled: false, source: 'off', connections: [] },
};

const { OnboardingWizard } = await import('./OnboardingWizard.js');
const mount = () => render(() => <OnboardingWizard />);

async function advanceToStep2() {
  await screen.findByText('Welcome');
  await waitFor(() => expect((screen.getByPlaceholderText('Your name') as HTMLInputElement).value).toBe('Ada'));
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText('Time and place');
}

async function advanceToConnectStep() {
  await advanceToStep2();
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText('Connect a source');
}

async function advanceToTrustStep() {
  await advanceToConnectStep();
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText('Trust dial');
}

async function advanceToRunSyncStep() {
  await advanceToTrustStep();
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText('Run your first sync');
}

describe('OnboardingWizard', () => {
  beforeEach(() => {
    // Module-level signal shared by every test in this file — reset it or a test that
    // seeds saved collapse bounds leaks them into the next one's hydration assertions.
    setPlannerAxisValue({});
    setPlannerCollapseBoundsMock.mockClear();
    meMock.mockReset().mockResolvedValue({
      ownerId: 'o1', name: 'Ada', email: 'ada@x.io', username: null,
      backupEmail: null, role: 'operator', isOperator: true,
    });
    updateProfileMock.mockReset().mockResolvedValue({ ok: true, name: 'Ada', email: 'ada@x.io' });
    prefsUpdateMock.mockReset().mockResolvedValue({ prefs: {} });
    sessionOpenMock.mockReset().mockResolvedValue({ session: { id: 's1' } });
    sessionCloseMock.mockReset().mockResolvedValue({ session: { id: 's1' } });
    googleStartMock.mockReset().mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/consent' });
    googleConfigGetMock.mockReset().mockResolvedValue({
      source: 'off', mode: 'off', envPinned: false, kekAvailable: true,
      clientId: null, hasClientSecret: false, enabled: false, redirectUri: 'http://x/api/oauth/google/callback',
    });
    googleConfigSaveMock.mockReset().mockImplementation(async () => googleConfigGetMock());
    runNowMock.mockReset().mockResolvedValue({
      ok: true, ran: [{ kind: 'sync_calendar', status: 'done', itemsCreated: 3, itemsUpdated: 1, log: '' }],
    });
    refetchPrefsMock.mockClear();
    refetchIntegrationsMock.mockReset();
    refetchTasksMock.mockReset();
    refetchBlocksMock.mockReset();
    refetchFlightPlanMock.mockReset();
    toastMock.mockReset();
    setPrefsValue(undefined);
    setOnboardingStepValue(1);
    setOnboardingForceOpenValue(false);
    setIntegrationsValue(OFF_INTEGRATIONS);
    localStorage.clear();
  });

  describe('gating', () => {
    it('renders nothing while prefs() is loading', () => {
      mount();
      expect(screen.queryByText('Welcome')).toBeNull();
    });

    it('renders nothing once onboarded_at is set', () => {
      setPrefs({ onboarded_at: '2020-01-01T00:00:00.000Z' });
      mount();
      expect(screen.queryByText('Welcome')).toBeNull();
    });

    it('renders the step shell when onboarded_at is null', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');
    });

    it('onboardingForceOpen reopens the wizard even when already onboarded', async () => {
      setPrefs({ onboarded_at: '2020-01-01T00:00:00.000Z' });
      setOnboardingStepValue(3);
      setOnboardingForceOpenValue(true);
      mount();
      await screen.findByText('Connect a source');
    });
  });

  describe('step wiring', () => {
    it('Step 1 Next prefills from auth.me and writes via owner.updateProfile; empty email -> null', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');
      await waitFor(() => expect((screen.getByPlaceholderText('Your name') as HTMLInputElement).value).toBe('Ada'));
      fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: '' } });

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() => expect(updateProfileMock).toHaveBeenCalledWith({ name: 'Ada', email: null }));
      await screen.findByText('Time and place');
    });

    /**
     * Browser autofill sets `input.value` WITHOUT dispatching an `input` event, so a
     * controlled Solid input's signal stays at its old value. Step 1 previously read only
     * the signal: an autofilled form therefore looked blank, took the "nothing to write"
     * branch, and advanced to step 2 having saved nothing — the wizard appeared to work
     * while silently discarding the account details.
     *
     * Assigning `.value` directly (no fireEvent.input) is exactly what the browser does,
     * so this reproduces it faithfully rather than approximating it.
     */
    it('Step 1 saves values the browser AUTOFILLED, which fire no input event', async () => {
      meMock.mockResolvedValueOnce({
        ownerId: 'o1', name: '', email: '', username: null,
        backupEmail: null, role: 'operator' as const, isOperator: true,
      });
      setPrefs({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');

      const nameEl = screen.getByPlaceholderText('Your name') as HTMLInputElement;
      const emailEl = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
      await waitFor(() => expect(nameEl.value).toBe(''));

      nameEl.value = 'Liam';
      emailEl.value = 'liam@example.com';

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() =>
        expect(updateProfileMock).toHaveBeenCalledWith({ name: 'Liam', email: 'liam@example.com' }),
      );
      await screen.findByText('Time and place');
    });

    it('Step 1 still advances without writing when the field is genuinely blank', async () => {
      // The guard the autofill fix must not break: a real empty name skips the write
      // rather than sending a 400.
      meMock.mockResolvedValueOnce({
        ownerId: 'o1', name: '', email: '', username: null,
        backupEmail: null, role: 'operator' as const, isOperator: true,
      });
      setPrefs({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');
      await waitFor(() =>
        expect((screen.getByPlaceholderText('Your name') as HTMLInputElement).value).toBe(''),
      );

      fireEvent.click(screen.getByText('Next'));

      await screen.findByText('Time and place');
      expect(updateProfileMock).not.toHaveBeenCalled();
    });

    /**
     * Wake / bed times are the planner's night-collapse bounds — the same setting as
     * Settings → Planner display, stored as view_prefs.planner.topEndMin/bottomStartMin
     * in minutes from midnight.
     *
     * The write is asserted on the awaited PATCH rather than on the store's own
     * view_prefs effect: that effect is debounced 400ms and fire-and-forget, so a user
     * who finishes onboarding quickly could navigate away before it flushes and silently
     * lose the setting.
     */
    it('Step 2 persists wake/bed times as the planner collapse bounds', async () => {
      setPrefs({ onboarded_at: null });
      setOnboardingStepValue(2);
      mount();
      await screen.findByText('Time and place');

      fireEvent.input(screen.getByLabelText(/Usually wake up/), { target: { value: '06:30' } });
      fireEvent.input(screen.getByLabelText(/Usually go to bed/), { target: { value: '22:45' } });

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() =>
        expect(prefsUpdateMock).toHaveBeenCalledWith(
          expect.objectContaining({
            view_prefs: expect.objectContaining({
              planner: expect.objectContaining({ topEndMin: 390, bottomStartMin: 1365 }),
            }),
          }),
        ),
      );
      // Applied in-memory too, so the planner behind the wizard updates immediately.
      expect(setPlannerCollapseBoundsMock).toHaveBeenCalledWith(390, 1365);
    });

    it('Step 2 clamps a wake/bed pair that would invert the planner axis', async () => {
      // day-axis.ts clamps topEndMin to <=12:00 and bottomStartMin to >=12:00 on READ;
      // writing an unclamped pair would persist a nonsense axis that only looks sane
      // because the reader repairs it.
      setPrefs({ onboarded_at: null });
      setOnboardingStepValue(2);
      mount();
      await screen.findByText('Time and place');

      fireEvent.input(screen.getByLabelText(/Usually wake up/), { target: { value: '23:00' } });
      fireEvent.input(screen.getByLabelText(/Usually go to bed/), { target: { value: '01:00' } });

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() => expect(setPlannerCollapseBoundsMock).toHaveBeenCalledWith(720, 720));
    });

    it('Step 2 hydrates wake/bed from the owner\'s saved collapse bounds', async () => {
      setPlannerAxisValue({ topEndMin: 480, bottomStartMin: 1320 }); // 08:00 / 22:00
      setPrefs({ onboarded_at: null });
      setOnboardingStepValue(2);
      mount();
      await screen.findByText('Time and place');

      expect((screen.getByLabelText(/Usually wake up/) as HTMLInputElement).value).toBe('08:00');
      expect((screen.getByLabelText(/Usually go to bed/) as HTMLInputElement).value).toBe('22:00');
    });

    it('Step 2 Next calls prefs.update with timezone + workday_start + workday_end, then lands on Connect', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToStep2();

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ workday_start: '09:00', workday_end: '18:00', timezone: expect.any(String) }),
      ));
      await screen.findByText('Connect a source');
    });

    it('Step 3 (Connect): Connect Google is disabled until liveEnabled, and navigates on click', async () => {
      const originalHref = window.location.href;
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToConnectStep();

      const connectBtn = screen.getByText('Connect Google') as HTMLButtonElement;
      expect(connectBtn.disabled).toBe(true); // liveEnabled: false in OFF_INTEGRATIONS

      setIntegrationsValue({ ...OFF_INTEGRATIONS, google: { ...OFF_INTEGRATIONS.google, liveEnabled: true } });
      await waitFor(() => expect((screen.getByText('Connect Google') as HTMLButtonElement).disabled).toBe(false));

      fireEvent.click(screen.getByText('Connect Google'));
      await waitFor(() => expect(googleStartMock).toHaveBeenCalled());
      expect(localStorage.getItem('cp-ftue-resume')).toBe('1');

      window.history.replaceState({}, '', originalHref); // navigation is stubbed in jsdom; restore
    });

    it('Step 3: Try with sample data (admin) saves fixture mode, runs sync, and advances', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToConnectStep();

      await screen.findByText('Try with sample data');
      fireEvent.click(screen.getByText('Try with sample data'));

      await waitFor(() => expect(googleConfigSaveMock).toHaveBeenCalledWith({ enabled: true, mode: 'fixture' }));
      await waitFor(() => expect(runNowMock).toHaveBeenCalled());
      await screen.findByText('Trust dial'); // onNext() advances past Connect
    });

    it('Step 3: Skip/Back/Next are disabled while "Connect Google" is in flight (adversarial-review fix)', async () => {
      let resolveStart!: (v: { url: string }) => void;
      googleStartMock.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
      setPrefs({ onboarded_at: null });
      setIntegrationsValue({ ...OFF_INTEGRATIONS, google: { ...OFF_INTEGRATIONS.google, liveEnabled: true } });
      mount();
      await advanceToConnectStep();

      fireEvent.click(screen.getByText('Connect Google'));
      await waitFor(() => expect((screen.getByText('Skip') as HTMLButtonElement).disabled).toBe(true));
      expect((screen.getByText('Back') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(true);

      resolveStart({ url: 'https://accounts.google.com/o/oauth2/consent' });
    });

    it('Step 3: "Try with sample data" shows an error and does not advance when every job fails (adversarial-review fix)', async () => {
      runNowMock.mockResolvedValue({
        ok: true, ran: [{ kind: 'sync_calendar', status: 'error', itemsCreated: 0, itemsUpdated: 0, log: 'boom' }],
      });
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToConnectStep();
      await screen.findByText('Try with sample data');

      fireEvent.click(screen.getByText('Try with sample data'));

      await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Could not load sample data — try again in a moment.', 'error'));
      await screen.findByText('Connect a source'); // did NOT advance to Trust dial
      expect(screen.queryByText('Trust dial')).toBeNull();
    });

    it('Step 3: a non-admin (googleConfig.get 403 -> null) never sees "Try with sample data"', async () => {
      googleConfigGetMock.mockRejectedValue(new Error('forbidden'));
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToConnectStep();

      await waitFor(() => expect(screen.queryByText('Sample data is available to an operator account.')).not.toBeNull());
      expect(screen.queryByText('Try with sample data')).toBeNull();
    });

    it('Step 4 (Trust dial) Next calls prefs.update with the chosen trust_mode (default balanced), then lands on Run sync', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToTrustStep();

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith({ trust_mode: 'balanced' }));
      await screen.findByText('Run your first sync');
    });

    it('picking Hands-off before advancing writes trust_mode: hands_off', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToTrustStep();

      fireEvent.click(screen.getByText('Hands-off'));
      fireEvent.click(screen.getByText('Next'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith({ trust_mode: 'hands_off' }));
    });

    it('Step 5 (Run sync): hints at no connected source, runs, and shows a summary', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToRunSyncStep();

      await screen.findByText(/this will be a no-op/);

      fireEvent.click(screen.getByText('Run my first sync now'));

      await waitFor(() => expect(runNowMock).toHaveBeenCalled());
      await screen.findByText('Pulled 3 new, 1 updated into your day.');
      expect(refetchTasksMock).toHaveBeenCalled();
      expect(refetchBlocksMock).toHaveBeenCalled();
      expect(refetchFlightPlanMock).toHaveBeenCalled();
    });

    it('Step 5: "Back to Connect" jumps back to step 3', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToRunSyncStep();

      fireEvent.click(screen.getByText('Back to Connect'));
      await screen.findByText('Connect a source');
    });

    it('Step 5: an all-failed sync shows an error-styled summary, does not block Finish (adversarial-review fix)', async () => {
      runNowMock.mockResolvedValue({
        ok: true, ran: [{ kind: 'sync_calendar', status: 'error', itemsCreated: 0, itemsUpdated: 0, log: 'boom' }],
      });
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToRunSyncStep();

      fireEvent.click(screen.getByText('Run my first sync now'));

      const msg = await screen.findByText('Sync failed — try again in a moment.');
      expect(msg.className).toContain('text-destructive');
      // Finish still works after a failed run — the wizard never gets the user stuck.
      fireEvent.click(screen.getByText('Finish'));
      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ onboarded_at: expect.any(String) }),
      ));
    });

    it('Step 5: Skip/Back/Finish are disabled while a sync is in flight (adversarial-review fix)', async () => {
      let resolveRun!: (v: { ok: true; ran: { kind: string; status: string; itemsCreated: number; itemsUpdated: number; log: string }[] }) => void;
      runNowMock.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToRunSyncStep();

      fireEvent.click(screen.getByText('Run my first sync now'));
      await waitFor(() => expect((screen.getByText('Skip') as HTMLButtonElement).disabled).toBe(true));
      expect((screen.getByText('Back') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText('Finish') as HTMLButtonElement).disabled).toBe(true);

      resolveRun({ ok: true, ran: [{ kind: 'sync_calendar', status: 'done', itemsCreated: 0, itemsUpdated: 0, log: '' }] });
    });
  });

  describe('completion', () => {
    it('Finish (from Run sync) records onboarded_at, records exactly one onboarding session, and the overlay unmounts', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await advanceToRunSyncStep();

      fireEvent.click(screen.getByText('Finish'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ onboarded_at: expect.any(String) }),
      ));
      await waitFor(() => expect(sessionOpenMock).toHaveBeenCalledWith('onboarding'));
      expect(sessionOpenMock).toHaveBeenCalledTimes(1);
      expect(sessionCloseMock).toHaveBeenCalledWith('s1', { status: 'completed' });

      await waitFor(() => expect(screen.queryByText('Run your first sync')).toBeNull());
    });

    it('Skip from step 1 completes onboarding without an identity write', async () => {
      setPrefs({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');

      fireEvent.click(screen.getByText('Skip'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ onboarded_at: expect.any(String) }),
      ));
      expect(updateProfileMock).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByText('Welcome')).toBeNull());
    });

    it('a failed onboarded_at write toasts and leaves the wizard open (no session recorded)', async () => {
      prefsUpdateMock.mockRejectedValueOnce(new Error('offline'));
      setPrefs({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');

      fireEvent.click(screen.getByText('Skip'));

      await waitFor(() => expect(toastMock).toHaveBeenCalledWith('offline', 'error'));
      expect(sessionOpenMock).not.toHaveBeenCalled();
      expect(screen.queryByText('Welcome')).not.toBeNull();
    });

    it('completing a force-reopened (already-onboarded) wizard clears the force-open flag', async () => {
      setPrefs({ onboarded_at: '2020-01-01T00:00:00.000Z' });
      setOnboardingStepValue(3);
      setOnboardingForceOpenValue(true);
      mount();
      await screen.findByText('Connect a source');

      fireEvent.click(screen.getByText('Skip'));

      await waitFor(() => expect(onboardingForceOpenValue()).toBe(false));
      await waitFor(() => expect(screen.queryByText('Connect a source')).toBeNull());
    });
  });

  // Adversarial review caught both of these: reopening the wizard after onboarding
  // already completed is a T12-only path (T11 never showed the wizard post-completion
  // at all), and it exercised two real bugs.
  describe('reopen after completion (adversarial-review fixes)', () => {
    it('Time+place and Trust dial hydrate from the owner\'s real saved prefs, not the pre-completion defaults', async () => {
      setPrefs({ onboarded_at: '2020-01-01T00:00:00.000Z', workday_start: '07:30', workday_end: '16:00', trust_mode: 'hands_off' });
      setOnboardingStepValue(2);
      setOnboardingForceOpenValue(true);
      mount();

      await waitFor(() => expect((screen.getByLabelText(/Workday start/) as HTMLInputElement).value).toBe('07:30'));
      expect((screen.getByLabelText(/Workday end/) as HTMLInputElement).value).toBe('16:00');

      // Advancing must resubmit the REAL saved values, not '09:00'/'18:00'.
      fireEvent.click(screen.getByText('Next'));
      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ workday_start: '07:30', workday_end: '16:00' }),
      ));

      // Wait for the Connect step to actually render before clicking on: Next is
      // disabled while the step-2 write is in flight, so clicking the moment the mock
      // records the call can land on a disabled button and be swallowed.
      await screen.findByText('Connect a source');
      fireEvent.click(screen.getByText('Next')); // Connect -> Trust
      await screen.findByText('Trust dial');
      fireEvent.click(screen.getByText('Next'));
      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith({ trust_mode: 'hands_off' }));
    });

    it('reopens at the resumed step after a full-page OAuth round trip, even though onboarding already completed', async () => {
      // Simulates the state right after a fresh SPA boot on the OAuth callback's
      // redirect: onboarded_at was already set before the round trip (module signals
      // reset to their defaults on the fresh load), and the resume marker survived
      // because localStorage — unlike in-memory signals — persists across the reload.
      localStorage.setItem('cp-ftue-resume', '1');
      window.history.replaceState({}, '', '/settings?google=connected');
      setPrefs({ onboarded_at: '2020-01-01T00:00:00.000Z' });
      setOnboardingStepValue(1); // the fresh-boot default, NOT the step the user was on
      setOnboardingForceOpenValue(false); // also reset by the fresh boot

      mount();

      await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Google account connected', 'success'));
      await screen.findByText('Trust dial'); // step 4, not the step-1 default
      expect(localStorage.getItem('cp-ftue-resume')).toBeNull();
      expect(window.location.search).toBe('');

      window.history.replaceState({}, '', '/'); // restore for other tests
    });

    it('a failed OAuth return also reopens the wizard, landing back on Connect to retry', async () => {
      localStorage.setItem('cp-ftue-resume', '1');
      window.history.replaceState({}, '', '/settings?google=error&reason=access_denied');
      setPrefs({ onboarded_at: '2020-01-01T00:00:00.000Z' });
      setOnboardingStepValue(1);
      setOnboardingForceOpenValue(false);

      mount();

      await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Google connect failed: access_denied', 'error'));
      await screen.findByText('Connect a source'); // step 3, so the user can retry

      window.history.replaceState({}, '', '/');
    });
  });
});
