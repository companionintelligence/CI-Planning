import { createResource, createSignal, Show, For } from 'solid-js';
import { api } from '../../lib/api.js';
import { integrations, runIngestNowAndRefetch, showToast } from '../../stores/index.js';
import { FTUE_RESUME_KEY } from '../../lib/onboarding.js';

/**
 * FTUE · T12 (#348) — onboarding wizard Step 3: connect a real Google account, or
 * (admin only) load sample data instead. Embeds the already-shipped OAuth flow
 * verbatim (`GET /api/oauth/google/start` → top-level navigation to Google) — no new
 * OAuth logic here. The resume marker lets the wizard (not Settings.tsx) claim the
 * `?google=` param when the browser lands back after the consent screen.
 */
export function ConnectSourceStep(props: { onNext: () => void; onBack: () => void; onSkip: () => void }) {
  const [connecting, setConnecting] = createSignal(false);
  const [tryingSample, setTryingSample] = createSignal(false);
  // Admin probe — mirrors Settings.tsx's own `gcfg` pattern: a 403 collapses to null,
  // so a non-admin member simply never sees the sample-data action.
  const [gcfg] = createResource(() => api.googleConfig.get().catch(() => null));

  const liveEnabled = () => integrations()?.google.liveEnabled ?? false;
  const connections = () => integrations()?.google.connections ?? [];

  async function connectGoogle() {
    if (!liveEnabled() || connecting()) return;
    setConnecting(true);
    try {
      localStorage.setItem(FTUE_RESUME_KEY, '1');
      const { url } = await api.oauth.googleStart();
      window.location.href = url; // top-level nav — Google's consent screen isn't fetchable
    } catch (err) {
      localStorage.removeItem(FTUE_RESUME_KEY);
      showToast((err as Error).message, 'error');
      setConnecting(false);
    }
  }

  async function trySampleData() {
    if (tryingSample()) return;
    setTryingSample(true);
    try {
      await api.googleConfig.save({ enabled: true, mode: 'fixture' });
      await runIngestNowAndRefetch();
      showToast('Sample data loaded', 'success');
      props.onNext();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setTryingSample(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div>
        <h2 class="text-base font-semibold text-foreground">Connect a source</h2>
        <p class="text-xs text-muted-foreground mt-0.5">
          Pull your email and calendar in automatically, or explore with sample data first.
        </p>
      </div>

      <button
        type="button"
        class="btn-primary text-sm"
        disabled={!liveEnabled() || connecting()}
        onClick={() => void connectGoogle()}
      >
        {connecting() ? 'Connecting…' : 'Connect Google'}
      </button>
      <Show when={!liveEnabled()}>
        <p class="text-[11px] text-muted-foreground">Waiting on an operator to configure the Google connection.</p>
      </Show>

      <Show when={gcfg()}>
        <button type="button" class="btn-secondary text-sm" disabled={tryingSample()} onClick={() => void trySampleData()}>
          {tryingSample() ? 'Loading sample data…' : 'Try with sample data'}
        </button>
      </Show>
      <Show when={gcfg() === null}>
        <p class="text-[11px] text-muted-foreground">Sample data is available to an operator account.</p>
      </Show>

      <Show when={connections().length > 0}>
        <div class="flex flex-col gap-1">
          <For each={connections()}>
            {(c) => (
              <div class="flex items-center justify-between text-xs rounded-md border border-border px-2 py-1.5">
                <span class="text-foreground truncate">{c.account}</span>
                <span class="text-muted-foreground">{c.status}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="flex justify-between items-center pt-1">
        <button type="button" class="btn-ghost text-xs" onClick={props.onSkip}>Skip</button>
        <div class="flex gap-2">
          <button type="button" class="btn-ghost text-xs" onClick={props.onBack}>Back</button>
          <button type="button" class="btn-primary text-xs" onClick={props.onNext}>Next</button>
        </div>
      </div>
    </div>
  );
}
