import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@solidjs/testing-library';
import axe from 'axe-core';
import type { AuthConfigResponse } from './lib/api.js';

/**
 * Accessibility checks that run with the rest of the client suite, so CI fails when a rule that
 * axe can judge in jsdom breaks. Rules that need layout (colour contrast, for one) need a real
 * browser and are not run here. `region` is off because these are fragments, not whole pages.
 *
 * SEAMS mocked as in Login.test.tsx: the api (no network), the router, the toast store and the
 * forgot-password modal.
 */

const configMock = vi.fn<() => Promise<AuthConfigResponse>>();
vi.mock('./lib/api.js', () => ({
  api: {
    auth: {
      config: () => configMock(),
      me: async () => { throw new Error('unauthenticated'); },
      login: async () => ({ ok: true }),
    },
  },
  CIPORTAL_START: '/api/auth/ciportal/start',
}));
vi.mock('@solidjs/router', () => ({
  useNavigate: () => () => {},
  useSearchParams: () => [{}],
  useLocation: () => ({ state: undefined }),
}));
vi.mock('./stores/index.js', () => ({ showToast: () => {} }));
vi.mock('./components/ForgotPassword.js', () => ({ ForgotPassword: () => null }));

const { Login } = await import('./views/Login.js');
const { BootScreen } = await import('./components/BootScreen.js');

/** The axe violations under `el`, as `rule-id: what it means`, so a failure names the problem. */
async function violationsIn(el: Element): Promise<string[]> {
  const { violations } = await axe.run(el, { rules: { region: { enabled: false } } });
  return violations.map((v) => `${v.id}: ${v.help}`);
}

describe('accessibility (axe, jsdom)', () => {
  it('login screen has no violations', async () => {
    configMock.mockResolvedValue({ mode: 'sso', disableOidc: false, portal: true, local: true, signup: 'portal' });
    const r = render(() => <Login />);
    await waitFor(() => expect(r.getByText('Sign in', { selector: 'h1' })).toBeInTheDocument());
    expect(await violationsIn(r.container)).toEqual([]);
  });

  it('boot screen has no violations', async () => {
    const r = render(() => <BootScreen />);
    expect(await violationsIn(r.container)).toEqual([]);
  });
});
