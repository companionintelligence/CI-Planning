import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

/**
 * OnboardingWizard (FTUE · T11, #347) — gating on the owner's `onboarded_at` flag,
 * the three-step wiring (identity / time+place / trust dial), and completion.
 *
 * SEAMS mocked: `../lib/api.js` (auth.me / owner.updateProfile / prefs.update /
 * planWeek.session.open+close) and `../stores/index.js` (prefs / refetchPrefs /
 * showToast) — mirrors PlanWeekFill.test.tsx. `prefs` is backed by a real Solid
 * signal so the mocked `refetchPrefs` can flip it and prove the overlay unmounts,
 * not just that the mock was called.
 */

const meMock = vi.fn(async () => ({
  ownerId: 'o1', name: 'Ada', email: 'ada@x.io', username: null,
  backupEmail: null, role: 'operator' as const, isOperator: true,
}));
const updateProfileMock = vi.fn(async (_b: unknown) => ({ ok: true, name: 'Ada', email: 'ada@x.io' }));
const prefsUpdateMock = vi.fn(async (_b: unknown) => ({ prefs: {} }));
const sessionOpenMock = vi.fn(async (_branch: string) => ({ session: { id: 's1' } }));
const sessionCloseMock = vi.fn(async (_id: string, _b: unknown) => ({ session: { id: 's1' } }));

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
  },
}));

type PrefsLike = { onboarded_at: string | null } | null | undefined;
const [prefsValue, setPrefsValue] = createSignal<PrefsLike>(undefined);
const refetchPrefsMock = vi.fn(async () => {
  setPrefsValue((p) => ({ ...(p ?? {}), onboarded_at: '2026-07-19T00:00:00.000Z' }) as PrefsLike);
});
const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  prefs: () => prefsValue(),
  refetchPrefs: () => refetchPrefsMock(),
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { OnboardingWizard } = await import('./OnboardingWizard.js');
const mount = () => render(() => <OnboardingWizard />);

async function advanceToStep2() {
  await screen.findByText('Welcome');
  await waitFor(() => expect((screen.getByPlaceholderText('Your name') as HTMLInputElement).value).toBe('Ada'));
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText('Time and place');
}

async function advanceToStep3() {
  await advanceToStep2();
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText('Trust dial');
}

describe('OnboardingWizard', () => {
  beforeEach(() => {
    meMock.mockReset().mockResolvedValue({
      ownerId: 'o1', name: 'Ada', email: 'ada@x.io', username: null,
      backupEmail: null, role: 'operator', isOperator: true,
    });
    updateProfileMock.mockReset().mockResolvedValue({ ok: true, name: 'Ada', email: 'ada@x.io' });
    prefsUpdateMock.mockReset().mockResolvedValue({ prefs: {} });
    sessionOpenMock.mockReset().mockResolvedValue({ session: { id: 's1' } });
    sessionCloseMock.mockReset().mockResolvedValue({ session: { id: 's1' } });
    refetchPrefsMock.mockClear();
    toastMock.mockReset();
    setPrefsValue(undefined);
  });

  describe('gating', () => {
    it('renders nothing while prefs() is loading', () => {
      mount();
      expect(screen.queryByText('Welcome')).toBeNull();
    });

    it('renders nothing once onboarded_at is set', () => {
      setPrefsValue({ onboarded_at: '2020-01-01T00:00:00.000Z' });
      mount();
      expect(screen.queryByText('Welcome')).toBeNull();
    });

    it('renders the step shell when onboarded_at is null', async () => {
      setPrefsValue({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');
    });
  });

  describe('step wiring', () => {
    it('Step 1 Next prefills from auth.me and writes via owner.updateProfile; empty email -> null', async () => {
      setPrefsValue({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');
      await waitFor(() => expect((screen.getByPlaceholderText('Your name') as HTMLInputElement).value).toBe('Ada'));
      fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: '' } });

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() => expect(updateProfileMock).toHaveBeenCalledWith({ name: 'Ada', email: null }));
      await screen.findByText('Time and place');
    });

    it('Step 2 Next calls prefs.update with timezone + workday_start + workday_end', async () => {
      setPrefsValue({ onboarded_at: null });
      mount();
      await advanceToStep2();

      fireEvent.click(screen.getByText('Next'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ workday_start: '09:00', workday_end: '18:00', timezone: expect.any(String) }),
      ));
      await screen.findByText('Trust dial');
    });

    it('Step 3 Finish calls prefs.update with the chosen trust_mode (default balanced)', async () => {
      setPrefsValue({ onboarded_at: null });
      mount();
      await advanceToStep3();

      fireEvent.click(screen.getByText('Finish'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith({ trust_mode: 'balanced' }));
    });

    it('picking Hands-off before Finish writes trust_mode: hands_off', async () => {
      setPrefsValue({ onboarded_at: null });
      mount();
      await advanceToStep3();

      fireEvent.click(screen.getByText('Hands-off'));
      fireEvent.click(screen.getByText('Finish'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith({ trust_mode: 'hands_off' }));
    });
  });

  describe('completion', () => {
    it('Finish records onboarded_at, records exactly one onboarding session, and the overlay unmounts', async () => {
      setPrefsValue({ onboarded_at: null });
      mount();
      await advanceToStep3();

      fireEvent.click(screen.getByText('Finish'));

      await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ onboarded_at: expect.any(String) }),
      ));
      await waitFor(() => expect(sessionOpenMock).toHaveBeenCalledWith('onboarding'));
      expect(sessionOpenMock).toHaveBeenCalledTimes(1);
      expect(sessionCloseMock).toHaveBeenCalledWith('s1', { status: 'completed' });

      await waitFor(() => expect(screen.queryByText('Welcome')).toBeNull());
    });

    it('Skip from step 1 completes onboarding without an identity write', async () => {
      setPrefsValue({ onboarded_at: null });
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
      setPrefsValue({ onboarded_at: null });
      mount();
      await screen.findByText('Welcome');

      fireEvent.click(screen.getByText('Skip'));

      await waitFor(() => expect(toastMock).toHaveBeenCalledWith('offline', 'error'));
      expect(sessionOpenMock).not.toHaveBeenCalled();
      expect(screen.queryByText('Welcome')).not.toBeNull();
    });
  });
});
