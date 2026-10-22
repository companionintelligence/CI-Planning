import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';
import type { AuthConfigResponse, SignupRequirements, SignupBody } from '../lib/api.js';

/**
 * B2 — the /signup page. What it asks for follows the public requirements probe
 * (enabled / codeRequired), the Portal alternative follows `config.portal`, and a
 * successful sign-up reloads into the app (the server already set the cookie).
 *
 * SEAMS mocked: `../lib/api.js` (config / signupRequirements / me / signup — no
 * network) and `@solidjs/router` (useNavigate spy).
 */

const START = '/api/auth/ciportal/start';
const configMock = vi.fn<() => Promise<AuthConfigResponse>>();
const reqMock = vi.fn<() => Promise<SignupRequirements>>();
const meMock = vi.fn<() => Promise<unknown>>(async () => { throw new Error('unauthenticated'); });
const signupMock = vi.fn(async (_b: SignupBody): Promise<{ ok: boolean; ownerId: string; role: 'operator' | 'member' | 'viewer' }> =>
  ({ ok: true, ownerId: 'o1', role: 'member' }));
vi.mock('../lib/api.js', () => ({
  api: {
    auth: {
      config: () => configMock(),
      signupRequirements: () => reqMock(),
      me: () => meMock(),
      signup: (b: SignupBody) => signupMock(b),
    },
  },
  CIPORTAL_START: '/api/auth/ciportal/start',
}));

const navigateMock = vi.fn();
vi.mock('@solidjs/router', () => ({ useNavigate: () => navigateMock }));

const { Signup } = await import('./Signup.js');

const cfg = (over: Partial<AuthConfigResponse> = {}): AuthConfigResponse => ({
  mode: 'sso', disableOidc: true, portal: false, local: true, signup: 'invite', ...over,
});

async function renderSignup(config: AuthConfigResponse, req: SignupRequirements) {
  configMock.mockResolvedValue(config);
  reqMock.mockResolvedValue(req);
  const r = render(() => <Signup />);
  await waitFor(() => expect(r.container.querySelector('h1')).toBeTruthy());
  return r;
}

const byAutocomplete = (c: HTMLElement, ac: string) => c.querySelector<HTMLInputElement>(`input[autocomplete="${ac}"]`);
const passwords = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLInputElement>('input[type="password"]'));
const submitButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const portalLinks = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLAnchorElement>(`a[href="${START}"]`));

function fillValid(c: HTMLElement, opts: { code?: string } = {}) {
  fireEvent.input(byAutocomplete(c, 'name')!, { target: { value: ' Sam Signup ' } });
  fireEvent.input(byAutocomplete(c, 'username')!, { target: { value: 'sam' } });
  fireEvent.input(byAutocomplete(c, 'email')!, { target: { value: 'sam@test.local' } });
  const [p1, p2] = passwords(c);
  fireEvent.input(p1, { target: { value: 'a-good-password-1' } });
  fireEvent.input(p2, { target: { value: 'a-good-password-1' } });
  if (opts.code !== undefined) fireEvent.input(byAutocomplete(c, 'one-time-code')!, { target: { value: opts.code } });
}

beforeEach(() => {
  configMock.mockReset();
  reqMock.mockReset();
  meMock.mockReset().mockRejectedValue(new Error('unauthenticated'));
  signupMock.mockReset().mockResolvedValue({ ok: true, ownerId: 'o1', role: 'member' });
  navigateMock.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Signup — invite mode (AUTH_SIGNUP=invite)', () => {
  it('asks for the invite code and gates submit until every field is valid, then signs up with the code and reloads', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { container, getByText } = await renderSignup(cfg(), { enabled: true, codeRequired: true });
    expect(getByText('Create your account')).toBeInTheDocument();
    expect(getByText(/You need an invite code/)).toBeInTheDocument();
    expect(byAutocomplete(container, 'one-time-code')).toBeTruthy();
    expect(submitButton(container)).toBeDisabled();

    fillValid(container); // everything but the code
    expect(submitButton(container)).toBeDisabled();
    fireEvent.input(byAutocomplete(container, 'one-time-code')!, { target: { value: ' abcd-efgh-jkmn ' } });
    expect(submitButton(container)).not.toBeDisabled();

    fireEvent.click(submitButton(container));
    await waitFor(() => expect(signupMock).toHaveBeenCalledWith({
      name: 'Sam Signup', username: 'sam', email: 'sam@test.local', password: 'a-good-password-1', code: 'abcd-efgh-jkmn',
    }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('a taken username (409) shows an inline error and keeps the form', async () => {
    signupMock.mockRejectedValueOnce(Object.assign(new Error('that username is not available'), { status: 409 }));
    const { container, findByText } = await renderSignup(cfg(), { enabled: true, codeRequired: true });
    fillValid(container, { code: 'ABCD-EFGH-JKMN' });
    fireEvent.click(submitButton(container));
    expect(await findByText(/That username is not available/)).toBeInTheDocument();
    expect(byAutocomplete(container, 'username')).toBeTruthy();
  });

  it('a bad or spent code (400) surfaces the server message; 429 says to wait', async () => {
    signupMock.mockRejectedValueOnce(Object.assign(new Error('that invite code is invalid, already used, or has expired'), { status: 400 }));
    const { container, findByText } = await renderSignup(cfg(), { enabled: true, codeRequired: true });
    fillValid(container, { code: 'ZZZZ-ZZZZ-ZZZZ' });
    fireEvent.click(submitButton(container));
    expect(await findByText(/invalid, already used, or has expired/)).toBeInTheDocument();

    signupMock.mockRejectedValueOnce(Object.assign(new Error('too many attempts'), { status: 429 }));
    fireEvent.click(submitButton(container));
    expect(await findByText(/Too many attempts/)).toBeInTheDocument();
  });

  it('flags a username with spaces and a short / mismatched password inline', async () => {
    const { container, getByText } = await renderSignup(cfg(), { enabled: true, codeRequired: true });
    fireEvent.input(byAutocomplete(container, 'username')!, { target: { value: 'has space' } });
    expect(getByText('No spaces.')).toBeInTheDocument();
    const [p1, p2] = passwords(container);
    fireEvent.input(p1, { target: { value: 'short' } });
    expect(getByText(/At least 8 characters/)).toBeInTheDocument();
    fireEvent.input(p1, { target: { value: 'long-enough-1' } });
    fireEvent.input(p2, { target: { value: 'different-1' } });
    expect(getByText("Passwords don't match.")).toBeInTheDocument();
    expect(submitButton(container)).toBeDisabled();
  });
});

describe('Signup — open mode (AUTH_SIGNUP=open)', () => {
  it('has no code field and signs up without one', async () => {
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    const { container, getByText } = await renderSignup(cfg({ signup: 'open' }), { enabled: true, codeRequired: false });
    expect(getByText('Pick a username and password.')).toBeInTheDocument();
    expect(byAutocomplete(container, 'one-time-code')).toBeNull();
    fillValid(container);
    expect(submitButton(container)).not.toBeDisabled();
    fireEvent.click(submitButton(container));
    await waitFor(() => expect(signupMock).toHaveBeenCalledTimes(1));
    expect(signupMock.mock.calls[0][0]).not.toHaveProperty('code');
  });
});

describe('Signup — off (AUTH_SIGNUP=off) or the probe failed', () => {
  it('renders the by-invitation notice and no form', async () => {
    const { container, getByText } = await renderSignup(cfg({ signup: 'off' }), { enabled: false, codeRequired: false });
    expect(getByText('Sign-up is by invitation')).toBeInTheDocument();
    expect(container.querySelector('form')).toBeNull();
    expect(portalLinks(container)).toHaveLength(0);
    expect(container.querySelector('a[href="/login"]')).toBeTruthy();
  });

  it('still offers the Portal when it is on', async () => {
    const { container, getByText } = await renderSignup(cfg({ portal: true, disableOidc: false, signup: 'portal' }), { enabled: false, codeRequired: false });
    expect(getByText('Sign up with Companion Portal')).toBeInTheDocument();
    expect(portalLinks(container)).toHaveLength(1);
    expect(container.querySelector('form')).toBeNull();
  });
});

describe('Signup — B1 alternative under Companion Portal login', () => {
  it('shows "Sign up with Companion Portal" beside the local form, pointing at the same /start URL', async () => {
    const { container, getByText } = await renderSignup(cfg({ portal: true, disableOidc: false, signup: 'portal' }), { enabled: true, codeRequired: true });
    expect(container.querySelector('form')).toBeTruthy();
    expect(getByText('Sign up with Companion Portal')).toBeInTheDocument();
    expect(portalLinks(container).map((a) => a.getAttribute('href'))).toEqual([START]);
  });

  it('no Portal link when the portal is off', async () => {
    const { container } = await renderSignup(cfg({ portal: false }), { enabled: true, codeRequired: true });
    expect(portalLinks(container)).toHaveLength(0);
  });
});

describe('Signup — already signed in', () => {
  it('bounces to /', async () => {
    meMock.mockResolvedValue({ ownerId: 'x' });
    await renderSignup(cfg(), { enabled: true, codeRequired: true });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
  });
});
