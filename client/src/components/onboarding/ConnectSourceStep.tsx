import { createResource, createSignal, Show, For } from 'solid-js';
import { api } from '../../lib/api.js';
import { integrations, onboardingSampleDataAllowed, refetchBlocks, refetchTasks, showToast } from '../../stores/index.js';
import { FTUE_RESUME_KEY } from '../../lib/onboarding.js';
import { GOOGLE_CONNECT_ENABLED } from '../../lib/flags.js';
import { supportsRedirectFlows } from '../../lib/server-config.js';

/**
 * FTUE · T12 (#348) — onboarding wizard Step 3: connect a real Google account, or
 * (admin only) load sample data instead. Embeds the already-shipped OAuth flow
 * verbatim (`GET /api/oauth/google/start` → top-level navigation to Google) — no new
 * OAuth logic here. The resume marker lets the wizard (not Settings.tsx) claim the
 * `?google=` param when the browser lands back after the consent screen.
 *
 * Not offered in the Capacitor app shell: the consent screen is a redirect the shell cannot
 * return from (see `supportsRedirectFlows`). The step says where to connect instead, and the
 * sample-data path and Skip / Next work as ever.
 */
export function ConnectSourceStep(props: { onNext: () => void; onBack: () => void; onSkip: () => void }) {
  const [connecting, setConnecting] = createSignal(false);
  const [tryingSample, setTryingSample] = createSignal(false);
  // Admin probe — mirrors Settings.tsx's own `gcfg` pattern: a 403 collapses to null,
  // so a non-admin member simply never sees the sample-data action.
  const [gcfg] = createResource(() => api.googleConfig.get().catch(() => null));

  const liveEnabled = () => integrations()?.google.liveEnabled ?? false;
  // 'live' | 'fixture' | 'off' — see server/src/lib/config.ts:251. Needed
  // separately from liveEnabled() because 'fixture' and 'off' are both
  // not-live but mean opposite things to the person reading this step.
  const mode = () => integrations()?.google.mode ?? 'off';
  const connections = () => integrations()?.google.connections ?? [];
  // Adversarial review caught this: without gating Skip/Back/Next too, a click on
  // Next right after "Connect Google" (before api.oauth.googleStart() resolves) would
  // advance to step 4 and THEN — moments later — the resolved promise still fires an
  // unconditional window.location.href, yanking the user off whatever step they'd
  // moved to; a Skip mid-"Try with sample data" would unmount the wizard while that
  // request kept running unobserved. Steps 1/2/4 already gate their own nav on `busy`.
  const busy = () => connecting() || tryingSample();
  /** Google is connectable here at all: switched on, and the page can make the round trip. */
  const canConnectGoogle = () => GOOGLE_CONNECT_ENABLED && supportsRedirectFlows();

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

  /**
   * Install the curated sample set (server: services/demo-data.ts).
   *
   * This used to flip Google into `fixture` mode and run the ingest jobs, which meant
   * asking for sample data silently configured a connector the owner never chose, and
   * what appeared depended on fixture files. One call, one known set, no side effects
   * on their integrations.
   *
   * The failure posture from the old version is kept deliberately: on error, stay on
   * this step so the action can be retried, rather than advancing over a board that is
   * still empty.
   */
  async function trySampleData() {
    if (busy()) return;
    setTryingSample(true);
    try {
      const res = await api.demo.sampleData();
      // Explicit rather than relying on the server's SSE broadcast: the wizard can be
      // running before the event stream is attached, and the next step reads both.
      await Promise.all([refetchTasks(), refetchBlocks()]);
      showToast(res.skipped ?? 'Sample data loaded', 'success');
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
          when={canConnectGoogle()}
          fallback={
            <p class="text-xs text-muted-foreground mt-0.5">
              <Show
                when={GOOGLE_CONNECT_ENABLED}
                fallback={
                  <>
                    Google isn't connectable yet — for now, connect your Companion Memory from
                    Settings → Connections once you're in.
                  </>
                }
              >
                Google is connected from a browser, not from this app. It is a connection on your
                server, so once it is made it shows up here too.
                <Show when={onboardingSampleDataAllowed()}> You can also explore with sample data.</Show>
              </Show>
            </p>
          }
        >
          <p class="text-xs text-muted-foreground mt-0.5">
            Pull your email and calendar in automatically, or explore with sample data first.
          </p>
        </Show>
      </div>

      <Show when={canConnectGoogle()}>
        <button
          type="button"
          class="btn-primary text-sm"
          disabled={!liveEnabled() || connecting()}
          onClick={() => void connectGoogle()}
        >
          {connecting() ? 'Connecting…' : 'Connect Google'}
        </button>
        {/* `!liveEnabled()` covers two states that need different sentences, and
            collapsing them into one is how "Waiting on an operator to configure
            the Google connection." ended up as the hero line of a first-run
            step. It is wrong for `fixture` (nothing is pending — sample data IS
            the intended path, and the button for it is directly below), and it
            is unhelpful for `off` (it names an absent person instead of the
            thing to do). Settings.tsx:1836-1841 already tells these two apart;
            this mirrors it, pointed at the reader rather than at an operator. */}
        <Show when={!liveEnabled()}>
          <p class="text-[11px] text-muted-foreground">
            {mode() === 'fixture'
              ? 'Sample data only in this build — no Google account can be connected.'
              : 'Connecting Google needs an OAuth client, set up once under Settings → Integrations.'}
          </p>
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

      {/* OUTSIDE the Google gate, deliberately. Sample data no longer touches Google —
          it inserts a curated set server-side — so a build with Google connect disabled
          must still offer the one path that fills the board. While this sat inside the
          gate, `GOOGLE_CONNECT_ENABLED=false` left this step with no action at all. */}
      <Show when={onboardingSampleDataAllowed() && gcfg()}>
        <button type="button" class="btn-secondary text-sm" disabled={tryingSample()} onClick={() => void trySampleData()}>
          {tryingSample() ? 'Loading sample data…' : 'Try with sample data'}
        </button>
      </Show>
      <Show when={onboardingSampleDataAllowed() && gcfg() === null}>
        <p class="text-[11px] text-muted-foreground">Sample data is available to an operator account.</p>
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
