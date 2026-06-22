import { createSignal, createEffect, onMount, Show, For } from 'solid-js';
import { X, Plus, AlignLeft, Clock, Calendar, Tag, Flag, Timer, Link2, CalendarClock, Repeat, Flame } from 'lucide-solid';
import { api, type Task, type TaskInput } from '../lib/api.js';
import { refetchTasks, refetchTags, showToast, setTaskModal, tasks, tags } from '../stores/index.js';
import {
  buildRule, rulePreset, describeRule, WEEKDAYS, DAY_INITIAL, type RepeatPreset,
} from '../lib/recurrence.js';
import { suggestTagsFromTitle, localDayPlus } from '../lib/tag-suggest.js';
import { sortDirections, displayTag } from '../lib/tag-tax.js';

interface Props {
  editTask?: Task;
  parentId?: string;
  onClose: () => void;
}

const priorityLabels = ['', 'Urgent', 'High', 'Normal', 'Low', 'Someday'];
const priorityColors = ['', 'text-red-400', 'text-orange-400', 'text-yellow-400', 'text-blue-400', 'text-slate-400'];
// TaskForm exposes the task-level subset (no monthly/yearly/specific-days
// distinction here; those are pattern-level in the Patterns view). Full record
// satisfies Record<RepeatPreset, string> after Phase D's preset extension.
const repeatLabels: Record<RepeatPreset, string> = {
  none: 'Once', daily: 'Daily', weekly: 'Weekly', custom: 'Custom',
  'specific-days': 'Days', monthly: 'Monthly', yearly: 'Yearly',
};
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
  // New Task wizard: Someday (suppresses scheduling → TBD list), start-day / due in
  // the reduced view, and whether the user has hand-edited tags (stops auto-tag).
  const [someday, setSomeday] = createSignal(false);
  const [scheduledFor, setScheduledFor] = createSignal('');
  const [dueOverridden, setDueOverridden] = createSignal(false);
  const [showDuePicker, setShowDuePicker] = createSignal(false);
  const [tagsTouched, setTagsTouched] = createSignal(false);
  const [deferUntil, setDeferUntil] = createSignal('');
  const [dependsOn, setDependsOn] = createSignal<string[]>([]);
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
    setScheduledFor(t.scheduled_for ?? '');
    setDueOverridden(!!t.due_at);
    setShowDuePicker(!!t.due_at);
    setTagsTouched(true); // never auto-clobber an existing task's tags
    setExpanded(true);
  });

  // Create-mode defaults: start today, due defaults to the same day, a sensible
  // estimate. (No-op for edits — populated from the task above.)
  onMount(() => {
    if (isEdit()) return;
    const today = localDayPlus(0);
    setScheduledFor(today);
    setDueAt(today);
    setEstimatedMinutes('30');
  });

  // Tag taxonomy (0036): the quick menu shows DIRECTIONS only; intention tags are
  // revealed for the selected direction(s), with directions always pinned on top.
  const allTags = () => tags() ?? [];
  const existingTagNames = () => allTags().map((t) => t.name);
  const directionTags = () => sortDirections(allTags().filter((t) => t.kind === 'pattern'));
  const selectedTags = () => tagsInput().split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
  const selectedDirectionNames = () => directionTags().map((d) => d.name).filter((n) => selectedTags().includes(n));
  // Intentions to show below: those in a selected direction, plus any already selected.
  const visibleIntentions = () =>
    allTags().filter(
      (t) => t.kind === 'intention' &&
        (t.directions.some((d) => selectedDirectionNames().includes(d)) || selectedTags().includes(t.name)),
    );
  function toggleTag(name: string) {
    setTagsTouched(true);
    const cur = selectedTags();
    const next = cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name];
    setTagsInput(next.join(', '));
  }

  // Start-day quick picks → scheduled_for; due follows the start day until the user
  // overrides it with the calendar.
  function pickStart(days: number) {
    const d = localDayPlus(days);
    setScheduledFor(d);
    if (!dueOverridden()) setDueAt(d);
  }
  const startSel = (days: number) => !someday() && scheduledFor() === localDayPlus(days);

  // Auto-tag by context (create only): heuristic instantly, LLM refine debounced;
  // both constrained to existing tags. Stops once the user touches tags.
  let llmTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const t = title();
    if (isEdit() || tagsTouched()) return;
    const existing = existingTagNames();
    const heur = suggestTagsFromTitle(t, existing);
    setTagsInput(heur.join(', '));
    clearTimeout(llmTimer);
    if (!t.trim()) return;
    llmTimer = setTimeout(async () => {
      if (tagsTouched()) return;
      try {
        const { tags: llm } = await api.tasks.suggestTags(t);
        if (tagsTouched() || title() !== t) return; // user moved on
        setTagsInput(Array.from(new Set([...heur, ...llm])).join(', '));
      } catch { /* offline: keep the heuristic */ }
    }, 600);
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (!title().trim()) return;
    setSaving(true);
    try {
      // Someday = capture title + tags only (no dates/estimate/notes) so it lands in
      // the TBD list (open + ≥1 tag + nothing scheduled). Otherwise carry the
      // reduced-view start day / duration / due date.
      const sd = someday();
      const body: TaskInput = {
        title: title().trim(),
        notes: sd ? undefined : (notes().trim() || undefined),
        scheduled_for: sd ? undefined : (scheduledFor() || undefined),
        due_at: sd ? undefined : (dueAt() || undefined),
        task_time: sd ? undefined : (taskTime() || undefined),
        estimated_minutes: sd ? undefined : (estimatedMinutes() ? Number(estimatedMinutes()) : undefined),
        priority: sd ? undefined : priority(),
        parent_id: props.parentId,
        tags: tagsInput() ? tagsInput().split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean) : [],
        defer_until: deferUntil() ? new Date(deferUntil() + 'T00:00:00').toISOString() : undefined,
        depends_on: dependsOn(),
      };

      // New intention tags created here attach to the selected direction(s) so they
      // aren't orphaned to Unsorted (a brand-new tag with no direction).
      const dirNames = new Set(directionTags().map((d) => d.name));
      const dirs = selectedDirectionNames();
      const known = new Set(existingTagNames());
      if (dirs.length) {
        for (const name of body.tags ?? []) {
          if (!known.has(name) && !dirNames.has(name)) {
            await api.tags.create(name, { kind: 'intention', directions: dirs });
          }
        }
      }

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
      refetchTags();
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

          {/* Priority: P1–P3 + Someday (Someday → unscheduled, lands in TBD). */}
          <div class="flex gap-1.5">
            <For each={[1, 2, 3]}>{(p) => (
              <button
                type="button"
                onClick={() => { setPriority(p); setSomeday(false); }}
                class="flex-1 py-1.5 rounded-full text-xs font-medium tracking-wide transition-all duration-100 border"
                style={!someday() && priority() === p
                  ? { background: 'linear-gradient(135deg,#58ebbf,#409b9b)', color: '#070d11', 'border-color': '#58ebbf' }
                  : { background: 'transparent', color: '#244859', 'border-color': '#1a3040' }}
              >P{p}</button>
            )}</For>
            <button
              type="button"
              onClick={() => setSomeday(true)}
              class="flex-1 py-1.5 rounded-full text-xs font-medium tracking-wide transition-all duration-100 border"
              style={someday()
                ? { background: 'linear-gradient(135deg,#58ebbf,#409b9b)', color: '#070d11', 'border-color': '#58ebbf' }
                : { background: 'transparent', color: '#244859', 'border-color': '#1a3040' }}
            >Someday</button>
          </div>

          {/* Quick menu: DIRECTION tags (Home/Work/Community + custom) pinned on top. */}
          <Show when={directionTags().length > 0}>
            <div class="flex flex-wrap gap-1.5">
              <For each={directionTags()}>{(d) => (
                <button
                  type="button"
                  onClick={() => toggleTag(d.name)}
                  class="px-2.5 py-1 rounded-full text-xs font-semibold border transition-all"
                  classList={{
                    'bg-primary text-primary-foreground border-primary': selectedTags().includes(d.name),
                    'border-border text-muted-foreground hover:text-foreground': !selectedTags().includes(d.name),
                  }}
                >{displayTag(d.name)}</button>
              )}</For>
            </div>
            {/* Intention tags for the selected direction(s) — only shown on drill-in. */}
            <Show when={visibleIntentions().length > 0}>
              <div class="flex flex-wrap gap-1.5 -mt-1">
                <For each={visibleIntentions()}>{(t) => (
                  <button
                    type="button"
                    onClick={() => toggleTag(t.name)}
                    class="px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all"
                    classList={{
                      'bg-primary text-primary-foreground border-primary': selectedTags().includes(t.name),
                      'border-border text-muted-foreground hover:text-foreground': !selectedTags().includes(t.name),
                    }}
                  >#{t.name}</button>
                )}</For>
              </div>
            </Show>
          </Show>

          {/* Reduced-view scheduling: start day · duration · due (hidden for Someday). */}
          <Show when={!someday()}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-slate-500 w-14">Start</span>
                <For each={[['Today', 0], ['+1 day', 1], ['+1 week', 7]] as const}>{([label, days]) => (
                  <button
                    type="button"
                    onClick={() => pickStart(days)}
                    class="flex-1 py-1 rounded-lg text-xs font-medium border transition-all"
                    classList={{
                      'bg-primary text-primary-foreground border-primary': startSel(days),
                      'border-border text-muted-foreground hover:text-foreground': !startSel(days),
                    }}
                  >{label}</button>
                )}</For>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-slate-500 w-14">Duration</span>
                <input
                  type="number" min={5} step={5} class="input flex-1"
                  placeholder="30 min"
                  value={estimatedMinutes()}
                  onInput={(e) => setEstimatedMinutes(e.currentTarget.value)}
                />
                <span class="text-xs text-slate-500">min</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-slate-500 w-14">Due</span>
                <Show
                  when={showDuePicker()}
                  fallback={
                    <button type="button" onClick={() => setShowDuePicker(true)}
                      class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                      <Calendar size={13} /> {dueAt() || 'same as start'} — change
                    </button>
                  }
                >
                  <input type="date" class="input flex-1" value={dueAt()}
                    onInput={(e) => { setDueAt(e.currentTarget.value); setDueOverridden(true); }} />
                </Show>
              </div>
            </div>
          </Show>

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
            {/* Start day, duration, and due date live in the reduced view above. */}
            <label class="flex flex-col gap-1.5 w-40">
              <span class="flex items-center gap-1.5 text-xs text-slate-500">
                <Clock size={11} /> Task time (optional)
              </span>
              <input type="time" class="input" value={taskTime()} onInput={(e) => setTaskTime(e.currentTarget.value)} />
            </label>

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
                    setDependsOn(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))
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
                <Tag size={11} /> Add new tags (comma-separated)
              </span>
              <input
                class="input"
                placeholder="work, eng, urgent"
                value={tagsInput()}
                onInput={(e) => { setTagsTouched(true); setTagsInput(e.currentTarget.value); }}
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
