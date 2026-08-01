import { createSignal, createResource, createEffect, Show } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { Cpu, LogIn, Loader2 } from 'lucide-solid';
import { api, CIPORTAL_START } from '../lib/api.js';
import { showToast } from '../stores/index.js';
import { ForgotPassword } from '../components/ForgotPassword.js';

/**
 * U3 — the login screen. Rendered OUTSIDE the app shell (no nav/top bar), reached
 * only when the deployment gates on auth (`GET /api/auth/config` → mode==='sso'; see
 * App.tsx). Two paths, chosen by the same server config:
 *   - CI-Portal SSO (mode==='sso', disableOidc=false): a single "Continue with
 *     CI-Portal" button that does a TOP-LEVEL navigation to the RP /start endpoint
 *     (not a fetch — the browser must follow the 302 to the portal).
 *   - Local (mode==='sso', disableOidc=true): a username/password form POSTing to
 *     /api/auth/login; on success the server sets the session cookie and we go to '/'.
 * House-style only (this app's tokens/classes) — CI-Portal/CI-Hub visual parity is a
 * later reconciliation pass, per the plan (their components aren't available here).
 */
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

  // A provider error bounced back from the CI-Portal callback (?sso_error=…).
  const ssoError = () => (typeof params.sso_error === 'string' ? params.sso_error : null);

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
      // resources with the cookie present. This also matches the CI-Portal branch above,
      // which is a top-level navigation and so was never affected.
      window.location.assign('/');
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
            <div class="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              CI-Portal sign-in was cancelled or failed ({ssoError()}). Please try again.
            </div>
          </Show>

          <Show
            when={cfg()}
            fallback={<div class="flex justify-center py-6 text-muted-foreground"><Loader2 class="animate-spin" size={18} /></div>}
          >
            <Show
              when={cfg()!.disableOidc}
              fallback={
                /* CI-Portal SSO */
                <div class="flex flex-col gap-4">
                  <div class="text-center">
                    <h1 class="text-base font-semibold text-foreground">Sign in</h1>
                    <p class="text-xs text-muted-foreground mt-1">Use your CI-Portal account to continue.</p>
                  </div>
                  {/* Top-level navigation (NOT fetch) so the browser follows the redirect to the portal. */}
                  <a class="btn-primary w-full justify-center" href={CIPORTAL_START}>
                    <LogIn size={16} />
                    Continue with CI-Portal
                  </a>
                </div>
              }
            >
              {/* Local username/password */}
              <form class="flex flex-col gap-3" onSubmit={submitLocal}>
                <div class="text-center mb-1">
                  <h1 class="text-base font-semibold text-foreground">Sign in</h1>
                  <p class="text-xs text-muted-foreground mt-1">Enter your username and password.</p>
                </div>
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Username</span>
                  <input
                    class="input text-sm"
                    autofocus
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
                {/* V6 — reset flow entry point. */}
                <button
                  type="button"
                  class="text-[11px] text-muted-foreground hover:text-foreground transition-colors mt-1 self-center"
                  onClick={() => setShowForgot(true)}
                >
                  Forgot password?
                </button>
              </form>
            </Show>
          </Show>
        </div>

        <p class="text-center text-[11px] text-muted-foreground mt-4">Companion Planning</p>
      </div>

      <Show when={showForgot()}>
        <ForgotPassword onClose={() => setShowForgot(false)} />
      </Show>
    </div>
  );
}
