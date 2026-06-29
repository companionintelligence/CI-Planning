import { createSignal, Show, For, createResource } from 'solid-js';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Repeat, Flame, SkipForward, CalendarDays, Rocket, X, Shapes } from 'lucide-solid';
import { type Task, api } from '../lib/api.js';
import { tasks, refetchTasks, showToast, setElementModal, tags, patternPrefs, patterns, patternTypes, refetchPatterns } from '../stores/index.js';
import { directionColorForTask } from '../lib/pattern-meta.js';

const priorityDot = ['', 'p1', 'p2', 'p3', 'p4', 'p5'] as const;
const statusClass: Record<string, string> = {
  open:      'text-slate-200',
  done:      'text-slate-500 line-through',
  scheduled: 'text-blue-300',
  cancelled: 'text-slate-600 line-through',
  deferred:  'text-yellow-500',
};

// Priority selector options (T-TASKS-2). Four buckets over the 1–5 model: P1/P2/P3
// map to 1/2/3; "Later" stores 4 and displays for any priority >= 4. Fill colours
// mirror index.css .p1/.p2/.p3/.p5; fg picked for contrast on each.
const PRIO: { label: string; value: number; bg: string; fg: string }[] = [
  { label: 'P1',    value: 1, bg: '#ef4444', fg: '#fff' },
  { label: 'P2',    value: 2, bg: '#f97316', fg: '#fff' },
  { label: 'P3',    value: 3, bg: '#58ebbf', fg: '#0b1220' },
  { label: 'Later', value: 4, bg: '#244859', fg: '#fff' },
];

function PriorityToggle(props: { value: number; onPick: (v: number) => void }) {
  const isSel = (optVal: number) => (optVal === 4 ? props.value >= 4 : props.value === optVal);
  return (
    <div class="inline-flex rounded-md border border-border overflow-hidden text-[10px] font-semibold flex-shrink-0" role="group" title="Priority">
      <For each={PRIO}>
        {(o) => (
          <button
            type="button"
            onClick={() => props.onPick(o.value)}
            class="px-1.5 py-0.5 transition-colors"
            classList={{ 'text-muted-foreground hover:text-foreground': !isSel(o.value) }}
            style={isSel(o.value) ? { background: o.bg, color: o.fg } : {}}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

// Compact inline date field: a calendar-icon BUTTON that opens the native date
// picker, plus a clear (×) button to reset the date. Matches the Today/Settings
// "pick a day" pattern but with an explicit trigger + reset.
function DateField(props: { label: string; value?: string | null; overdue?: boolean; onSet: (v: string) => void }) {
  const ymd = () => (props.value ? props.value.slice(0, 10) : '');
  const display = () => {
    const v = ymd();
    if (!v) return '—';
    const d = new Date(v + 'T00:00:00');
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  let inputRef: HTMLInputElement | undefined;
  const openPicker = () => {
    // showPicker() needs a user gesture (this click) and an in-DOM, non-hidden input.
    try { inputRef?.showPicker(); } catch { inputRef?.focus(); }
  };
  return (
    <div class="relative flex items-center gap-1 text-[11px]">
      <button type="button" class="flex items-center gap-1 hover:text-foreground" title={`Set ${props.label.toLowerCase()} date`} onClick={openPicker}>
        <CalendarDays size={11} class="flex-shrink-0 text-muted-foreground" />
        <span class={props.overdue ? 'text-red-400' : 'text-muted-foreground'}>{props.label} {display()}</span>
      </button>
      <Show when={ymd()}>
        <button type="button" class="text-muted-foreground hover:text-red-400" title={`Clear ${props.label.toLowerCase()} date`} onClick={() => props.onSet('')}>
          <X size={11} />
        </button>
      </Show>
      <input
        ref={inputRef}
        type="date"
        class="absolute bottom-0 right-0 w-0 h-0 opacity-0 pointer-events-none"
        value={ymd()}
        onChange={(e) => props.onSet(e.currentTarget.value)}
      />
    </div>
  );
}

interface Props {
  task: Task;
  depth?: number;
}

export function TaskCard(props: Props) {
  const depth = () => props.depth ?? 0;
  const p = () => Math.min(Math.max(props.task.priority, 1), 5);
  const [showSubs, setShowSubs] = createSignal(false);
  const [subsFetched, setSubsFetched] = createSignal(false);

  const [subtasks, { refetch: refetchSubs }] = createResource(
    () => (showSubs() && subsFetched() ? props.task.id : null),
    (id) => api.tasks.subtasks(id).then(r => r.subtasks)
  );

  // Habit streak strip — fetched only for habit tasks (template or instance).
  const [streak, { refetch: refetchStreak }] = createResource(
    () => (props.task.is_habit ? props.task.id : null),
    (id) => api.tasks.streak(id).catch(() => null)
  );

  const isInstance = () => !!props.task.recurrence_parent_id;

  // Number of linked subtasks, shown on the card. Counts children present in the task
  // store (accurate in the default backlog view); thrown-away ones don't count.
  const subtaskCount = () => (tasks() ?? []).filter((t) => t.parent_id === props.task.id && t.status !== 'cancelled').length;

  function toggleSubs() {
    setSubsFetched(true);
    setShowSubs(v => !v);
  }

  async function skip() {
    try {
      await api.tasks.skip(props.task.id);
      showToast('Occurrence skipped', 'default');
      refetchTasks();
      refetchStreak();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function toggleDone() {
    try {
      if (props.task.status === 'done') {
        await api.tasks.update(props.task.id, { status: 'open', completed_at: null });
      } else {
        await api.tasks.update(props.task.id, { completed: true });
      }
      refetchTasks();
      refetchStreak();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function remove() {
    try {
      await api.tasks.delete(props.task.id);
      showToast('Task cancelled', 'default');
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // T-TASKS-2: inline priority / due / start edits. Each asks for confirmation
  // before writing (per request), then writes straight through.
  async function setPriority(v: number) {
    if (v === props.task.priority) return;
    const label = PRIO.find((o) => o.value === v)?.label ?? `P${v}`;
    if (!confirm(`Change priority to ${label}?`)) return;
    try { await api.tasks.update(props.task.id, { priority: v }); refetchTasks(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function setDue(v: string) {
    if (!confirm(v ? `Set the due date to ${v}?` : 'Clear the due date?')) return;
    try { await api.tasks.update(props.task.id, { due_at: v || undefined }); refetchTasks(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function setStart(v: string) {
    if (!confirm(v ? `Set the start date to ${v}?` : 'Clear the start date?')) return;
    try { await api.tasks.update(props.task.id, { scheduled_for: v || undefined }); refetchTasks(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  // T-TASKS-5: stage this task into the Flight-plan in one click (never schedules).
  async function sendToFlightPlan() {
    try {
      const r = await api.flightPlan.addTask(props.task.id);
      showToast(r.added ? 'Added to Flight-plan' : 'Already in Flight-plan', 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Add-to-routine: pick an existing Routine-type pattern, or create one with this task.
  const [routineMenu, setRoutineMenu] = createSignal(false);
  const routineTypeId = () => (patternTypes() ?? []).find((t) => t.name === 'Routine')?.id;
  const routines = () => (patterns() ?? []).filter((p) => p.type_id === routineTypeId());
  async function addToRoutine(routineId: string, name: string) {
    try {
      await api.patterns.addTask(routineId, props.task.id);
      refetchPatterns();
      showToast(`Added to "${name}"`, 'success');
      setRoutineMenu(false);
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function newRoutineWithTask() {
    const name = prompt('New routine name')?.trim();
    if (!name) return;
    try {
      const { pattern } = await api.patterns.create({ name, type_id: routineTypeId() ?? null });
      await api.patterns.addTask(pattern.id, props.task.id);
      refetchPatterns();
      showToast(`Added to new routine "${name}"`, 'success');
      setRoutineMenu(false);
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const dueOverdue = () =>
    !!props.task.due_at && new Date(props.task.due_at) < new Date() && props.task.status !== 'done';

  // T-TASKS-3: outline the card in its direction (pattern-tag) colour. Only when the
  // task actually has a pattern-tag — undirected tasks keep the default border.
  const dirColor = (): string | null => {
    const defs = tags() ?? [];
    const names = props.task.tags ?? [];
    const hasDir = defs.some((t) => t.kind === 'pattern' && names.includes(t.name));
    return hasDir ? directionColorForTask(props.task, defs, patternPrefs()?.prefs ?? {}) : null;
  };

  const est = () => props.task.estimated_minutes
    ? <span class="text-xs font-mono text-slate-600">{props.task.estimated_minutes}m</span>
    : null;

  return (
    <div class={depth() > 0 ? 'pl-6 relative' : ''}>
      {depth() > 0 && <div class="absolute left-4 top-0 bottom-0 w-px bg-surface-600/60" />}

      <div
        class={`card group flex gap-3 ${props.task.status === 'cancelled' ? 'opacity-40' : ''}`}
        style={{
          'margin-bottom': '6px',
          // Uniform 3px left accent for every card (no relative shift); coloured by
          // direction when the task has a pattern-tag, default border otherwise.
          'border-left-style': 'solid',
          'border-left-width': '3px',
          'border-left-color': dirColor() ?? 'var(--border)',
        }}
      >
        {/* Checkbox / habit-marker — the only thing in the left gutter now. Actions
            moved to the right rail so the title / notes / tags left-align. */}
        <Show
          when={!props.task.is_habit}
          fallback={
            <span class="checkbox mt-0.5 flex-shrink-0 flex items-center justify-center cursor-default opacity-60"
              title="Habit — mark occurrences done on the planner, not here">
              <Repeat size={11} class="text-muted-foreground" />
            </span>
          }
        >
          <button
            onClick={toggleDone}
            class={`checkbox mt-0.5 flex-shrink-0 ${props.task.status === 'done' ? 'checkbox-checked' : ''}`}
            title={props.task.status === 'done' ? 'Mark open' : 'Mark done'}
          >
            <Show when={props.task.status === 'done'}>
              <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
                <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </Show>
          </button>
        </Show>

        {/* Content (unchanged: dot, title, description, tags, streak) */}
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2">
            <span class={`priority-dot mt-[5px] ${priorityDot[p()]}`} />
            <span class={`flex-1 text-sm leading-snug ${statusClass[props.task.status] ?? 'text-slate-200'}`}>
              {props.task.title}
            </span>
            {/* Linked-subtask count — visible at a glance; click to expand. */}
            <Show when={subtaskCount() > 0}>
              <button
                onClick={toggleSubs}
                class="badge-neutral text-[10px] flex-shrink-0 inline-flex items-center gap-0.5 mt-0.5 hover:text-foreground"
                title={`${subtaskCount()} subtask${subtaskCount() === 1 ? '' : 's'}`}
              >
                <Show when={showSubs()} fallback={<ChevronRight size={10} />}><ChevronDown size={10} /></Show>
                {subtaskCount()}
              </button>
            </Show>
            <Show when={props.task.is_habit}>
              <span class="badge-neutral text-[10px] flex-shrink-0 inline-flex items-center gap-0.5"><Repeat size={9} /> habit</span>
            </Show>
            <Show when={isInstance() && !props.task.is_habit}>
              <Repeat size={11} class="text-muted-foreground flex-shrink-0 mt-1" />
            </Show>
          </div>

          <Show when={props.task.notes || props.task.description}>
            <p class="text-xs text-slate-500 mt-1 ml-4 line-clamp-2">
              {props.task.notes ?? props.task.description}
            </p>
          </Show>

          <Show when={props.task.tags.length > 0 || (props.task.secondary_tags?.length ?? 0) > 0}>
            <div class="flex flex-wrap gap-1 mt-1.5 ml-4">
              {/* Primary tags (level 1) — solid badge; includes the home/work/community direction. */}
              <For each={props.task.tags}>
                {(t) => <span class="badge-neutral text-[11px]">#{t}</span>}
              </For>
              {/* Secondary tags (level>1) — ghost/outline badge to read as secondary. */}
              <For each={props.task.secondary_tags ?? []}>
                {(t) => (
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground/80"
                    title="secondary tag"
                  >
                    {t}
                  </span>
                )}
              </For>
            </div>
          </Show>

          {/* Habit streak strip */}
          <Show when={props.task.is_habit && streak()}>
            {(s) => (
              <div class="flex items-center gap-1.5 mt-1.5 ml-4">
                <div class="flex gap-0.5">
                  <For each={s().recent}>
                    {(r) => (
                      <span
                        class="w-2 h-2 rounded-full"
                        classList={{
                          'bg-primary': r.status === 'done',
                          'border border-border': r.status === 'open',
                          'bg-muted-foreground/40': r.status === 'missed',
                          'border border-muted-foreground': r.status === 'skipped',
                        }}
                        title={`${r.date}: ${r.status}`}
                      />
                    )}
                  </For>
                </div>
                <Show when={s().current > 0}>
                  <span class="flex items-center gap-0.5 text-[11px] text-primary font-medium">
                    <Flame size={10} /> {s().current}
                  </span>
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* Right rail: top slot shows the estimate, and swaps to the hover action
            buttons (over the priority toggle); then priority + Due / Start. */}
        <div class="flex flex-col items-end gap-1.5 flex-shrink-0">
          <div class="relative flex items-center justify-end min-h-[22px] w-full">
            <span class="group-hover:opacity-0 transition-opacity">{est()}</span>
            <div class="absolute right-0 top-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
              <button onClick={sendToFlightPlan} class="btn-icon hover:text-primary" title="Send to Flight-plan"><Rocket size={13} /></button>
              <Show when={isInstance()}>
                <button onClick={skip} class="btn-icon" title="Skip this occurrence"><SkipForward size={13} /></button>
              </Show>
              {/* Add to a routine — pick an existing one or create a new routine with this task. */}
              <div class="relative">
                <button onClick={() => setRoutineMenu((v) => !v)} class="btn-icon hover:text-primary" title="Add to a routine"><Shapes size={13} /></button>
                <Show when={routineMenu()}>
                  <div class="absolute z-20 right-0 top-full mt-1 w-44 rounded-md border border-border bg-popover shadow-lg max-h-56 overflow-y-auto py-1">
                    <For each={routines()}>
                      {(r) => (
                        <button onClick={() => addToRoutine(r.id, r.name)} class="w-full text-left px-3 py-1.5 text-sm hover:bg-sidebar-accent truncate">{r.name}</button>
                      )}
                    </For>
                    <Show when={routines().length === 0}>
                      <p class="px-3 py-1.5 text-xs text-muted-foreground">No routines yet</p>
                    </Show>
                    <button onClick={newRoutineWithTask} class="w-full text-left px-3 py-1.5 text-sm text-primary hover:bg-sidebar-accent border-t border-border mt-1 flex items-center gap-1"><Plus size={12} /> New routine</button>
                  </div>
                </Show>
              </div>
              <button class="btn-icon" title="Add subtask" onClick={() => setElementModal({ open: true, mode: 'add', kind: 'task', parentId: props.task.id })}><Plus size={13} /></button>
              <button class="btn-icon" title="Edit" onClick={() => setElementModal({ open: true, mode: 'edit', kind: props.task.is_habit ? 'habit' : 'task', editTarget: { kind: props.task.is_habit ? 'habit' : 'task', id: props.task.id } })}><Pencil size={13} /></button>
              <button onClick={remove} class="btn-icon hover:text-red-400" title="Cancel task"><Trash2 size={13} /></button>
            </div>
          </div>
          <PriorityToggle value={p()} onPick={setPriority} />
          <DateField label="Due" value={props.task.due_at} overdue={dueOverdue()} onSet={setDue} />
          <DateField label="Start" value={props.task.scheduled_for} onSet={setStart} />
        </div>
      </div>

      {/* Subtasks */}
      <Show when={showSubs()}>
        <div class="animate-slide-down">
          <Show when={subtasks.loading}>
            <div class="pl-6 py-2 text-xs text-slate-500 animate-pulse2">Loading subtasks…</div>
          </Show>
          <For each={subtasks()}>
            {(sub) => <TaskCard task={sub} depth={(depth()) + 1} />}
          </For>
          <Show when={(subtasks()?.length ?? 0) === 0 && !subtasks.loading}>
            <div class="pl-6 py-1.5 text-xs text-slate-600 italic">No subtasks yet</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
