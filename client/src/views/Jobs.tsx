import { For, createSignal, Show } from 'solid-js';
import { ViewHeader } from '../components/ViewHeader.js';
import { setActiveEntity } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';
import { Play, CheckCircle2, XCircle, Clock, RefreshCw } from 'lucide-solid';
import { jobs, refetchJobs, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';

function fmtDate(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusIcon(s?: string) {
  if (s === 'done')    return <CheckCircle2 size={13} class="text-green-400" />;
  if (s === 'error')   return <XCircle      size={13} class="text-red-400" />;
  if (s === 'running') return <RefreshCw    size={13} class="text-yellow-400 animate-spin" />;
  return <Clock size={13} class="text-muted-foreground" />;
}

export function Jobs() {
  const [triggering, setTriggering] = createSignal<string | null>(null);
  const [runningAll, setRunningAll] = createSignal(false);

  async function trigger(id: string) {
    setTriggering(id);
    try {
      const r = await api.jobs.run(id);
      showToast(r.message, 'default');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setTriggering(null);
      setTimeout(refetchJobs, 1500);
    }
  }

  // Run every listed job once, reusing the same admin-gated per-job trigger the row
  // buttons use — so the scope/auth match exactly (YOUR account only; the cron still
  // fans out per-owner). Triggers are fire-and-forget server-side, so a sequential loop
  // just kicks each off; SSE + the delayed refetch surface their results.
  async function runAll() {
    const list = jobs.error ? [] : (jobs() ?? []);
    if (!list.length) { showToast('No jobs to run', 'default'); return; }
    setRunningAll(true);
    let ok = 0;
    try {
      for (const job of list) {
        try { await api.jobs.run(job.id); ok++; } catch { /* skip a single failure */ }
      }
      showToast(ok ? `Triggered ${ok} job${ok === 1 ? '' : 's'} — running for your account` : 'No jobs ran', 'default');
    } finally {
      setRunningAll(false);
      setTimeout(refetchJobs, 1500);
    }
  }

  return (
    <div class="view-container page-enter">
      <ViewHeader title="Scheduled Jobs" sub="Each row runs for your account; the scheduled cron runs every account.">
        <Show when={!jobs.error}>
          <button
            onClick={runAll}
            disabled={runningAll() || triggering() !== null}
            class="btn-secondary text-xs gap-1.5 flex-shrink-0"
            title="Runs every job once — for YOUR account only, like each row's button. The scheduled cron runs every account."
          >
            <Show when={runningAll()} fallback={<Play size={13} />}>
              <RefreshCw size={13} class="animate-spin" />
            </Show>
            {runningAll() ? 'Running…' : 'Run all'}
          </button>
        </Show>
      </ViewHeader>

      {/* The jobs resource is error-guarded BEFORE jobs() is read: Solid re-throws the
          fetch error on access, and this inline guard explains a non-operator's 403 in
          context rather than bouncing to the root ErrorBoundary's generic fallback. */}
      <Show when={jobs.error}>
        <div class="card text-sm text-muted-foreground">
          Couldn't load jobs — this page needs an operator account. ({(jobs.error as Error)?.message})
        </div>
      </Show>
      <div class="flex flex-col gap-3">
        <For each={jobs.error ? [] : jobs()}>
          {(job) => (
            <div
              class="card flex items-center gap-4 cursor-pointer hover:border-ring/60 transition-colors"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button,a')) return;
                setActiveEntity('job', job.id);
                revealDetails();
              }}
            >
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-semibold text-foreground">{job.name}</span>
                  <span class={job.enabled ? 'badge-green' : 'badge-neutral'}>
                    {job.enabled ? 'active' : 'disabled'}
                  </span>
                  <Show when={job.last_status}>
                    <span class="flex items-center gap-1 text-xs text-muted-foreground">
                      {statusIcon(job.last_status)} {job.last_status}
                    </span>
                  </Show>
                </div>
                <div class="flex gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
                  <span class="font-mono bg-muted px-1.5 py-0.5 rounded text-[11px]">{job.cron}</span>
                  <span>Last run: {fmtDate(job.last_started)}</span>
                  {/* Both counters: many kinds report all their work via items_updated
                      (fire_reminders, reset_routines, tag_tasks, …) with created at 0. */}
                  <Show when={job.items_created}>
                    <span class="text-green-500">+{job.items_created} created</span>
                  </Show>
                  <Show when={job.items_updated}>
                    <span class="text-sky-500">~{job.items_updated} updated</span>
                  </Show>
                </div>
                <Show when={job.log}>
                  <div class="mt-1 text-[11px] text-muted-foreground truncate" title={job.log ?? undefined}>
                    {job.log}
                  </div>
                </Show>
              </div>
              <button
                onClick={() => trigger(job.id)}
                disabled={triggering() === job.id || runningAll()}
                class="btn-secondary text-xs gap-1.5 flex-shrink-0"
                title="Runs for YOUR account only — the scheduled cron runs every account"
              >
                <Show when={triggering() === job.id} fallback={<Play size={12} />}>
                  <RefreshCw size={12} class="animate-spin" />
                </Show>
                {triggering() === job.id ? 'Running…' : 'Run now'}
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
