import { createResource, Show } from 'solid-js';
import { api, type MemoryStatus } from '../../lib/api.js';
import { integrations } from '../../stores/index.js';

/**
 * FTUE · the Companion Memory and AI this server already has, shown on the connect step so a new
 * owner can see what is in place before they reach Settings. Read-only: it reports the owner's
 * Companion Memory connection, or the address the server is configured with, and whether an AI
 * model is ready. Connecting happens in Settings, where the Portal and address flows live.
 */
export function MemoryAndAiPanel() {
  const [memory] = createResource(async (): Promise<MemoryStatus | null> => {
    try {
      return await api.memory.status();
    } catch {
      return null;
    }
  });
  const ollama = () => integrations()?.ollama;
  const aiReady = () => (ollama()?.ready ?? ollama()?.available) === true;

  return (
    <section class="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2 text-xs" aria-label="Your memory and AI">
      <p class="text-foreground font-medium">Your memory and AI</p>
      <Show when={!memory.loading} fallback={<p class="text-muted-foreground">Checking Companion Memory…</p>}>
        <Show
          when={memory()}
          fallback={<p class="text-muted-foreground">Companion Memory status is unavailable right now.</p>}
        >
          {(m) => (
            <Show
              when={m().connected}
              fallback={
                <Show
                  when={m().pull.source === 'env' && m().pull.host}
                  fallback={<p class="text-muted-foreground">Companion Memory isn't connected yet.</p>}
                >
                  <p class="text-muted-foreground">This server is configured for Companion Memory at {m().pull.host}.</p>
                </Show>
              }
            >
              <p class="text-muted-foreground">
                Companion Memory is connected{m().account ? ` as ${m().account}` : ''}.
              </p>
            </Show>
          )}
        </Show>
      </Show>
      <p class="text-muted-foreground">
        {aiReady() ? 'AI is ready on this server.' : 'No AI model is ready yet. Install Ollama and pull a model, then check again.'}
      </p>
      <p class="text-muted-foreground">
        Connect or change either in <a href="/settings" class="underline">Settings</a>.
      </p>
    </section>
  );
}
