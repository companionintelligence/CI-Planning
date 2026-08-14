import { Show } from 'solid-js';
import { RefreshCw, X } from 'lucide-solid';
import { updateAvailable, dismissUpdateAvailable } from '../stores/updateAvailable.js';

/**
 * Flagged by stores/updateAvailable.ts when an SSE reconnect reveals the server is
 * running a different release than this tab was built from — most often a
 * container restart onto a newer image. Deliberately not an auto-reload: the
 * offline op-log + SSE catch-up already guarantee no data is lost across the gap,
 * so the only thing a forced reload would take from the user is the moment they'd
 * have picked for it themselves.
 */
export function UpdateBanner() {
  return (
    <Show when={updateAvailable()}>
      <div class="flex-shrink-0 bg-primary/10 border-b border-primary/30 px-4 md:px-6 text-sm">
        <div class="flex items-center gap-2 py-2">
          <RefreshCw size={14} class="text-primary flex-shrink-0" />
          <span class="flex-1 text-xs text-foreground">
            Companion Planning was updated — reload to get the latest.
          </span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            class="text-xs font-medium text-primary hover:text-primary/80 px-2 py-0.5 rounded border border-primary/50 hover:border-primary transition-colors flex-shrink-0"
          >
            Reload
          </button>
          <button
            type="button"
            class="text-primary/60 hover:text-primary transition-colors flex-shrink-0"
            title="Dismiss for now"
            onClick={dismissUpdateAvailable}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </Show>
  );
}
