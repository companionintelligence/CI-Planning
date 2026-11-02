import { Show, createSignal } from 'solid-js';
import { Cpu, Loader2, Server } from 'lucide-solid';
import { connectTo, probeServer, type ProbeFailure } from '../lib/server-config.js';

/**
 * First-run screen of the Capacitor mobile shell ("Connect to your server").
 *
 * Companion Planning is local-first and needs the server its user runs; the app bundle
 * cannot know where that is, so the person says so here. Rendered by App.tsx instead of
 * the router, and only when `needsServerSetup()` — i.e. never in a browser, where the
 * SPA is served by the very server it talks to.
 *
 * The address is checked (`probeServer`: /api/health + /api/auth/config, both public)
 * before it is saved, so a typo is caught here rather than as an app that never loads.
 * Nothing secret is asked for or stored: signing in happens afterwards, through the
 * server's own login screen.
 */

const PROBLEMS: Record<ProbeFailure, string> = {
  invalid: 'That does not look like a web address. Try something like http://192.168.1.20:3848 or https://planning.example.com.',
  unreachable:
    'Could not reach that address. Check that it is typed correctly, that the server is running, and that this phone can reach it (same Wi-Fi, or connected through Tailscale).',
  'not-planning': 'Something answered at that address, but it does not look like a Companion Planning server.',
};

export function ConnectServer() {
  const [address, setAddress] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setProblem(null);
    const result = await probeServer(address());
    if (result.ok) {
      connectTo(result.url); // saves, then reloads into the app proper
      return; // leave `busy` set — the page is about to be replaced
    }
    setProblem(PROBLEMS[result.reason]);
    setBusy(false);
  }

  return (
    <div class="min-h-screen flex items-center justify-center p-4 bg-surface-950">
      <div class="w-full max-w-sm">
        <div class="flex flex-col items-center gap-3 mb-8">
          <div
            class="w-12 h-12 rounded-2xl flex items-center justify-center text-surface-950"
            style={{ background: 'linear-gradient(135deg, #58ebbf, #409b9b)' }}
          >
            <Cpu size={22} />
          </div>
          <div class="text-center">
            <div class="text-[10px] font-medium tracking-[0.2em] uppercase text-primary/80">
              Companion
            </div>
            <div class="font-heading text-xl text-slate-100 tracking-wide">Planning</div>
          </div>
        </div>

        <div class="card">
          {/* noValidate: type="url" (for the URL keyboard) would reject "192.168.1.20:3848" as
              "not a URL" and block the submit; normalizeServerUrl accepts exactly those. */}
          <form class="flex flex-col gap-4" onSubmit={submit} noValidate aria-label="Connect to your server">
            <div class="text-center">
              <h1 class="text-base font-semibold text-foreground">Connect to your server</h1>
              <p class="text-xs text-muted-foreground mt-1">
                Companion Planning keeps your plans on a server you run. Enter its address to connect this app to it.
              </p>
            </div>

            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">Server address</span>
              {/* input-lg = 16px text. Anything smaller makes iOS zoom the page in on focus. */}
              <input
                class="input-lg"
                type="url"
                inputmode="url"
                autocapitalize="none"
                autocomplete="url"
                spellcheck={false}
                placeholder="http://192.168.1.20:3848"
                value={address()}
                onInput={(e) => setAddress(e.currentTarget.value)}
                aria-invalid={problem() ? 'true' : undefined}
              />
            </label>

            <Show when={problem()}>
              <div class="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                {problem()}
              </div>
            </Show>

            <button type="submit" class="btn-primary w-full justify-center" disabled={busy() || !address().trim()}>
              <Show when={busy()} fallback={<><Server size={16} /> Connect</>}>
                <Loader2 class="animate-spin" size={16} /> Connecting…
              </Show>
            </button>

            <p class="text-[11px] text-muted-foreground">
              A server on your own network or over Tailscale can use <span class="font-mono">http://</span> with its IP
              address. Anything reachable by name or over the internet should be <span class="font-mono">https://</span>.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
