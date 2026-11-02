import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';
import type { AuthConfigResponse } from '../lib/api.js';

/**
 * A4/B1/B2 — the login screen is driven by the server's capability flags
 * (`GET /api/auth/config` → { portal, local, signup }), never by inferring them from
 * `mode`/`disableOidc`. Every combination the server can report is rendered here and
 * the exact affordances asserted: which buttons, whether the username form is folded
 * behind "Sign in with username instead", which sign-up line (Portal / invite /
 * open / none), and how a Portal refusal reads (B1's org-membership copy vs generic).
 *
 * SEAMS mocked: `../lib/api.js` (config/me/login — no network), `@solidjs/router`
 * (useNavigate spy + a mutable useSearchParams), `../stores/index.js` (showToast) and
 * `../components/ForgotPassword.js` (stub).
 */

const START = '/api/auth/ciportal/start';
const configMock = vi.fn<() => Promise<AuthConfigResponse>>();
const meMock = vi.fn<() => Promise<unknown>>(async () => { throw new Error('unauthenticated'); });
const loginMock = vi.fn(async (_u: string, _p: string): Promise<{ ok: boolean }> => ({ ok: true }));
vi.mock('../lib/api.js', () => ({
  api: { auth: { config: () => configMock(), me: () => meMock(), login: (u: string, p: string) => loginMock(u, p) } },
  CIPORTAL_START: '/api/auth/ciportal/start',
}));

const navigateMock = vi.fn();
let currentParams: Record<string, string> = {};
let currentState: unknown;
vi.mock('@solidjs/router', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [currentParams],
  useLocation: () => ({ state: currentState }),
}));

const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({ showToast: (...a: unknown[]) => toastMock(...a) }));

vi.mock('../components/ForgotPassword.js', () => ({
  ForgotPassword: (props: { onClose: () => void }) => <div data-testid="forgot-modal" onClick={props.onClose} />,
}));

const { Login } = await import('./Login.js');

const cfg = (over: Partial<AuthConfigResponse>): AuthConfigResponse => ({
  mode: 'sso', disableOidc: false, portal: true, local: true, signup: 'portal', ...over,
});

/** Render and wait for the config resource to settle (the card shows a spinner until then). */
async function renderLogin(config: AuthConfigResponse) {
  configMock.mockResolvedValue(config);
  const r = render(() => <Login />);
  await waitFor(() => expect(r.getByText('Sign in', { selector: 'h1' })).toBeInTheDocument());
  return r;
}

const portalButton = (c: HTMLElement) => c.querySelector<HTMLAnchorElement>(`a[href="${START}"].btn-primary`);
const usernameInput = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[autocomplete="username"]');
const passwordInput = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="password"]');
const signupLink = (c: HTMLElement) => c.querySelector<HTMLAnchorElement>('a[href="/signup"]');
const createWithPortal = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLAnchorElement>(`a[href="${START}"]`)).find((a) => /Create one with Companion Portal/.test(a.textContent ?? ''));

beforeEach(() => {
  configMock.mockReset();
  meMock.mockReset().mockRejectedValue(new Error('unauthenticated'));
  loginMock.mockReset().mockResolvedValue({ ok: true });
  navigateMock.mockReset();
  toastMock.mockReset();
  currentParams = {};
  currentState = undefined;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Login — returning to the page they asked for (Companion Memory parity)', () => {
  // SessionGate sends an unauthenticated visit here with the page it was for in router state.
  // The Portal sign-in carries it on, and the server checks it again when it sends them back.
  it('the Portal sign-in carries the page SessionGate was sending them away from', async () => {
    currentState = { from: '/shared/abc123?tab=notes' };
    const { container } = await renderLogin(cfg({ portal: true, local: false, signup: 'off' }));
    expect(portalButton(container)).toBeNull(); // the plain start URL would drop the page
    const link = container.querySelector<HTMLAnchorElement>(`a.btn-primary[href^="${START}?redirect="]`);
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe(`${START}?redirect=${encodeURIComponent('/shared/abc123?tab=notes')}`);
  });

  it('a destination that is not a same-origin path is not carried', async () => {
    currentState = { from: '//evil.example' };
    const { container } = await renderLogin(cfg({ portal: true, local: false, signup: 'off' }));
    expect(portalButton(container)).toBeTruthy();
  });

  it('the login screen itself is never a destination', async () => {
    currentState = { from: '/login' };
    const { container } = await renderLogin(cfg({ portal: true, local: false, signup: 'off' }));
    expect(portalButton(container)).toBeTruthy();
  });
});

describe('Login — portal + local (the Hub default after A2/A3)', () => {
  it('shows the Portal button first and folds the username form behind "Sign in with username instead"', async () => {
    const { container, getByText, queryByText } = await renderLogin(cfg({ portal: true, local: true, signup: 'portal' }));
    expect(getByText('Use your Companion Portal account to continue.')).toBeInTheDocument();
    expect(portalButton(container)).toBeTruthy();
    expect(getByText('Continue with Companion Portal')).toBeInTheDocument();
    const secondary = getByText('Sign in with username instead');
    expect(secondary).toBeInTheDocument();
    // Folded: no form yet.
    expect(usernameInput(container)).toBeNull();
    expect(queryByText('Forgot password?')).toBeNull();

    fireEvent.click(secondary);
    // Expanded IN PLACE: the Portal button stays, the toggle goes, the form appears
    // with "Forgot password?" under it.
    await waitFor(() => expect(usernameInput(container)).toBeTruthy());
    expect(passwordInput(container)).toBeTruthy();
    expect(getByText('Forgot password?')).toBeInTheDocument();
    expect(portalButton(container)).toBeTruthy();
    expect(queryByText('Sign in with username instead')).toBeNull();
  });

  it('B1: the sign-up line sends to the same Portal /start and says the account must be in the Hub org', async () => {
    const { container, getByText } = await renderLogin(cfg({ portal: true, local: true, signup: 'portal' }));
    const link = createWithPortal(container);
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe(START);
    expect(getByText(/Don't have an account\?/)).toBeInTheDocument();
    expect(getByText(/member of the Hub's organization/)).toBeInTheDocument();
    expect(signupLink(container)).toBeNull(); // the Portal owns sign-up here, not /signup
  });

  it('the expanded local form signs in with the trimmed username and reloads into the app', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { container, getByText } = await renderLogin(cfg({ portal: true, local: true }));
    fireEvent.click(getByText('Sign in with username instead'));
    await waitFor(() => expect(usernameInput(container)).toBeTruthy());
    fireEvent.input(usernameInput(container)!, { target: { value: '  ada  ' } });
    fireEvent.input(passwordInput(container)!, { target: { value: 'hunter22hunter' } });
    fireEvent.click(getByText('Sign in', { selector: 'button[type="submit"]' }));
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('ada', 'hunter22hunter'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('a rejected local login shows the generic toast (no enumeration) and stays on the page', async () => {
    loginMock.mockRejectedValueOnce(new Error('invalid credentials'));
    const { container, getByText } = await renderLogin(cfg({ portal: true, local: true }));
    fireEvent.click(getByText('Sign in with username instead'));
    await waitFor(() => expect(usernameInput(container)).toBeTruthy());
    fireEvent.input(usernameInput(container)!, { target: { value: 'ghost' } });
    fireEvent.input(passwordInput(container)!, { target: { value: 'nope-nope-nope' } });
    fireEvent.click(getByText('Sign in', { selector: 'button[type="submit"]' }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Invalid username or password', 'error'));
    expect(usernameInput(container)).toBeTruthy();
  });
});

describe('Login — local only (DISABLE_OIDC=true)', () => {
  it('shows the username form directly, no Portal button, no toggle', async () => {
    const { container, getByText, queryByText } = await renderLogin(cfg({ portal: false, local: true, signup: 'invite' }));
    expect(getByText('Enter your username and password.')).toBeInTheDocument();
    expect(usernameInput(container)).toBeTruthy();
    expect(passwordInput(container)).toBeTruthy();
    expect(getByText('Forgot password?')).toBeInTheDocument();
    expect(portalButton(container)).toBeNull();
    expect(queryByText('Continue with Companion Portal')).toBeNull();
    expect(queryByText('Sign in with username instead')).toBeNull();
    expect(createWithPortal(container)).toBeUndefined();
  });

  it('B2 invite: the sign-up line goes to /signup and mentions the invite code', async () => {
    const { container, getByText } = await renderLogin(cfg({ portal: false, local: true, signup: 'invite' }));
    expect(signupLink(container)).toBeTruthy();
    expect(getByText(/Don't have an account\?/).textContent).toMatch(/Sign up with an invite code/);
  });

  it('B2 open: the sign-up line goes to /signup without the invite-code hint', async () => {
    const { container, getByText } = await renderLogin(cfg({ portal: false, local: true, signup: 'open' }));
    expect(signupLink(container)).toBeTruthy();
    expect(getByText(/Don't have an account\?/).textContent).not.toMatch(/invite code/);
  });

  it('signup off: no sign-up line at all', async () => {
    const { container, queryByText } = await renderLogin(cfg({ portal: false, local: true, signup: 'off' }));
    expect(signupLink(container)).toBeNull();
    expect(createWithPortal(container)).toBeUndefined();
    expect(queryByText(/Don't have an account\?/)).toBeNull();
  });
});

describe('Login — degenerate flag combinations the server could still report', () => {
  it('portal only: the Portal button and nothing local', async () => {
    const { container, queryByText } = await renderLogin(cfg({ portal: true, local: false, signup: 'portal' }));
    expect(portalButton(container)).toBeTruthy();
    expect(usernameInput(container)).toBeNull();
    expect(queryByText('Sign in with username instead')).toBeNull();
    expect(queryByText('Forgot password?')).toBeNull();
    expect(createWithPortal(container)).toBeTruthy();
  });

  it('neither method: says so instead of rendering an empty card', async () => {
    const { container, getByText } = await renderLogin(cfg({ portal: false, local: false, signup: 'off' }));
    expect(getByText('Sign-in is not enabled on this deployment.')).toBeInTheDocument();
    expect(portalButton(container)).toBeNull();
    expect(usernameInput(container)).toBeNull();
  });
});

describe('Login — ?sso_error= from the Portal callback (B1)', () => {
  it.each(['invalid_redirect_uri', 'access_denied', 'unauthorized_client'])(
    '%s reads as the org-membership refusal with the actionable ask',
    async (code) => {
      currentParams = { sso_error: code };
      const { container } = await renderLogin(cfg({}));
      const alert = container.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain("Ask your Hub's owner to invite you to the organization, then try again.");
      expect(alert.textContent).toContain(code); // the raw code stays visible for support
      expect(alert.textContent).not.toMatch(/cancelled or failed/);
    },
  );

  it('any other error keeps the generic "cancelled or failed" copy', async () => {
    currentParams = { sso_error: 'confirmation_expired' };
    const { container } = await renderLogin(cfg({}));
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toMatch(/Companion Portal sign-in was cancelled or failed \(confirmation_expired\)\. Please try again\./);
    expect(alert.textContent).not.toMatch(/invite you to the organization/);
  });

  it('no error, no banner', async () => {
    const { container } = await renderLogin(cfg({}));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('Login — already signed in', () => {
  it('bounces to / instead of showing the form', async () => {
    meMock.mockResolvedValue({ ownerId: 'x' });
    await renderLogin(cfg({}));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
  });
});

describe('Login — Capacitor mobile shell', () => {
  // The shell reaches this screen right after choosing a server. If that server is the wrong
  // one there must be a way back to the connect screen from here, because Settings (where the
  // server card also lives) sits behind this very login.
  it('offers "Change server…" with the connected address — in the shell only', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    localStorage.setItem('ci-planning.server-url', 'http://192.168.1.20:3848');
    try {
      const { getByTestId, getByRole } = await renderLogin(cfg({ portal: false, local: true, signup: 'off' }));
      expect(getByTestId('server-url')).toHaveTextContent('http://192.168.1.20:3848');
      expect(getByRole('button', { name: /change server/i })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('ci-planning.server-url');
    }
  });

  it('shows no server card in a browser', async () => {
    const { queryByTestId, queryByRole } = await renderLogin(cfg({ portal: false, local: true, signup: 'off' }));
    expect(queryByTestId('server-url')).toBeNull();
    expect(queryByRole('button', { name: /change server/i })).toBeNull();
  });
});

describe('Login — Capacitor mobile shell: username and password only', () => {
  // Capacitor hands any top-level navigation off the app's own origin to the system browser,
  // so a sign-in that redirects out and back finishes in Safari with the cookie, and the app
  // never sees the session. The shell therefore offers the one sign-in it can complete.
  beforeEach(() => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    localStorage.setItem('ci-planning.server-url', 'http://192.168.1.20:3848');
  });
  afterEach(() => {
    localStorage.removeItem('ci-planning.server-url');
  });

  it('on a server with Portal and username sign-in, shows the username form alone: no Portal button, no toggle, no sign-up', async () => {
    const { container, getByText, queryByText } = await renderLogin(cfg({ portal: true, local: true, signup: 'portal' }));

    expect(usernameInput(container)).toBeTruthy(); // not folded behind "Sign in with username instead"
    expect(passwordInput(container)).toBeTruthy();
    expect(getByText('Enter your username and password.')).toBeInTheDocument();
    expect(portalButton(container)).toBeNull();
    expect(queryByText('Continue with Companion Portal')).toBeNull();
    expect(queryByText('Sign in with username instead')).toBeNull();
    expect(createWithPortal(container)).toBeUndefined();
    expect(queryByText(/Don't have an account\?/)).toBeNull();
    expect(container.querySelector(`a[href="${START}"]`)).toBeNull(); // no way out at all
  });

  it.each(['invite', 'open'] as const)('offers no /signup link where the server allows sign-up (%s)', async (signup) => {
    const { container, queryByText } = await renderLogin(cfg({ portal: false, local: true, signup }));

    expect(usernameInput(container)).toBeTruthy();
    expect(signupLink(container)).toBeNull();
    expect(queryByText(/Don't have an account\?/)).toBeNull();
  });

  it('on a server that only offers Portal sign-in, says so instead of showing a button that cannot work', async () => {
    const { container, getByText, queryByText } = await renderLogin(cfg({ portal: true, local: false, signup: 'portal' }));

    expect(getByText(/only offers Companion Portal sign-in, which the app can't do yet/)).toBeInTheDocument();
    expect(getByText(/Sign in from a browser, or ask whoever runs this server/)).toBeInTheDocument();
    expect(portalButton(container)).toBeNull();
    expect(usernameInput(container)).toBeNull();
    expect(queryByText('Sign-in is not enabled on this deployment.')).toBeNull();
    // The way back to the connect screen is still there: the wrong server is the likeliest cause.
    expect(container.querySelector('[data-testid="server-url"]')).toBeTruthy();
  });

  it('still signs in with the username form', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { container } = await renderLogin(cfg({ portal: true, local: true }));

    fireEvent.input(usernameInput(container)!, { target: { value: '  ada  ' } });
    fireEvent.input(passwordInput(container)!, { target: { value: 'pw' } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('ada', 'pw'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('a browser keeps every option the server offers', async () => {
    vi.unstubAllGlobals(); // not the shell
    const { container, getByText } = await renderLogin(cfg({ portal: true, local: true, signup: 'portal' }));

    expect(portalButton(container)).toBeTruthy();
    expect(getByText('Sign in with username instead')).toBeInTheDocument();
    expect(createWithPortal(container)).toBeTruthy();
  });
});
