import { For, createSignal } from 'solid-js';
import { jobs, refetchJobs } from '../stores/index.js';
import { api } from '../lib/api.js';

const statusColor: Record<string, string> = {
  done:    'text-green-400',
  error:   'text-red-400',
  running: 'text-yellow-400',
};

function fmtDate(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function Jobs() {
  const [triggering, setTriggering] = createSignal<number | null>(null);

  async function trigger(id: number) {
    setTriggering(id);
    try {
      await api.jobs.run(id);
    } finally {
      setTriggering(null);
      setTimeout(refetchJobs, 1000);
    }
  }

  return (
    <div class="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
      <h1 class="text-2xl font-semibold text-slate-100 mb-6">Scheduled Jobs</h1>

      <div class="flex flex-col gap-3">
        <For each={jobs()}>
          {(job) => (
            <div class="card flex items-center gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-slate-200">{job.name}</span>
                  <span class={`badge text-xs ${job.enabled ? 'bg-green-900/40 text-green-400' : 'bg-surface-700 text-slate-500'}`}>
                    {job.enabled ? 'active' : 'disabled'}
                  </span>
                  {job.last_status && (
                    <span class={`text-xs font-mono ${statusColor[job.last_status] ?? 'text-slate-400'}`}>
                      {job.last_status}
                    </span>
                  )}
                </div>
                <div class="flex gap-4 mt-1 text-xs text-slate-500">
                  <span class="font-mono">{job.cron}</span>
                  <span>Last run: {fmtDate(job.last_started)}</span>
                  {job.items_created ? <span>{job.items_created} items created</span> : null}
                </div>
              </div>
              <button
                onClick={() => trigger(job.id)}
                disabled={triggering() === job.id}
                class="btn-ghost text-xs flex-shrink-0"
              >
                {triggering() === job.id ? 'Running…' : '▶ Run now'}
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
