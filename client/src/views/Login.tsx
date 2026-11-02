import { createSignal, createResource, createEffect, Show } from 'solid-js';
import { useLocation, useNavigate, useSearchParams } from '@solidjs/router';
import { Cpu, LogIn, Loader2, UserRound } from 'lucide-solid';
import { api, CIPORTAL_START } from '../lib/api.js';
import { showToast } from '../stores/index.js';
import { ForgotPassword } from '../components/ForgotPassword.js';
import { ServerConnection } from '../components/ServerConnection.js';
import { isNativeShell, supportsRedirectFlows } from '../lib/server-config.js';

/**
 * U3/A4 — the login screen. Rendered OUTSIDE the app shell (no nav/top bar), reached
 * only when the deployment gates on auth (`GET /api/auth/config` → mode==='sso'; see
 * App.tsx). What it shows is driven by the server's capability flags, never inferred:
 *   - `portal`  → primary "Continue with Companion Portal": a TOP-LEVEL navigation to
 *                 the RP /start endpoint (not a fetch — the browser must follow the 302).
 *   - `local`   → the username/password form (POST /api/auth/login; on success the
 *                 server sets the session cookie and we reload into '/'). When BOTH are
 *                 on, the form is folded behind "Sign in with username instead" and
 *                 expands in place (Companion Memory's layout); alone, it shows directly.
 *   - `signup`  → the affordance under the card: `portal` (B1 — the Portal owns
 *                 sign-up; the same /start URL, the Portal's own card carries the
 *                 sign-up toggle), `invite`/`open` (B2 — /signup), or nothing.
 * `test`/`standalone` never reach this component (App.tsx renders the ungated router).
 *
 * In the Capacitor app shell only the username form is ever offered. The Portal button
 * and both sign-up links are redirects that have to come back with a cookie, which the
 * shell cannot do (see `supportsRedirectFlows`), and with no sign-up there is no account
 * creation in the app (App Store guideline 5.1.1(v) asks for in-app deletion wherever
 * there is). A server that offers Portal sign-in alone has nothing the shell can use, and
 * the screen says so rather than showing a dead button.
 *
 * House-style only (this app's tokens/classes) — CI-Portal/CI-Hub visual parity is a
 * later reconciliation pass, per the plan (their components aren't available here).
 */

/**
 * B1 — the Portal's refusal for someone who is not yet a member of the Hub's
 * organization. A brand-new Portal account has no org and no device, so on a tunnel or
 * tailnet host `/authorize` refuses the redirect until the Hub's owner invites them;
 * the refusal reaches us as `?sso_error=` in one of these shapes. Anything else keeps
 * the generic "cancelled or failed" copy.
 */
const PORTAL_MEMBERSHIP_ERRORS = new Set(['invalid_redirect_uri', 'access_denied', 'unauthorized_client']);

/**
 * The page the person was trying to reach when SessionGate sent them to this screen. It travels
 * as router state, so it survives the in-app navigation but not a reload. Only a same-origin path
 * is used here; the server checks it again when it sends them back.
 */
function returnPath(state: unknown): string | null {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== 'string' || from.length > 1024 || !from.startsWith('/') || from.startsWith('//')) return null;
  if (from === '/login') return null;
  for (const char of from) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x5c || code === 0x7f) return null;
  }
  return from;
}

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [cfg] = createResource(() => api.auth.config());

  // Already signed in (bookmark, back button after login, stale callback tab)? Bounce
  // to the app rather than showing the sign-in screen to an authenticated user.
  const [alreadyIn] = createResource(() => api.auth.me().then(() => true).catch(() => false));
  createEffect(() => {
    if (!alreadyIn.loading && alreadyIn()) navigate('/', { replace: true });
  });

  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [showForgot, setShowForgot] = createSignal(false);
  // A4: with both methods on, the username form starts folded behind a secondary action.
  const [localExpanded, setLocalExpanded] = createSignal(false);
  let usernameInput: HTMLInputElement | undefined;

  const location = useLocation();
  /** Where to send them once they are signed in (see returnPath). */
  const from = () => returnPath(location.state);
  /** The Portal sign-in, carrying that page. It is a top-level navigation, so the server reads it. */
  const portalHref = () => {
    const next = from();
    return next ? `${CIPORTAL_START}?redirect=${encodeURIComponent(next)}` : CIPORTAL_START;
  };

  const redirects = supportsRedirectFlows();
  const portal = () => redirects && cfg()?.portal === true;
  const local = () => cfg()?.local === true;
  const showLocalForm = () => local() && (!portal() || localExpanded());
  const signup = () => (redirects ? (cfg()?.signup ?? 'off') : 'off');
  /** The shell, on a server that signs in with Companion Portal alone: nothing it can offer. */
  const portalOnlyServer = () => !redirects && cfg()?.portal === true && !local();

  function expandLocal() {
    setLocalExpanded(true);
    // `autofocus` only fires on initial render; the form is mounting on a click.
    queueMicrotask(() => usernameInput?.focus());
  }

  // A provider error bounced back from the Companion Portal callback (?sso_error=…).
  const ssoError = () => (typeof params.sso_error === 'string' && params.sso_error ? params.sso_error : null);
  const membershipRefusal = () => PORTAL_MEMBERSHIP_ERRORS.has(ssoError() ?? '');

  async function submitLocal(e: Event) {
    e.preventDefault();
    if (!username().trim() || !password()) {
      showToast('Enter your username and password', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.login(username().trim(), password());
      // FULL-DOCUMENT load, not navigate() — the session only exists as of this response.
      // stores/index.ts creates ~19 module-scope resources at import time, so every one of
      // them already fired and 401'd while this login screen was on show. A client-side
      // route change mounts Shell against those *errored* resources; Solid rethrows the
      // stored 'unauthenticated' error, the router transition never settles, and the app
      // hangs on the SessionGate spinner until a manual refresh. Reloading re-creates the
      // resources with the cookie present. This also matches the Companion Portal branch,
      // which is a top-level navigation and so was never affected.
      window.location.assign(from() ?? '/');
    } catch {
      // The server returns a deliberately generic 401 — mirror it (no enumeration).
      showToast('Invalid username or password', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="min-h-screen flex items-center justify-center p-4 bg-surface-950">
      <div class="w-full max-w-sm">
        {/* Brand */}
        <div class="flex flex-col items-center gap-3 mb-8">
          <div
            class="w-12 h-12 rounded-2xl flex items-center justify-center text-surface-950"
            style={{ background: 'linear-gradient(135deg, #58ebbf, #409b9b)' }}
          >
            <Cpu size={22} />
          </div>
          <div class="text-center">
            <div class="text-[10px] font-medium tracking-[0.2em] uppercase" style={{ color: '#409b9b' }}>
              Companion
            </div>
            <div class="font-heading text-xl text-slate-100 tracking-wide">Planning</div>
          </div>
        </div>

        <div class="card">
          <Show when={ssoError()}>
            <div class="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              <Show
                when={membershipRefusal()}
                fallback={<>Companion Portal sign-in was cancelled or failed ({ssoError()}). Please try again.</>}
              >
                Companion Portal couldn't sign you in ({ssoError()}). Ask your Hub's owner to invite you to the
                organization, then try again.
              </Show>
            </div>
          </Show>

          <Show
            when={cfg()}
            fallback={<div class="flex justify-center py-6 text-muted-foreground"><Loader2 class="animate-spin" size={18} /></div>}
          >
            <div class="flex flex-col gap-4">
              <div class="text-center">
                <h1 class="text-base font-semibold text-foreground">Sign in</h1>
                <p class="text-xs text-muted-foreground mt-1">
                  <Show
                    when={portal()}
                    fallback={
                      portalOnlyServer()
                        ? "This server only offers Companion Portal sign-in, which the app can't do yet."
                        : local()
                          ? 'Enter your username and password.'
                          : 'Sign-in is not enabled on this deployment.'
                    }
                  >
                    Use your Companion Portal account to continue.
                  </Show>
                </p>
                <Show when={portalOnlyServer()}>
                  <p class="text-xs text-muted-foreground mt-2">
                    Sign in from a browser, or ask whoever runs this server to turn on username and password sign-in.
                  </p>
                </Show>
              </div>

              {/* Companion Portal SSO — top-level navigation (NOT fetch) so the browser follows the redirect to the portal. */}
              <Show when={portal()}>
                <a class="btn-primary w-full justify-center" href={portalHref()} rel="external">
                  <LogIn size={16} />
                  Continue with Companion Portal
                </a>
              </Show>

              {/* A4 — both methods on one screen: the username form expands in place. */}
              <Show when={portal() && local() && !localExpanded()}>
                <button type="button" class="btn-secondary w-full justify-center" onClick={expandLocal}>
                  <UserRound size={14} />
                  Sign in with username instead
                </button>
              </Show>

              <Show when={showLocalForm()}>
                <form class="flex flex-col gap-3" onSubmit={submitLocal} aria-label="Sign in with username">
                  <Show when={portal()}>
                    <div class="flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span class="flex-1 border-t border-border" />
                      or with a username
                      <span class="flex-1 border-t border-border" />
                    </div>
                  </Show>
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] text-muted-foreground">Username</span>
                    <input
                      ref={usernameInput}
                      class="input text-sm"
                      autofocus={!portal()}
                      autocomplete="username"
                      value={username()}
                      onInput={(e) => setUsername(e.currentTarget.value)}
                    />
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] text-muted-foreground">Password</span>
                    <input
                      class="input text-sm"
                      type="password"
                      autocomplete="current-password"
                      value={password()}
                      onInput={(e) => setPassword(e.currentTarget.value)}
                    />
                  </label>
                  <button type="submit" class="btn-primary w-full justify-center mt-1" disabled={submitting()}>
                    <Show when={submitting()} fallback={<>Sign in</>}>
                      <Loader2 class="animate-spin" size={16} /> Signing in…
                    </Show>
                  </button>
                  {/* V6 — reset flow entry point. Stays under the local form, where the password is. */}
                  <button
                    type="button"
                    class="text-[11px] text-muted-foreground hover:text-foreground transition-colors mt-1 self-center"
                    onClick={() => setShowForgot(true)}
                  >
                    Forgot password?
                  </button>
                </form>
              </Show>
            </div>
          </Show>
        </div>

        {/* B1 — the Portal is the sign-up path: same /start URL; the Portal's own login card
            carries its sign-up toggle and /api/oidc-resume brings the person back here, where
            the first-time confirmation (B3) creates the account. */}
        <Show when={signup() === 'portal'}>
          <p class="text-center text-xs text-muted-foreground mt-4">
            Don't have an account?{' '}
            <a class="text-foreground underline underline-offset-2 hover:text-primary transition-colors" href={portalHref()} rel="external">
              Create one with Companion Portal
            </a>
          </p>
          <p class="text-center text-[11px] text-muted-foreground/80 mt-1">
            On a Hub, your Portal account also needs to be a member of the Hub's organization first — ask its owner for an invitation.
          </p>
        </Show>
        {/* B2 — local self-serve sign-up (invite code or open). */}
        <Show when={signup() === 'invite' || signup() === 'open'}>
          <p class="text-center text-xs text-muted-foreground mt-4">
            Don't have an account?{' '}
            <a class="text-foreground underline underline-offset-2 hover:text-primary transition-colors" href="/signup">
              Sign up
            </a>
            <Show when={signup() === 'invite'}> with an invite code</Show>
          </p>
        </Show>

        {/* Mobile shell only: sign-in comes after choosing a server, so a wrong or retired address
            would otherwise be a dead end — Settings (where this card also lives) is behind this
            very screen. */}
        <Show when={isNativeShell()}>
          <div class="mt-4">
            <ServerConnection />
          </div>
        </Show>

        <p class="text-center text-[11px] text-muted-foreground mt-4">Companion Planning</p>
      </div>

      <Show when={showForgot()}>
        <ForgotPassword onClose={() => setShowForgot(false)} />
      </Show>
    </div>
  );
}
