import { createSignal, createMemo, createResource, createEffect, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Cpu, Loader2, LogIn, UserPlus } from 'lucide-solid';
import { api, CIPORTAL_START } from '../lib/api.js';

/**
 * B2 — local self-serve sign-up (Companion Memory's `/signup` page). Unauthenticated
 * route rendered bare, like /login. What it asks for comes from the public
 * `GET /api/auth/signup/requirements`: whether sign-up is on at all (AUTH_SIGNUP), and
 * whether an operator-minted invite code is required (`invite`) or not (`open`).
 * The person picks their OWN username and password — the operator who handed out the
 * code never sees either (the 2026-07-12 ruling). On success the server has set the
 * session cookie; we reload into '/' for the same reason Login.tsx does.
 *
 * Under Companion Portal login the page also offers "Sign up with Companion Portal" —
 * the same /start URL as sign-in (the Portal's own card carries its sign-up toggle).
 */
const MIN_PASSWORD_LENGTH = 8;

export function Signup() {
  const navigate = useNavigate();
  const [cfg] = createResource(() => api.auth.config());
  const [req] = createResource(() => api.auth.signupRequirements());

  // Already signed in? There is nothing to sign up for.
  const [alreadyIn] = createResource(() => api.auth.me().then(() => true).catch(() => false));
  createEffect(() => {
    if (!alreadyIn.loading && alreadyIn()) navigate('/', { replace: true });
  });

  const [name, setName] = createSignal('');
  const [username, setUsername] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [confirm, setConfirm] = createSignal('');
  const [code, setCode] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const codeRequired = () => req()?.codeRequired === true;
  const portal = () => cfg()?.portal === true;

  const usernameInvalid = createMemo(() => username().length > 0 && /\s/.test(username()));
  const tooShort = createMemo(() => password().length > 0 && password().length < MIN_PASSWORD_LENGTH);
  const mismatch = createMemo(() => confirm().length > 0 && confirm() !== password());
  const canSubmit = createMemo(
    () =>
      !!name().trim() &&
      !!username().trim() &&
      !usernameInvalid() &&
      email().trim().includes('@') &&
      password().length >= MIN_PASSWORD_LENGTH &&
      confirm() === password() &&
      (!codeRequired() || !!code().trim()) &&
      !submitting(),
  );

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.auth.signup({
        name: name().trim(),
        username: username().trim(),
        email: email().trim(),
        password: password(),
        ...(codeRequired() ? { code: code().trim() } : {}),
      });
      // Full-document load — see Login.tsx for why navigate() would hang on the gate.
      window.location.assign('/');
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const msg = (err as Error).message ?? '';
      if (status === 409) setError('That username is not available — pick another.');
      else if (status === 429) setError('Too many attempts — wait a minute and try again.');
      else if (status === 404) setError('Sign-up is not enabled on this deployment.');
      else setError(msg || 'Could not create your account. Try again.');
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
          <Show
            when={!req.loading && !cfg.loading}
            fallback={<div class="flex justify-center py-6 text-muted-foreground"><Loader2 class="animate-spin" size={18} /></div>}
          >
            <Show
              when={req()?.enabled}
              fallback={
                /* AUTH_SIGNUP=off (or the probe failed): nothing to fill in. */
                <div class="flex flex-col gap-3">
                  <div class="text-center">
                    <h1 class="text-base font-semibold text-foreground">Sign-up is by invitation</h1>
                    <p class="text-xs text-muted-foreground mt-1">
                      Ask this deployment's operator for an account
                      <Show when={portal()}>, or create one with your Companion Portal account</Show>.
                    </p>
                  </div>
                  <Show when={portal()}>
                    <a class="btn-primary w-full justify-center" href={CIPORTAL_START} rel="external">
                      <LogIn size={16} /> Sign up with Companion Portal
                    </a>
                  </Show>
                </div>
              }
            >
              <form class="flex flex-col gap-3" onSubmit={submit} aria-label="Create account">
                <div class="text-center mb-1">
                  <h1 class="text-base font-semibold text-foreground">Create your account</h1>
                  <p class="text-xs text-muted-foreground mt-1">
                    <Show when={codeRequired()} fallback={'Pick a username and password.'}>
                      You need an invite code from this deployment's operator.
                    </Show>
                  </p>
                </div>

                <Show when={error()}>
                  <div class="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                    {error()}
                  </div>
                </Show>

                <Show when={codeRequired()}>
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] text-muted-foreground">Invite code</span>
                    <input
                      class="input text-sm font-mono tracking-wider uppercase"
                      autofocus
                      autocomplete="one-time-code"
                      placeholder="XXXX-XXXX-XXXX"
                      value={code()}
                      onInput={(e) => setCode(e.currentTarget.value)}
                    />
                  </label>
                </Show>
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Name</span>
                  <input
                    class="input text-sm"
                    autofocus={!codeRequired()}
                    autocomplete="name"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Username</span>
                  <input
                    class="input text-sm"
                    autocomplete="username"
                    value={username()}
                    onInput={(e) => setUsername(e.currentTarget.value)}
                  />
                  <Show when={usernameInvalid()}>
                    <span class="text-[11px] text-destructive">No spaces.</span>
                  </Show>
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Email <span class="opacity-70">· for password resets</span></span>
                  <input
                    class="input text-sm"
                    type="email"
                    autocomplete="email"
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Password</span>
                  <input
                    class="input text-sm"
                    type="password"
                    autocomplete="new-password"
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                  <Show when={tooShort()}>
                    <span class="text-[11px] text-destructive">At least {MIN_PASSWORD_LENGTH} characters.</span>
                  </Show>
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Confirm password</span>
                  <input
                    class="input text-sm"
                    type="password"
                    autocomplete="new-password"
                    value={confirm()}
                    onInput={(e) => setConfirm(e.currentTarget.value)}
                  />
                  <Show when={mismatch()}>
                    <span class="text-[11px] text-destructive">Passwords don't match.</span>
                  </Show>
                </label>
                <button type="submit" class="btn-primary w-full justify-center mt-1" disabled={!canSubmit()}>
                  <Show when={submitting()} fallback={<><UserPlus size={16} /> Create account</>}>
                    <Loader2 class="animate-spin" size={16} /> Creating…
                  </Show>
                </button>

                {/* B1 — the Portal alternative, when it is on. */}
                <Show when={portal()}>
                  <div class="flex items-center gap-3 text-[11px] text-muted-foreground mt-1">
                    <span class="flex-1 border-t border-border" />
                    or
                    <span class="flex-1 border-t border-border" />
                  </div>
                  <a class="btn-secondary w-full justify-center" href={CIPORTAL_START} rel="external">
                    <LogIn size={14} /> Sign up with Companion Portal
                  </a>
                </Show>
              </form>
            </Show>
          </Show>
        </div>

        <p class="text-center text-xs text-muted-foreground mt-4">
          Already have an account?{' '}
          <a class="text-foreground underline underline-offset-2 hover:text-primary transition-colors" href="/login">
            Sign in
          </a>
        </p>
        <p class="text-center text-[11px] text-muted-foreground mt-4">Companion Planning</p>
      </div>
    </div>
  );
}
