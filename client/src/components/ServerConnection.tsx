import { Show, createSignal } from 'solid-js';
import { Server } from 'lucide-solid';
import { changeServer, getServerUrl } from '../lib/server-config.js';

/**
 * Settings card for the Capacitor mobile shell: shows which server the app is pointed at
 * and lets the person point it somewhere else. Settings renders it only when
 * `isNativeShell()`, so it does not exist in the web app.
 *
 * Changing servers is two-step on purpose. It discards edits that were made offline and
 * have not synced yet (`changeServer` explains why they cannot be carried over), and a
 * stray tap should not do that. All buttons are `type="button"` — this card sits inside
 * Settings' <form>, where an untyped button would submit it.
 */
export function ServerConnection() {
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function disconnect() {
    setBusy(true);
    await changeServer(); // ends in a full reload to the connect screen
  }

  return (
    <section class="card" aria-label="Server connection">
      <div class="section-label flex items-center gap-1.5 mb-3">
        <Server size={12} /> Server
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-[11px] text-muted-foreground">This app is connected to</span>
        <code class="text-xs text-foreground break-all" data-testid="server-url">{getServerUrl()}</code>

        <Show
          when={confirming()}
          fallback={
            <button
              type="button"
              class="btn-secondary text-xs px-3 py-1.5 self-start mt-1"
              onClick={() => setConfirming(true)}
            >
              Change server…
            </button>
          }
        >
          <div class="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-400/90 mt-1" role="alert">
            Switching servers discards any changes you made offline that have not synced yet. You will be asked for a new
            server address.
          </div>
          <div class="flex gap-2 mt-1">
            <button type="button" class="btn-secondary text-xs px-3 py-1.5" disabled={busy()} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" class="btn-primary text-xs px-3 py-1.5" disabled={busy()} onClick={disconnect}>
              {busy() ? 'Switching…' : 'Switch server'}
            </button>
          </div>
        </Show>
      </div>
    </section>
  );
}
