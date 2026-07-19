import { createSignal, Show } from 'solid-js';
import type { RunNowOutcome } from '../../lib/api.js';
import { runIngestNowAndRefetch, hasConnectedSource, showToast } from '../../stores/index.js';

/**
 * Adversarial review caught this: `runJob` never throws (it catches internally and
 * records `status: 'error'`), so a totally-failed run — Ollama down, Google API
 * error, whatever — used to produce the exact same "Nothing new to pull in right
 * now." text as a genuine clean no-op. Surface `status` so a real failure reads as
 * one, instead of masquerading as success.
 */
function summarize(ran: RunNowOutcome[]): { text: string; hasError: boolean } {
  const failed = ran.filter((r) => r.status !== 'done');
  const created = ran.reduce((sum, r) => sum + r.itemsCreated, 0);
  const updated = ran.reduce((sum, r) => sum + r.itemsUpdated, 0);
  const parts: string[] = [];
  if (created) parts.push(`${created} new`);
  if (updated) parts.push(`${updated} updated`);
  const pulled = parts.length ? `Pulled ${parts.join(', ')} into your day.` : 'Nothing new to pull in right now.';

  if (failed.length === 0) return { text: pulled, hasError: false };
  if (failed.length === ran.length) return { text: 'Sync failed — try again in a moment.', hasError: true };
  return { text: `${pulled} (${failed.length} of ${ran.length} sources had trouble — try again in a moment.)`, hasError: true };
}

/**
 * FTUE · T12 (#348) — onboarding wizard Step 5: trigger the ingest jobs right now
 * (`POST /api/jobs/run-now`) instead of waiting for the 06:30 cron, so the payoff
 * (Inbox filled, meetings mirrored, day blocked) lands in this same session.
 */
export function RunFirstSyncStep(props: { onBack: () => void; onFinish: () => void; onGoToConnect: () => void }) {
  const [running, setRunning] = createSignal(false);
  const [summary, setSummary] = createSignal<{ text: string; hasError: boolean } | null>(null);

  async function runNow() {
    setRunning(true);
    setSummary(null);
    try {
      const ran = await runIngestNowAndRefetch();
      setSummary(summarize(ran));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div>
        <h2 class="text-base font-semibold text-foreground">Run your first sync</h2>
        <p class="text-xs text-muted-foreground mt-0.5">
          Pull in your email and calendar right now instead of waiting for tonight's sync.
        </p>
      </div>

      <Show when={!hasConnectedSource()}>
        <p class="text-xs text-muted-foreground">
          No source connected yet — this will be a no-op.{' '}
          <button type="button" class="text-primary underline" onClick={props.onGoToConnect}>Back to Connect</button>
        </p>
      </Show>

      <button type="button" class="btn-primary text-sm" disabled={running()} onClick={() => void runNow()}>
        {running() ? 'Syncing…' : 'Run my first sync now'}
      </button>
      <Show when={summary()}>
        {(s) => <p classList={{ 'text-xs': true, 'text-foreground': !s().hasError, 'text-destructive': s().hasError }}>{s().text}</p>}
      </Show>

      <div class="flex justify-between items-center pt-1">
        <button type="button" class="btn-ghost text-xs" disabled={running()} onClick={props.onFinish}>Skip</button>
        <div class="flex gap-2">
          <button type="button" class="btn-ghost text-xs" disabled={running()} onClick={props.onBack}>Back</button>
          <button type="button" class="btn-primary text-xs" disabled={running()} onClick={props.onFinish}>Finish</button>
        </div>
      </div>
    </div>
  );
}
