import { Show } from 'solid-js';
import { Link2 } from 'lucide-solid';
import { integrations, openOnboardingAt } from '../stores/index.js';
import { shouldShowConnectCTA } from '../lib/onboarding.js';

/**
 * FTUE · T12 (#348) — "Connect a source to fill this automatically", dropped into
 * Focus/Today/AllTasks' empty branches. Self-gating (like `OnboardingWizard`/
 * `ElementWizard`): renders nothing unless `shouldShowConnectCTA(integrations())` is
 * true, so every call site can just drop it in without wrapping its own `<Show>`.
 */
export function EmptyStateConnectCTA() {
  return (
    <Show when={shouldShowConnectCTA(integrations())}>
      <div class="flex flex-col items-center gap-2 mt-2">
        <p class="text-xs text-muted-foreground">Connect a source to fill this automatically.</p>
        <button
          type="button"
          class="btn-secondary text-xs inline-flex items-center gap-1.5"
          onClick={() => openOnboardingAt(3)}
        >
          <Link2 size={13} /> Connect
        </button>
      </div>
    </Show>
  );
}
