import { createSignal, createEffect, Show } from 'solid-js';
import { X, Plus, AlignLeft, Clock, Calendar, Tag, Flag, Timer } from 'lucide-solid';
import { api, type Task, type TaskInput } from '../lib/api.js';
import { refetchTasks, showToast, setTaskModal, taskModal } from '../stores/index.js';

interface Props {
  editTask?: Task;
  parentId?: number;
  onClose: () => void;
}

const priorityLabels = ['', 'Urgent', 'High', 'Normal', 'Low', 'Someday'];
const priorityColors = ['', 'text-red-400', 'text-orange-400', 'text-yellow-400', 'text-blue-400', 'text-ci-1/60'];

export function TaskForm(props: Props) {
  const isEdit = () => !!props.editTask;

  const [title, setTitle] = createSignal('');
  const [notes, setNotes] = createSignal('');
  const [dueAt, setDueAt] = createSignal('');
  const [taskTime, setTaskTime] = createSignal('');
  const [estimatedMinutes, setEstimatedMinutes] = createSignal('');
  const [priority, setPriority] = createSignal(3);
  const [tagsInput, setTagsInput] = createSignal('');
  const [category, setCategory] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);

  // Populate from editTask or defaults
  createEffect(() => {
    const t = props.editTask;
    if (t) {
      setTitle(t.title);
      setNotes(t.notes ?? t.description ?? '');
      setDueAt(t.due_at ? t.due_at.slice(0, 10) : '');
      setTaskTime(t.task_time ?? '');
      setEstimatedMinutes(t.estimated_minutes ? String(t.estimated_minutes) : '');
      setPriority(t.priority ?? 3);
      setTagsInput(t.tags.join(', '));
      setCategory(t.category ?? '');
      setExpanded(true);
    } else {
      const modal = taskModal();
      if (modal.defaultDueAt) setDueAt(modal.defaultDueAt);
      if (modal.defaultTaskTime) {
        setTaskTime(modal.defaultTaskTime);
        setExpanded(true);
      }
      
      const prefilled = sessionStorage.getItem('prefilled_category');
      if (prefilled) {
        setCategory(prefilled);
        sessionStorage.removeItem('prefilled_category');
        setExpanded(true);
      } else {
        setCategory('');
      }
    }
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (!title().trim()) return;
    setSaving(true);
    try {
      const body: TaskInput = {
        title: title().trim(),
        notes: notes().trim() || undefined,
        due_at: dueAt() || undefined,
        task_time: taskTime() || undefined,
        estimated_minutes: estimatedMinutes() ? Number(estimatedMinutes()) : undefined,
        priority: priority(),
        parent_id: props.parentId,
        tags: tagsInput() ? tagsInput().split(',').map(t => t.trim()).filter(Boolean) : [],
        category: category() || undefined,
      };
      if (isEdit()) {
        await api.tasks.update(props.editTask!.id, body);
        showToast('Task updated', 'success');
      } else {
        await api.tasks.create(body);
        showToast('Task created', 'success');
      }
      refetchTasks();
      props.onClose();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal">
        {/* Header */}
        <div class="flex items-center justify-between px-5 pt-5 pb-3 border-b border-surface-700/40">
          <h2 class="font-heading text-lg tracking-wide" style={{ color: '#ABD4D8' }}>
            {props.parentId ? 'Add Subtask' : isEdit() ? 'Edit Task' : 'New Task'}
          </h2>
          <button onClick={props.onClose} class="btn-icon"><X size={16} /></button>
        </div>

        <form onSubmit={submit} class="p-5 flex flex-col gap-4">
          {/* Title */}
          <input
            autofocus
            class="input-lg font-medium"
            placeholder="Task title…"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />

          {/* Priority selector — CI teal gradient for selected */}
          <div class="flex gap-1.5">
            {[1,2,3,4,5].map(p => (
              <button
                type="button"
                onClick={() => setPriority(p)}
                class="flex-1 py-1.5 rounded-full text-xs font-medium tracking-wide transition-all duration-100 border"
                style={priority() === p ? {
                  background: 'linear-gradient(135deg,#58ebbf,#409b9b)',
                  color: '#070d11',
                  'border-color': '#58ebbf',
                } : {
                  background: 'transparent',
                  color: '#244859',
                  'border-color': '#1a3040',
                }}
              >
                P{p}
              </button>
            ))}
          </div>

          {/* Expand toggle */}
          <Show when={!expanded()}>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              class="btn-ghost text-xs self-start -mt-1 text-ci-1/60"
            >
              <Plus size={13} /> More options
            </button>
          </Show>

          {/* Expanded fields */}
          <Show when={expanded()}>
            <div class="flex gap-3">
              <label class="flex flex-col gap-1.5 flex-1">
                <span class="flex items-center gap-1.5 text-xs text-ci-1/60">
                  <Calendar size={11} /> Due date
                </span>
                <input type="date" class="input" value={dueAt()} onInput={(e) => setDueAt(e.currentTarget.value)} />
              </label>
              <label class="flex flex-col gap-1.5 flex-1">
                <span class="flex items-center gap-1.5 text-xs text-ci-1/60">
                  <Clock size={11} /> Task time
                </span>
                <input type="time" class="input" value={taskTime()} onInput={(e) => setTaskTime(e.currentTarget.value)} />
              </label>
              <label class="flex flex-col gap-1.5 w-28">
                <span class="flex items-center gap-1.5 text-xs text-ci-1/60">
                  <Timer size={11} /> Est. min
                </span>
                <input
                  type="number" min={5} step={5} class="input"
                  placeholder="30"
                  value={estimatedMinutes()}
                  onInput={(e) => setEstimatedMinutes(e.currentTarget.value)}
                />
              </label>
            </div>

            <label class="flex flex-col gap-1.5">
              <span class="flex items-center gap-1.5 text-xs text-ci-1/60">
                <AlignLeft size={11} /> Notes
              </span>
              <textarea
                class="textarea min-h-[72px]"
                placeholder="Any notes or context…"
                value={notes()}
                onInput={(e) => setNotes(e.currentTarget.value)}
              />
            </label>

            <label class="flex flex-col gap-1.5">
              <span class="flex items-center gap-1.5 text-xs text-ci-1/60">
                <Flag size={11} /> Life Priority Category
              </span>
              <select
                class="input cursor-pointer"
                value={category()}
                onChange={(e) => setCategory(e.currentTarget.value)}
              >
                <option value="">General / Uncategorized</option>
                <option value="health">Health</option>
                <option value="career">Career</option>
                <option value="relationships">Relationships</option>
                <option value="growth">Personal Growth</option>
                <option value="leisure">Leisure</option>
                <option value="finance">Finance</option>
              </select>
            </label>

            <label class="flex flex-col gap-1.5">
              <span class="flex items-center gap-1.5 text-xs text-ci-1/60">
                <Tag size={11} /> Tags (comma-separated)
              </span>
              <input
                class="input"
                placeholder="work, eng, urgent"
                value={tagsInput()}
                onInput={(e) => setTagsInput(e.currentTarget.value)}
              />
            </label>
          </Show>

          {/* Actions */}
          <div class="flex gap-2 pt-1">
            <button type="submit" disabled={saving() || !title().trim()} class="btn-primary flex-1">
              {saving() ? 'Saving…' : isEdit() ? 'Update Task' : 'Create Task'}
            </button>
            <button type="button" onClick={props.onClose} class="btn-secondary">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
