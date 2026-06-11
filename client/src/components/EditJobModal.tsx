import { createSignal, Show, createEffect } from 'solid-js';
import { X, Save } from 'lucide-solid';
import { api, type Job } from '../lib/api.js';
import { showToast } from '../stores/index.js';

interface Props {
  job: Job;
  onClose: () => void;
  onSave: () => void;
}

export function EditJobModal(props: Props) {
  const [cron, setCron] = createSignal(props.job.cron);
  const [enabled, setEnabled] = createSignal(props.job.enabled);
  const [configText, setConfigText] = createSignal(
    props.job.config ? JSON.stringify(props.job.config, null, 2) : '{}'
  );
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    setCron(props.job.cron);
    setEnabled(props.job.enabled);
    setConfigText(props.job.config ? JSON.stringify(props.job.config, null, 2) : '{}');
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (!cron().trim()) return;

    let parsedConfig = null;
    if (configText().trim()) {
      try {
        parsedConfig = JSON.parse(configText().trim());
      } catch (err) {
        showToast('Invalid Config JSON syntax', 'error');
        return;
      }
    }

    setSaving(true);
    try {
      await api.jobs.update(props.job.id, {
        cron: cron().trim(),
        enabled: enabled(),
        config: parsedConfig,
      });
      showToast('Job updated successfully', 'success');
      props.onSave();
      props.onClose();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal max-w-md">
        {/* Header */}
        <div class="flex items-center justify-between px-5 pt-5 pb-3 border-b border-surface-700/40">
          <h2 class="font-heading text-lg tracking-wide text-ci-1">
            Edit Job: {props.job.name}
          </h2>
          <button onClick={props.onClose} class="btn-icon"><X size={16} /></button>
        </div>

        <form onSubmit={submit} class="p-5 flex flex-col gap-4 text-left">
          {/* Cron expression */}
          <label class="flex flex-col gap-1.5">
            <span class="text-xs text-ci-1/60 font-mono">Cron Expression</span>
            <input
              class="input font-mono"
              placeholder="e.g. */30 * * * *"
              value={cron()}
              onInput={(e) => setCron(e.currentTarget.value)}
              required
            />
            <span class="text-[10px] text-ci-1/40 font-mono">
              Five fields: minute, hour, day-of-month, month, day-of-week
            </span>
          </label>

          {/* Enabled checkbox */}
          <label class="flex items-center gap-3 p-3 rounded-xl border border-surface-750 bg-surface-900/30 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled()}
              onChange={(e) => setEnabled(e.currentTarget.checked)}
              class="checkbox"
            />
            <div class="select-none">
              <div class="text-xs font-semibold text-ci-1">Enable Schedule</div>
              <div class="text-[10px] text-ci-1/50">Run automatically at the cron cadence</div>
            </div>
          </label>

          {/* Config JSON */}
          <label class="flex flex-col gap-1.5">
            <span class="text-xs text-ci-1/60 font-mono">Config (JSON)</span>
            <textarea
              class="textarea font-mono min-h-[140px] text-xs bg-surface-950/45 border-surface-750"
              placeholder="{}"
              value={configText()}
              onInput={(e) => setConfigText(e.currentTarget.value)}
            />
          </label>

          {/* Actions */}
          <div class="flex gap-2 pt-2">
            <button type="submit" disabled={saving() || !cron().trim()} class="btn-primary flex-1">
              {saving() ? 'Saving…' : 'Save Changes'}
            </button>
            <button type="button" onClick={props.onClose} class="btn-secondary">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
