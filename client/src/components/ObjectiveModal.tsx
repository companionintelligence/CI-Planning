import { createSignal, createResource, For, Show } from 'solid-js';
import { X } from 'lucide-solid';
import { api, type Objective, type ObjectiveInput } from '../lib/api.js';
import { showToast } from '../stores/index.js';

/** Flatten the objectives tree into indented rows for the parent picker. */
interface FlatObjective { id: string; title: string; level: string; depth: number; has_tasks: boolean }
function flattenObjectives(nodes: Objective[], depth = 0, out: FlatObjective[] = []): FlatObjective[] {
  for (const n of nodes) {
    out.push({ id: n.id, title: n.title, level: n.level, depth, has_tasks: n.has_tasks });
    if (n.children?.length) flattenObjectives(n.children, depth + 1, out);
  }
  return out;
}
/** Ids of a node + its whole subtree — ineligible as its own parent (would cycle). */
function subtreeIds(o: Objective, acc: Set<string> = new Set()): Set<string> {
  acc.add(o.id);
  for (const c of o.children ?? []) subtreeIds(c, acc);
  return acc;
}

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
  const [parentId, setParentId] = createSignal(props.objective?.parent_id ?? props.defaultParentId ?? '');
  const [saving, setSaving] = createSignal(false);

  // §N: grouping — pick a parent to nest this objective under a project / goal.
  // Options are every OTHER objective (self + its subtree excluded to avoid cycles);
  // the server (height-based leveling + containment) is the backstop for illegal moves.
  const [tree] = createResource(() => api.objectives.list().then((r) => r.objectives));
  const excluded = () => (props.objective ? subtreeIds(props.objective) : new Set<string>());
  const parentOptions = () => flattenObjectives(tree() ?? []).filter((o) => !excluded().has(o.id));

  // Translate the backend's containment 422 into a human message that names the
  // chosen parent, so the user understands why the nest was rejected.
  function humanizeSaveError(msg: string): string {
    if (/task-bearing objective/i.test(msg)) {
      const parent = parentOptions().find((o) => o.id === parentId());
      const name = parent ? `'${parent.title}'` : 'that objective';
      return `Can't nest under ${name} because it already has tasks linked to it.`;
    }
    return msg;
  }

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
        parent_id: parentId() || null, // §N: '' → top-level
      };
      if (isEdit()) {
        await api.objectives.update(props.objective!.id, body);
      } else {
        await api.objectives.create(body);
      }
      props.onSaved();
      props.onClose();
    } catch (err) {
      showToast(humanizeSaveError((err as Error).message), 'error');
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

          {/* §N: nest under a project / goal (or leave top-level). Grouping happens here. */}
          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-muted-foreground">Parent</span>
            <select class="input text-sm" value={parentId()} onChange={(e) => setParentId(e.currentTarget.value)}>
              <option value="">None (top-level)</option>
              <For each={parentOptions()}>
                {(o) => <option value={o.id} disabled={o.has_tasks}>{`${'  '.repeat(o.depth)}${o.title} · ${o.level}${o.has_tasks ? ' — has tasks' : ''}`}</option>}
              </For>
            </select>
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
