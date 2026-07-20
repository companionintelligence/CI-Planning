import { For, createSignal, Show } from 'solid-js';
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

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      <h1 class="text-2xl font-bold text-foreground mb-5">Scheduled Jobs</h1>

      {/* The jobs resource must be error-guarded BEFORE jobs() is read: Solid re-throws
          the fetch error on access and the app mounts no ErrorBoundary — a non-operator's
          403 would otherwise blow up the render instead of explaining itself. */}
      <Show when={jobs.error}>
        <div class="card text-sm text-muted-foreground">
          Couldn't load jobs — this page needs an operator account. ({(jobs.error as Error)?.message})
        </div>
      </Show>
      <div class="flex flex-col gap-3">
        <For each={jobs.error ? [] : jobs()}>
          {(job) => (
            <div class="card flex items-center gap-4">
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
                disabled={triggering() === job.id}
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
