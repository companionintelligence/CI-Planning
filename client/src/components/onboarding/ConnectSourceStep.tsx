import { createResource, createSignal, Show, For } from 'solid-js';
import { api } from '../../lib/api.js';
import { integrations, runIngestNowAndRefetch, showToast } from '../../stores/index.js';
import { FTUE_RESUME_KEY } from '../../lib/onboarding.js';
import { GOOGLE_CONNECT_ENABLED } from '../../lib/flags.js';

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
  // Adversarial review caught this: without gating Skip/Back/Next too, a click on
  // Next right after "Connect Google" (before api.oauth.googleStart() resolves) would
  // advance to step 4 and THEN — moments later — the resolved promise still fires an
  // unconditional window.location.href, yanking the user off whatever step they'd
  // moved to; a Skip mid-"Try with sample data" would unmount the wizard while that
  // request kept running unobserved. Steps 1/2/4 already gate their own nav on `busy`.
  const busy = () => connecting() || tryingSample();

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
    if (busy()) return;
    setTryingSample(true);
    try {
      await api.googleConfig.save({ enabled: true, mode: 'fixture' });
      const ran = await runIngestNowAndRefetch();
      // Adversarial review caught this: runJob never throws (failures land in
      // `status`, not a rejection), so the old code always reached this success toast
      // and always advanced, even when every job failed.
      const failed = ran.filter((r) => r.status !== 'done');
      if (failed.length === ran.length) {
        showToast('Could not load sample data — try again in a moment.', 'error');
        return; // stay on this step so the user can retry, don't advance
      }
      showToast(failed.length ? 'Sample data loaded (some sources had trouble)' : 'Sample data loaded', 'success');
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
        <Show
          when={GOOGLE_CONNECT_ENABLED}
          fallback={
            <p class="text-xs text-muted-foreground mt-0.5">
              Google isn't connectable yet — for now, connect your Companion Memory from
              Settings → Connections once you're in.
            </p>
          }
        >
          <p class="text-xs text-muted-foreground mt-0.5">
            Pull your email and calendar in automatically, or explore with sample data first.
          </p>
        </Show>
      </div>

      <Show when={GOOGLE_CONNECT_ENABLED}>
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
      </Show>

      <div class="flex justify-between items-center pt-1">
        <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={props.onSkip}>Skip</button>
        <div class="flex gap-2">
          <button type="button" class="btn-ghost text-xs" disabled={busy()} onClick={props.onBack}>Back</button>
          <button type="button" class="btn-primary text-xs" disabled={busy()} onClick={props.onNext}>Next</button>
        </div>
      </div>
    </div>
  );
}
