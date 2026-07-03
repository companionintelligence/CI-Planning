import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

/**
 * V7 — ResetPassword page. DOM-level proof of the three behaviours pure functions
 * can't cover: the submit button gates on a valid + matching password, a successful
 * reset calls the API and navigates to /login, and an invalid/expired token drops into
 * the inline recovery state.
 *
 * SEAMS mocked: `../lib/api.js` (api.auth.reset — no network), `@solidjs/router`
 * (useNavigate spy + a mutable useSearchParams), `../stores/index.js` (showToast), and
 * `../components/ForgotPassword.js` (stub — its own behaviour is out of scope here).
 */

const resetMock = vi.fn(async (_t: string, _p: string): Promise<{ ok: boolean }> => ({ ok: true }));
vi.mock('../lib/api.js', () => ({ api: { auth: { reset: (t: string, p: string) => resetMock(t, p) } } }));

const navigateMock = vi.fn();
let currentParams: Record<string, string> = {};
vi.mock('@solidjs/router', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [currentParams],
}));

const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({ showToast: (...a: unknown[]) => toastMock(...a) }));

vi.mock('../components/ForgotPassword.js', () => ({
  ForgotPassword: (props: { onClose: () => void }) => <div data-testid="forgot-modal" onClick={props.onClose} />,
}));

const { ResetPassword } = await import('./ResetPassword.js');

const pw = (c: HTMLElement) => c.querySelectorAll<HTMLInputElement>('input[type="password"]');

describe('ResetPassword — reset flow', () => {
  beforeEach(() => {
    resetMock.mockReset().mockResolvedValue({ ok: true });
    navigateMock.mockReset();
    toastMock.mockReset();
    currentParams = { token: 'tok-123' };
  });

  it('gates submit until the password is long enough AND matches, then resets + navigates', async () => {
    const { container, getByText } = render(() => <ResetPassword />);
    const submit = getByText('Reset password') as HTMLButtonElement;
    const [p1, p2] = Array.from(pw(container));

    // Too short → disabled.
    fireEvent.input(p1, { target: { value: 'short' } });
    fireEvent.input(p2, { target: { value: 'short' } });
    expect(submit).toBeDisabled();

    // Long enough but mismatched → still disabled.
    fireEvent.input(p1, { target: { value: 'a-good-password-1' } });
    fireEvent.input(p2, { target: { value: 'different-1' } });
    expect(submit).toBeDisabled();

    // Long + matching → enabled; submit calls the API with the URL token and navigates.
    fireEvent.input(p2, { target: { value: 'a-good-password-1' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(resetMock).toHaveBeenCalledWith('tok-123', 'a-good-password-1'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }));
  });

  it('shows the recovery state when the token is rejected as invalid/expired', async () => {
    resetMock.mockRejectedValueOnce(new Error('this reset link is invalid or has expired — request a new one'));
    const { container, getByText, findByText } = render(() => <ResetPassword />);
    const [p1, p2] = Array.from(pw(container));
    fireEvent.input(p1, { target: { value: 'a-good-password-1' } });
    fireEvent.input(p2, { target: { value: 'a-good-password-1' } });
    fireEvent.click(getByText('Reset password'));

    expect(await findByText(/invalid or expired/i)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('shows the recovery state immediately when there is no token in the URL', () => {
    currentParams = {};
    const { getByText } = render(() => <ResetPassword />);
    expect(getByText(/invalid or expired/i)).toBeInTheDocument();
  });
});
