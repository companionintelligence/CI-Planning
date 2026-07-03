import { createSignal, createMemo, Show } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { Cpu, Loader2 } from 'lucide-solid';
import { api } from '../lib/api.js';
import { showToast } from '../stores/index.js';
import { ForgotPassword } from '../components/ForgotPassword.js';

/**
 * V7 — the reset-password page. Unauthenticated route (like /login), rendered bare.
 * Reads `?token=` from the emailed link, takes a new + confirm password (client-side
 * strength + match check, mirroring the server's 8-char floor), and POSTs to
 * /api/auth/reset. A successful reset ALWAYS signs the account out on every device
 * (D5 — the server bumps the session epoch), so we say so rather than offering a
 * choice. Success → /login. An invalid/expired token drops into an inline recovery
 * state that reopens the "request a new link" modal.
 */
const MIN_PASSWORD_LENGTH = 8;

export function ResetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = () => (typeof params.token === 'string' ? params.token : '');

  const [password, setPassword] = createSignal('');
  const [confirm, setConfirm] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [expired, setExpired] = createSignal(false);
  const [showForgot, setShowForgot] = createSignal(false);

  const tooShort = createMemo(() => password().length > 0 && password().length < MIN_PASSWORD_LENGTH);
  const mismatch = createMemo(() => confirm().length > 0 && confirm() !== password());
  const canSubmit = createMemo(
    () => !!token() && password().length >= MIN_PASSWORD_LENGTH && confirm() === password() && !submitting(),
  );

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit()) return;
    setSubmitting(true);
    try {
      await api.auth.reset(token(), password());
      showToast('Password reset — sign in with your new password.', 'success');
      navigate('/login', { replace: true });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // The server 400s an invalid/expired/used token. Drop into the recovery state.
      if (/invalid|expired/i.test(msg)) {
        setExpired(true);
      } else {
        showToast(msg || 'Could not reset your password. Try again.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="min-h-screen flex items-center justify-center p-4 bg-surface-950">
      <div class="w-full max-w-sm">
        {/* Brand */}
        <div class="flex flex-col items-center gap-3 mb-8">
          <div class="w-12 h-12 rounded-2xl flex items-center justify-center text-primary-foreground bg-primary">
            <Cpu size={22} />
          </div>
          <div class="text-center">
            <div class="text-[10px] font-medium tracking-[0.2em] uppercase text-primary">Companion</div>
            <div class="font-heading text-xl text-slate-100 tracking-wide">Planning</div>
          </div>
        </div>

        <div class="card">
          <Show
            when={!expired() && token()}
            fallback={
              /* No token, or the token turned out to be invalid/expired. */
              <div class="flex flex-col gap-3">
                <div class="text-center">
                  <h1 class="text-base font-semibold text-foreground">This reset link is invalid or expired</h1>
                  <p class="text-xs text-muted-foreground mt-1">Request a fresh link and try again.</p>
                </div>
                <button class="btn-primary w-full justify-center" onClick={() => setShowForgot(true)}>
                  Request a new link
                </button>
                <a class="text-[11px] text-muted-foreground hover:text-foreground transition-colors self-center" href="/login">
                  Back to sign in
                </a>
              </div>
            }
          >
            <form class="flex flex-col gap-3" onSubmit={submit}>
              <div class="text-center mb-1">
                <h1 class="text-base font-semibold text-foreground">Choose a new password</h1>
                <p class="text-xs text-muted-foreground mt-1">Signs you out on all devices.</p>
              </div>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">New password</span>
                <input
                  class="input text-sm"
                  type="password"
                  autocomplete="new-password"
                  autofocus
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
                <Show when={submitting()} fallback={<>Reset password</>}>
                  <Loader2 class="animate-spin" size={16} /> Resetting…
                </Show>
              </button>
            </form>
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
