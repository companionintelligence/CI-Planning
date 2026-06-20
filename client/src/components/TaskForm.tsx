import { createSignal, createEffect, Show, For } from 'solid-js';
import { X, Plus, AlignLeft, Clock, Calendar, Tag, Flag, Timer, Link2, CalendarClock, Repeat, Flame } from 'lucide-solid';
import { api, type Task, type TaskInput } from '../lib/api.js';
import { refetchTasks, showToast, setTaskModal, tasks } from '../stores/index.js';
import {
  buildRule, rulePreset, describeRule, WEEKDAYS, DAY_INITIAL, type RepeatPreset,
} from '../lib/recurrence.js';

interface Props {
  editTask?: Task;
  parentId?: number;
  onClose: () => void;
}

const priorityLabels = ['', 'Urgent', 'High', 'Normal', 'Low', 'Someday'];
const priorityColors = ['', 'text-red-400', 'text-orange-400', 'text-yellow-400', 'text-blue-400', 'text-slate-400'];
const repeatLabels: Record<RepeatPreset, string> = { none: 'Once', daily: 'Daily', weekly: 'Weekly', custom: 'Custom' };
const REPEAT_OPTS: RepeatPreset[] = ['none', 'daily', 'weekly', 'custom'];

export function TaskForm(props: Props) {
  const isEdit = () => !!props.editTask;

  const [title, setTitle] = createSignal('');
  const [notes, setNotes] = createSignal('');
  const [dueAt, setDueAt] = createSignal('');
  const [taskTime, setTaskTime] = createSignal('');
  const [estimatedMinutes, setEstimatedMinutes] = createSignal('');
  const [priority, setPriority] = createSignal(3);
  const [tagsInput, setTagsInput] = createSignal('');
  const [deferUntil, setDeferUntil] = createSignal('');
  const [dependsOn, setDependsOn] = createSignal<number[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);

  // ── Recurrence (Phase E) ──
  const [repeat, setRepeat] = createSignal<RepeatPreset>('none');
  const [weekdays, setWeekdays] = createSignal<string[]>([]);
  const [customRule, setCustomRule] = createSignal('');
  const [isHabit, setIsHabit] = createSignal(false);
  const [editScope, setEditScope] = createSignal<'instance' | 'series'>('instance');

  // A task is recurring if it's a template (recurrence_rule) or an instance (parent).
  const isRecurring = () => !!(props.editTask?.recurrence_rule || props.editTask?.recurrence_parent_id);
  // Show the repeat control on create, or when editing an already-recurring task.
  const showRepeat = () => !isEdit() || isRecurring();
  const currentRule = () => buildRule(repeat(), weekdays(), customRule());

  function toggleWeekday(d: string) {
    setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]));
  }

  // Open tasks (excluding this one) are eligible blockers.
  const candidateTasks = () =>
    (tasks() ?? []).filter((t) => t.status === 'open' && t.id !== props.editTask?.id);

  // Populate from editTask
  createEffect(() => {
    const t = props.editTask;
    if (!t) return;
    setTitle(t.title);
    setNotes(t.notes ?? t.description ?? '');
    setDueAt(t.due_at ? t.due_at.slice(0, 10) : '');
    setTaskTime(t.task_time ?? '');
    setEstimatedMinutes(t.estimated_minutes ? String(t.estimated_minutes) : '');
    setPriority(t.priority ?? 3);
    setTagsInput(t.tags.join(', '));
    setDeferUntil(t.defer_until ? t.defer_until.slice(0, 10) : '');
    setDependsOn(t.depends_on ?? []);
    setIsHabit(!!t.is_habit);
    const ps = rulePreset(t.recurrence_rule);
    setRepeat(ps.preset);
    setWeekdays(ps.weekdays);
    setCustomRule(ps.custom);
    // Default a recurring-task edit to the safer per-instance scope.
    setEditScope('instance');
    setExpanded(true);
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
        defer_until: deferUntil() ? new Date(deferUntil() + 'T00:00:00').toISOString() : undefined,
        depends_on: dependsOn(),
      };

      if (!isEdit()) {
        // Create. A repeat preset makes it a recurring template (server materializes it).
        const rule = currentRule();
        if (rule) { body.recurrence_rule = rule; body.is_habit = isHabit(); }
        await api.tasks.create(body);
        showToast(rule ? 'Recurring task created' : 'Task created', 'success');
      } else if (isRecurring() && editScope() === 'series') {
        // Series edit → applies to the template; a rule change regenerates the window.
        await api.tasks.update(
          props.editTask!.id,
          { ...body, recurrence_rule: currentRule(), is_habit: isHabit() },
          'series',
        );
        showToast('Series updated', 'success');
      } else {
        // Per-instance / plain edit — recurrence pattern untouched.
        await api.tasks.update(props.editTask!.id, body);
        showToast('Task updated', 'success');
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
              class="btn-ghost text-xs self-start -mt-1 text-slate-500"
            >
              <Plus size={13} /> More options
            </button>
          </Show>

          {/* Expanded fields */}
          <Show when={expanded()}>
            <div class="flex gap-3">
              <label class="flex flex-col gap-1.5 flex-1">
                <span class="flex items-center gap-1.5 text-xs text-slate-500">
                  <Calendar size={11} /> Due date
                </span>
                <input type="date" class="input" value={dueAt()} onInput={(e) => setDueAt(e.currentTarget.value)} />
              </label>
              <label class="flex flex-col gap-1.5 flex-1">
                <span class="flex items-center gap-1.5 text-xs text-slate-500">
                  <Clock size={11} /> Task time
                </span>
                <input type="time" class="input" value={taskTime()} onInput={(e) => setTaskTime(e.currentTarget.value)} />
              </label>
              <label class="flex flex-col gap-1.5 w-28">
                <span class="flex items-center gap-1.5 text-xs text-slate-500">
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

            <div class="flex gap-3">
              <label class="flex flex-col gap-1.5 flex-1">
                <span class="flex items-center gap-1.5 text-xs text-slate-500">
                  <CalendarClock size={11} /> Defer until
                </span>
                <input type="date" class="input" value={deferUntil()} onInput={(e) => setDeferUntil(e.currentTarget.value)} />
              </label>
            </div>

            {/* ── Repeat / habit ── */}
            <Show when={showRepeat()}>
              <div class="flex flex-col gap-2 rounded-xl border border-border p-3">
                <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Repeat size={11} /> Repeat
                </span>
                <div class="flex gap-1.5">
                  <For each={REPEAT_OPTS}>
                    {(opt) => (
                      <button
                        type="button"
                        onClick={() => setRepeat(opt)}
                        class="flex-1 py-1.5 rounded-full text-xs font-medium transition-all border"
                        classList={{
                          'bg-primary text-primary-foreground border-primary': repeat() === opt,
                          'border-border text-muted-foreground hover:text-foreground': repeat() !== opt,
                        }}
                      >
                        {repeatLabels[opt]}
                      </button>
                    )}
                  </For>
                </div>

                <Show when={repeat() === 'weekly'}>
                  <div class="flex gap-1">
                    <For each={WEEKDAYS}>
                      {(d) => (
                        <button
                          type="button"
                          onClick={() => toggleWeekday(d)}
                          title={d}
                          class="flex-1 h-7 rounded-md text-xs font-semibold transition-all border"
                          classList={{
                            'bg-primary text-primary-foreground border-primary': weekdays().includes(d),
                            'border-border text-muted-foreground hover:text-foreground': !weekdays().includes(d),
                          }}
                        >
                          {DAY_INITIAL[d]}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={repeat() === 'custom'}>
                  <input
                    class="input font-mono text-xs"
                    placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
                    value={customRule()}
                    onInput={(e) => setCustomRule(e.currentTarget.value)}
                  />
                </Show>

                <Show when={currentRule()}>
                  <span class="text-[11px] text-muted-foreground">{describeRule(currentRule()!)}</span>
                </Show>

                <Show when={repeat() !== 'none'}>
                  <label class="flex items-center gap-2 cursor-pointer select-none mt-0.5">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isHabit()}
                      onClick={() => setIsHabit((v) => !v)}
                      class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
                      classList={{ 'bg-primary': isHabit(), 'bg-muted border border-border': !isHabit() }}
                    >
                      <span
                        class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
                        classList={{ 'translate-x-4': isHabit() }}
                      />
                    </button>
                    <span class="flex items-center gap-1 text-xs text-foreground">
                      <Flame size={11} class={isHabit() ? 'text-primary' : 'text-muted-foreground'} /> Make this a habit
                    </span>
                  </label>
                  <Show when={isHabit()}>
                    <span class="text-[11px] text-muted-foreground -mt-1 ml-11">Skipping a day breaks the streak.</span>
                  </Show>
                </Show>
              </div>
            </Show>

            {/* ── Edit scope (recurring edits only) ── */}
            <Show when={isEdit() && isRecurring()}>
              <div class="flex flex-col gap-1.5">
                <span class="text-xs text-muted-foreground">Apply changes to</span>
                <div class="flex gap-1.5">
                  <For each={['instance', 'series'] as const}>
                    {(scope) => (
                      <button
                        type="button"
                        onClick={() => setEditScope(scope)}
                        class="flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all"
                        classList={{
                          'bg-primary text-primary-foreground border-primary': editScope() === scope,
                          'border-border text-muted-foreground hover:text-foreground': editScope() !== scope,
                        }}
                      >
                        {scope === 'instance' ? 'This task' : 'This & future'}
                      </button>
                    )}
                  </For>
                </div>
                <span class="text-[11px] text-muted-foreground">
                  {editScope() === 'instance'
                    ? 'Edits only this occurrence.'
                    : 'Edits the whole series and regenerates upcoming occurrences.'}
                </span>
              </div>
            </Show>

            <Show when={candidateTasks().length > 0}>
              <label class="flex flex-col gap-1.5">
                <span class="flex items-center gap-1.5 text-xs text-slate-500">
                  <Link2 size={11} /> Depends on (won't schedule until these are done)
                </span>
                <select
                  multiple
                  class="input min-h-[72px]"
                  onChange={(e) =>
                    setDependsOn(Array.from(e.currentTarget.selectedOptions).map((o) => Number(o.value)))
                  }
                >
                  <For each={candidateTasks()}>
                    {(t) => <option value={t.id} selected={dependsOn().includes(t.id)}>{t.title}</option>}
                  </For>
                </select>
              </label>
            </Show>

            <label class="flex flex-col gap-1.5">
              <span class="flex items-center gap-1.5 text-xs text-slate-500">
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
              <span class="flex items-center gap-1.5 text-xs text-slate-500">
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
