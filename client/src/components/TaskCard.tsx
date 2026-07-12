import { createSignal, Show, For, createResource } from 'solid-js';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Repeat, Flame, SkipForward, CalendarDays, Rocket, X, Shapes, Target, Check } from 'lucide-solid';
import { type Task, api } from '../lib/api.js';
import { tasks, refetchTasks, showToast, setElementModal, tags, patternPrefs, patterns, patternTypes, refetchPatterns, patternForTask, isRoutineTask, flightPlanTaskIds, scheduledByTaskId } from '../stores/index.js';
import { buildPickerRows, leafObjectives, PICKER_SEARCH_THRESHOLD } from '../lib/objective-picker.js';
import { directionColorForTask, directionShapeForTask, colorVar } from '../lib/pattern-meta.js';
import { textureStyle } from '../lib/textures.js';
import { ShapeIcon } from './ShapeIcon.js';
import { EightPointStar } from './EightPointStar.js';
import { useNavigate } from '@solidjs/router';

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
function DateField(props: {
  label: string;
  value?: string | null;
  overdue?: boolean;
  /** Highlight the Start date when the task is scheduled: 'accent' = placed;
   *  'routine' = a scheduled routine member (a filled pill behind the date). */
  highlight?: 'accent' | 'routine' | null;
  onSet: (v: string) => void;
}) {
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
  const labelClass = () =>
    props.overdue ? 'text-red-400'
    : props.highlight ? 'text-primary font-medium'
    : 'text-muted-foreground';
  return (
    <div class="relative flex items-center gap-1 text-[11px]">
      <button
        type="button"
        class="flex items-center gap-1 rounded hover:text-foreground"
        classList={{
          'px-1 -mx-1 bg-primary/10': props.highlight === 'accent',
          'px-1.5 -mx-1 bg-primary/20 ring-1 ring-primary/40': props.highlight === 'routine',
        }}
        title={`Set ${props.label.toLowerCase()} date`}
        onClick={openPicker}
      >
        <CalendarDays size={11} class={`flex-shrink-0 ${props.highlight ? 'text-primary' : 'text-muted-foreground'}`} />
        <span class={labelClass()}>{props.label} {display()}</span>
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

// AF-6 · Assign-to-objective dropdown (mirrors the add-to-routine menu idiom).
// Mounted only while open, so the objectives tree is fetched lazily on first
// open (fresh on each open) — deliberately NOT a global store resource.
// Leaf-only filtering + row building live in lib/objective-picker.ts: the
// server rejects links to non-leaf objectives (422 non_leaf), so goals and
// projects never appear here.
function ObjectiveMenu(props: { task: Task; close: () => void }) {
  // Fetch errors are caught HERE (toast + empty tree) so the menu stays usable and a
  // failed request is never mistaken for the "No objectives yet" empty state below.
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [objectivesTree] = createResource(async () => {
    try {
      const r = await api.objectives.list();
      setLoadFailed(false);
      return r.objectives;
    } catch (err) {
      showToast((err as Error).message, 'error');
      setLoadFailed(true);
      return [];
    }
  });
  const [query, setQuery] = createSignal('');
  const leafCount = () => leafObjectives(objectivesTree() ?? []).length;
  // AF-10: checked-state comes from the FULL linked set (M:N), not just the first
  // link. objective_id fallback covers payloads from before objective_ids shipped.
  const linkedIds = () =>
    props.task.objective_ids ?? (props.task.objective_id ? [props.task.objective_id] : []);
  const rows = () => buildPickerRows(objectivesTree() ?? [], query(), linkedIds());

  async function link(id: string, title: string) {
    try {
      await api.objectives.linkTask(id, props.task.id);
      showToast(`Linked to "${title}"`, 'success');
      refetchTasks(); // SSE also broadcasts; explicit refetch keeps the star snappy
    } catch (err) {
      // Defensive: 422 non_leaf (list filtering should prevent it) and any other failure.
      showToast((err as Error).message, 'error');
    }
    props.close();
  }
  async function unlink(objectiveId: string) {
    try {
      await api.objectives.unlinkTask(objectiveId, props.task.id);
      showToast('Removed from objective', 'default');
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
    props.close();
  }

  return (
    <div class="absolute z-20 right-0 top-full mt-1 w-56 rounded-md border border-border bg-popover shadow-lg py-1">
      <Show when={!objectivesTree.loading} fallback={<p class="px-3 py-1.5 text-xs text-muted-foreground animate-pulse2">Loading objectives…</p>}>
        <Show when={leafCount() > PICKER_SEARCH_THRESHOLD}>
          <div class="px-2 pb-1">
            <input
              type="text"
              class="w-full bg-input border border-border rounded px-2 py-1 text-xs"
              placeholder="Search objectives…"
              aria-label="Search objectives"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              ref={(el) => setTimeout(() => el.focus())}
            />
          </div>
        </Show>
        <div class="max-h-56 overflow-y-auto">
          <For each={rows()}>
            {(o) => (
              <button
                onClick={() => (o.checked ? unlink(o.id) : link(o.id, o.title))}
                class="w-full text-left pr-3 py-1.5 text-sm hover:bg-sidebar-accent flex items-center gap-1.5"
                style={{ 'padding-left': `${12 + o.depth * 10}px` }}
                title={o.path ? `${o.path} › ${o.title}` : o.title}
                aria-checked={o.checked}
                role="menuitemcheckbox"
              >
                <span class="w-3.5 flex-shrink-0">
                  <Show when={o.checked}><Check size={13} class="text-primary" /></Show>
                </span>
                <span class="truncate" classList={{ 'text-primary font-medium': o.checked }}>{o.title}</span>
              </button>
            )}
          </For>
          <Show when={loadFailed()}>
            <p class="px-3 py-1.5 text-xs text-red-400">Couldn't load objectives — close and retry.</p>
          </Show>
          <Show when={leafCount() === 0 && !loadFailed()}>
            <p class="px-3 py-1.5 text-xs text-muted-foreground">No objectives yet — create one on the Objectives tab.</p>
          </Show>
          <Show when={leafCount() > 0 && rows().length === 0}>
            <p class="px-3 py-1.5 text-xs text-muted-foreground">No match</p>
          </Show>
        </div>
        {/* AF-10: no "Remove from objective" footer — with M:N links a single
            footer is ambiguous; each CHECKED row toggles ITS OWN link off. */}
      </Show>
    </div>
  );
}

interface Props {
  task: Task;
  depth?: number;
}

export function TaskCard(props: Props) {
  const navigate = useNavigate();
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
    // Send explicit null to CLEAR — undefined is dropped by JSON.stringify and no-ops server-side.
    try { await api.tasks.update(props.task.id, { due_at: v || null }); refetchTasks(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function setStart(v: string) {
    if (!confirm(v ? `Set the start date to ${v}?` : 'Clear the start date? This unschedules the task.')) return;
    // Clearing the start intent unschedules the task server-side (its placement block is removed).
    try { await api.tasks.update(props.task.id, { scheduled_for: v || null }); refetchTasks(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  // T-TASKS-5: stage this task into the Flight-plan in one click (never schedules).
  async function sendToFlightPlan() {
    try {
      const r = await api.flightPlan.addTask(props.task.id);
      showToast(r.added ? 'Added to Flight-plan' : 'Already in Flight-plan', 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // AF-6: assign-to-objective menu open state (menu component fetches lazily).
  const [objectiveMenu, setObjectiveMenu] = createSignal(false);

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

  // Direction of the task, defaulting to 'work' when it carries no direction tag (so the
  // merged toggle icon + card accent always read as a direction). Resolved through the
  // shared pure helpers: a real direction tag → its shape/colour; else the 'work' base.
  const dirDefs = () => tags() ?? [];
  const hasDirection = () =>
    dirDefs().some((t) => t.kind === 'direction' && (props.task.tags ?? []).includes(t.name));
  const dirTaskForIcon = (): { tags: string[] } => (hasDirection() ? { tags: props.task.tags ?? [] } : { tags: ['work'] });
  const dirColor = (): string => directionColorForTask(dirTaskForIcon(), dirDefs(), patternPrefs()?.prefs ?? {});
  const dirShape = (): string => directionShapeForTask(dirTaskForIcon(), dirDefs(), patternPrefs()?.prefs ?? {});

  // "Scheduled" = a real placement on the planner (any engine) OR a persisted scheduled
  // status — drives the accent behind the Start date (a stronger pill for routine members).
  const isScheduled = () =>
    !props.task.is_habit && (props.task.status === 'scheduled' || scheduledByTaskId().has(props.task.id));
  const startHighlight = (): 'accent' | 'routine' | null =>
    !isScheduled() ? null : isRoutineTask(props.task.id) ? 'routine' : 'accent';

  // The Routine this task belongs to (name + type icon), for the label line under the title.
  const routine = () => (isRoutineTask(props.task.id) ? patternForTask(props.task.id) : undefined);

  const est = () => props.task.estimated_minutes
    ? <span class="text-xs font-mono text-slate-600">{props.task.estimated_minutes}m</span>
    : null;

  // §D: a task already staged in the flight-plan is dimmed + loses its "send" button.
  const inFlightPlan = () => flightPlanTaskIds().has(props.task.id);
  const dimmed = () => props.task.status === 'cancelled' || inFlightPlan();
  // §C: a routine member paints its Routine's texture as the card background — but not
  // when the card is dimmed (opacity-40 × the 6% texture ≈ invisible mud; skip it).
  const routineTex = () => (!dimmed() && isRoutineTask(props.task.id) ? patternForTask(props.task.id) : undefined);

  return (
    <div class={depth() > 0 ? 'pl-6 relative' : ''}>
      {depth() > 0 && <div class="absolute left-4 top-0 bottom-0 w-px bg-surface-600/60" />}

      <div
        class="card group flex gap-3 relative isolate"
        // While a dropdown is open, lift this card above its siblings: each card is
        // `isolate`, so a z-20 popover inside it would otherwise paint UNDER later
        // sibling cards (DOM order wins at equal z) and they'd swallow menu clicks.
        // Also suspend the §D dim (opacity-40 multiplies the whole subtree — a 40%-
        // opaque menu over neighbouring cards is unreadable) until the menu closes.
        classList={{
          'opacity-40': dimmed() && !objectiveMenu() && !routineMenu(),
          'z-30': objectiveMenu() || routineMenu(),
        }}
        style={{
          'margin-bottom': '6px',
          // Uniform 3px left accent for every card (no relative shift); coloured by
          // direction when the task has a pattern-tag, default border otherwise.
          'border-left-style': 'solid',
          'border-left-width': '3px',
          'border-left-color': dirColor(),
        }}
      >
        {/* §C: Routine texture background — a low-contrast whisper behind the content
            (z-index:-1 within the card's isolated stacking context; rounded to match). */}
        <Show when={routineTex()}>
          {(r) => (
            <div
              aria-hidden="true"
              style={{
                ...textureStyle(r().type?.icon_shape, r().pattern.tag),
                color: colorVar(r().type?.color_token),
                'z-index': '-1',
                'border-radius': 'inherit',
              }}
            />
          )}
        </Show>

        {/* Left gutter: the merged direction-icon / done toggle — a SQUARE button showing
            the task's direction shape; clicking it checks the task off (filled + check when
            done). Habits keep the non-clickable Repeat marker (done on the planner). The
            8-pointed objective star stacks below. Actions live in the right rail. */}
        <div class="flex flex-col items-center gap-1 flex-shrink-0">
          <Show
            when={!props.task.is_habit}
            fallback={
              <span class="mt-0.5 w-[18px] h-[18px] rounded-[4px] border border-border flex items-center justify-center cursor-default opacity-60"
                title="Habit — mark occurrences done on the planner, not here">
                <Repeat size={11} class="text-muted-foreground" />
              </span>
            }
          >
            <button
              onClick={toggleDone}
              class="mt-0.5 w-[18px] h-[18px] rounded-[4px] border flex items-center justify-center transition-colors hover:border-primary"
              classList={{ 'border-border': props.task.status !== 'done' }}
              style={props.task.status === 'done'
                ? { background: dirColor(), 'border-color': dirColor() }
                : { 'border-color': dirColor() }}
              title={props.task.status === 'done' ? 'Mark open' : 'Mark done'}
              aria-pressed={props.task.status === 'done'}
            >
              <Show
                when={props.task.status === 'done'}
                fallback={<span class="inline-flex" style={{ color: dirColor() }}><ShapeIcon shape={dirShape()} size={12} strokeWidth={1.75} /></span>}
              >
                <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
                  <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </Show>
            </button>
          </Show>
          <Show when={props.task.objective_id}>
            <button
              onClick={() => navigate(`/tasks?tab=objectives&focus=${props.task.objective_id}`)}
              class="btn-icon text-primary/70 hover:text-primary p-0"
              title="Part of an objective — view it"
            >
              <EightPointStar size={13} />
            </button>
          </Show>
        </div>

        {/* Content — title, routine label, description, tags, streak; all flush-left now
            that the direction icon lives in the toggle (no leading status dot). */}
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2">
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

          {/* Routine label — the routine's icon + name, between title and description. */}
          <Show when={routine()}>
            {(r) => (
              <div class="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground" title={`In the "${r().pattern.name}" routine`}>
                <span class="inline-flex" style={{ color: colorVar(r().type?.color_token) }}>
                  <ShapeIcon shape={r().type?.icon_shape ?? 'circle'} size={11} strokeWidth={1.75} />
                </span>
                <span class="truncate">{r().pattern.name}</span>
              </div>
            )}
          </Show>

          <Show when={props.task.notes || props.task.description}>
            <p class="text-xs text-slate-500 mt-1 line-clamp-2">
              {props.task.notes ?? props.task.description}
            </p>
          </Show>

          <Show when={props.task.tags.length > 0 || (props.task.secondary_tags?.length ?? 0) > 0}>
            <div class="flex flex-wrap gap-1 mt-1.5">
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
              <div class="flex items-center gap-1.5 mt-1.5">
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
            <div
              class="absolute right-0 top-0 flex items-center gap-0.5 transition-opacity duration-100"
              // Hover-reveal, EXCEPT while a dropdown is open: an open menu must not
              // fade out (or worse, stay clickable at opacity-0) when the pointer
              // leaves the card mid-pick (e.g. while typing in the objective search).
              classList={{
                'opacity-0 group-hover:opacity-100': !objectiveMenu() && !routineMenu(),
                'opacity-100': objectiveMenu() || routineMenu(),
              }}
            >
              <Show when={!inFlightPlan()}>
                <button onClick={sendToFlightPlan} class="btn-icon hover:text-primary" title="Send to Flight-plan"><Rocket size={13} /></button>
              </Show>
              <Show when={isInstance()}>
                <button onClick={skip} class="btn-icon" title="Skip this occurrence"><SkipForward size={13} /></button>
              </Show>
              {/* AF-6: assign to / remove from an objective — leaf objectives only. */}
              <div class="relative">
                {/* The two dropdowns are mutually exclusive — opening one closes the other. */}
                <button onClick={() => { setRoutineMenu(false); setObjectiveMenu((v) => !v); }} class="btn-icon hover:text-primary" title="Assign to objective"><Target size={13} /></button>
                <Show when={objectiveMenu()}>
                  <ObjectiveMenu task={props.task} close={() => setObjectiveMenu(false)} />
                </Show>
              </div>
              {/* Add to a routine — pick an existing one or create a new routine with this task. */}
              <div class="relative">
                <button onClick={() => { setObjectiveMenu(false); setRoutineMenu((v) => !v); }} class="btn-icon hover:text-primary" title="Add to a routine"><Shapes size={13} /></button>
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
          <DateField label="Start" value={props.task.scheduled_for} highlight={startHighlight()} onSet={setStart} />
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
