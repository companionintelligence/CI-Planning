import { createSignal, Show } from 'solid-js';
import { X } from 'lucide-solid';
import { api, type Objective, type ObjectiveInput } from '../lib/api.js';
import { showToast } from '../stores/index.js';

interface Props {
  /** undefined = create mode; defined = edit mode */
  objective?: Objective;
  /** Pre-fill parent when creating from a tree node */
  defaultParentId?: string;
  onClose: () => void;
  onSaved: () => void;
}

const HORIZONS = [
  { value: 'none', label: 'No horizon' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year', label: 'This year' },
] as const;

const CADENCES = [
  { value: 'none', label: 'No cadence' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Bi-weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const;

const STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
  { value: 'dropped', label: 'Dropped' },
] as const;

/**
 * Phase N1 — lightweight Objective create/edit modal.
 * NOT a 5th ElementWizard kind; shares no fields with task/timeblock.
 */
export function ObjectiveModal(props: Props) {
  const isEdit = () => !!props.objective;

  const [title, setTitle] = createSignal(props.objective?.title ?? '');
  const [description, setDescription] = createSignal(props.objective?.description ?? '');
  const [horizon, setHorizon] = createSignal<string>(props.objective?.horizon ?? 'none');
  const [status, setStatus] = createSignal<string>(props.objective?.status ?? 'active');
  const [cadence, setCadence] = createSignal<string>(props.objective?.cadence ?? 'none');
  const [targetDate, setTargetDate] = createSignal(props.objective?.target_date ?? '');
  const [saving, setSaving] = createSignal(false);

  async function save() {
    if (!title().trim()) { showToast('Title is required', 'error'); return; }
    setSaving(true);
    try {
      const body: ObjectiveInput = {
        title: title().trim(),
        description: description().trim() || null,
        horizon: horizon() as ObjectiveInput['horizon'],
        status: status() as ObjectiveInput['status'],
        cadence: cadence() as ObjectiveInput['cadence'],
        target_date: targetDate() || null,
      };
      if (!isEdit() && props.defaultParentId) {
        body.parent_id = props.defaultParentId;
      }
      if (isEdit()) {
        await api.objectives.update(props.objective!.id, body);
      } else {
        await api.objectives.create(body);
      }
      props.onSaved();
      props.onClose();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal max-w-lg" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div class="px-4 py-3 border-b border-border flex items-center justify-between">
          <span class="text-sm font-semibold text-foreground">
            {isEdit() ? 'Edit Objective' : 'New Objective'}
          </span>
          <button class="btn-icon" onClick={props.onClose}><X size={15} /></button>
        </div>

        {/* Body */}
        <div class="p-4 flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-muted-foreground">Title *</span>
            <input
              autofocus
              class="input text-sm"
              placeholder="What do you want to achieve?"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-muted-foreground">Description</span>
            <textarea
              class="input text-sm resize-none"
              rows={2}
              placeholder="Optional notes…"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </label>

          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">Horizon</span>
              <select class="input text-sm" value={horizon()} onChange={(e) => setHorizon(e.currentTarget.value)}>
                {HORIZONS.map((h) => <option value={h.value}>{h.label}</option>)}
              </select>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">Cadence push</span>
              <select class="input text-sm" value={cadence()} onChange={(e) => setCadence(e.currentTarget.value)}>
                {CADENCES.map((c) => <option value={c.value}>{c.label}</option>)}
              </select>
            </label>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">Status</span>
              <select class="input text-sm" value={status()} onChange={(e) => setStatus(e.currentTarget.value)}>
                {STATUSES.map((s) => <option value={s.value}>{s.label}</option>)}
              </select>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">Target date (soft)</span>
              <input
                type="date"
                class="input text-sm"
                value={targetDate()}
                onInput={(e) => setTargetDate(e.currentTarget.value)}
              />
            </label>
          </div>
        </div>

        {/* Footer */}
        <div class="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button class="btn-ghost text-sm px-3 py-1.5" onClick={props.onClose}>Cancel</button>
          <button class="btn-primary text-sm px-4 py-1.5" onClick={save} disabled={saving()}>
            {saving() ? 'Saving…' : isEdit() ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
