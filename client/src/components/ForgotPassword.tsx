import { createSignal, Show } from 'solid-js';
import { X, Loader2 } from 'lucide-solid';
import { api } from '../lib/api.js';

/**
 * V6 — "Forgot password?" modal, opened from the local login form (Login.tsx). One
 * field (username or email) → POST /api/auth/reset-request. The server ALWAYS returns
 * the same neutral 200 (anti-enumeration), so this shows the same confirmation whether
 * or not the account exists — we never reveal existence in the UI either.
 *
 * House-style classes only (input, btn, modal) so it stays on the canonical teal
 * design tokens — no hardcoded colors.
 */
interface Props {
  onClose: () => void;
}

export function ForgotPassword(props: Props) {
  const [identifier, setIdentifier] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [sent, setSent] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (!identifier().trim() || submitting()) return;
    setSubmitting(true);
    try {
      await api.auth.resetRequest(identifier().trim());
    } catch {
      // Even a transport error shouldn't reveal anything — fall through to the same
      // neutral confirmation. (Rate-limit 429s also land here.)
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div class="px-4 py-3 border-b border-border flex items-center justify-between">
          <span class="text-sm font-semibold text-foreground">Reset your password</span>
          <button class="btn-icon" onClick={props.onClose} aria-label="Close"><X size={15} /></button>
        </div>

        <Show
          when={!sent()}
          fallback={
            <div class="p-4 flex flex-col gap-3">
              <p class="text-sm text-foreground">If an account matches, a reset link is on its way.</p>
              <p class="text-xs text-muted-foreground">
                Check your email and follow the link to choose a new password. The link expires shortly and can be used once.
              </p>
              <div class="flex justify-end">
                <button class="btn-primary text-sm px-4 py-1.5" onClick={props.onClose}>Done</button>
              </div>
            </div>
          }
        >
          <form class="p-4 flex flex-col gap-3" onSubmit={submit}>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">Username or email</span>
              <input
                autofocus
                class="input text-sm"
                autocomplete="username"
                value={identifier()}
                onInput={(e) => setIdentifier(e.currentTarget.value)}
              />
            </label>
            <p class="text-xs text-muted-foreground">
              We'll email a reset link to the address on file for that account.
            </p>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn-ghost text-sm px-3 py-1.5" onClick={props.onClose}>Cancel</button>
              <button type="submit" class="btn-primary text-sm px-4 py-1.5 justify-center" disabled={submitting() || !identifier().trim()}>
                <Show when={submitting()} fallback={<>Send reset link</>}>
                  <Loader2 class="animate-spin" size={14} /> Sending…
                </Show>
              </button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}
