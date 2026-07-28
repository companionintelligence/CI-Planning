import { createSignal, Show, For, createResource } from 'solid-js';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Repeat, Flame, SkipForward, CalendarDays, Rocket, X, Shapes, Target, Check, Sparkles } from 'lucide-solid';
import { type Task, api } from '../lib/api.js';
import { tasks, refetchTasks, showToast, setElementModal, tags, patternPrefs, patterns, patternTypes, refetchPatterns, patternForTask, isRoutineTask, flightPlanTaskIds, scheduledByTaskId, texturesEnabled, categoryPrefs, setCloseRitualTask } from '../stores/index.js';
import { buildPickerRows, leafObjectives, PICKER_SEARCH_THRESHOLD } from '../lib/objective-picker.js';
import { isPromotableToObjective } from '../lib/objective-promote.js';
import { directionColorForTask, directionShapeForTask, colorVar, resolveItemColor } from '../lib/pattern-meta.js';
import { elementTextureStyle } from '../lib/textures.js';
import { ShapeIcon } from './ShapeIcon.js';

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
    <div class="inline-flex h-8 rounded-lg border border-border overflow-hidden text-[10px] font-semibold flex-shrink-0" role="group" title="Priority">
      <For each={PRIO}>
        {(o) => (
          <button
            type="button"
            onClick={() => props.onPick(o.value)}
            class="px-2 h-full flex items-center transition-colors"
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
    : props.highlight ? 'text-accent-hi font-medium'
    : 'text-muted-foreground';
  return (
    // A uniform-height pill (matches the footer's 32px controls); the clear (×) lives
    // INSIDE the bordered pill (nesting a real button in a button is invalid, so the
    // pill container is a div holding two sibling buttons).
    <div
      class="relative flex items-center h-8 rounded-lg border border-border/70 bg-muted/30 text-[11px] flex-shrink-0"
      classList={{
        'bg-accent-hi/10 border-accent-hi/40': props.highlight === 'accent',
        'bg-accent-hi/20 border-accent-hi/60': props.highlight === 'routine',
      }}
    >
      <button
        type="button"
        class="flex items-center gap-1 h-full pl-2.5 rounded-lg hover:text-foreground"
        classList={{ 'pr-1.5': !ymd(), 'pr-1': !!ymd() }}
        title={`Set ${props.label.toLowerCase()} date`}
        onClick={openPicker}
      >
        <CalendarDays size={11} class={`flex-shrink-0 ${props.highlight ? 'text-accent-hi' : 'text-muted-foreground'}`} />
        <span class={labelClass()}>{props.label} {display()}</span>
      </button>
      <Show when={ymd()}>
        <button type="button" class="flex items-center h-full pr-2 text-muted-foreground hover:text-red-400" title={`Clear ${props.label.toLowerCase()} date`} onClick={() => props.onSet('')}>
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
  const canPromote = () => isPromotableToObjective(props.task);

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
  // ENTITY-4 · Give the task its own leaf objective, named after it, and linked —
  // the same one-click promotion the Planner card offers, so the two surfaces mean
  // the same thing. No prompt: the objective WRAPS this task (source_task_id), so
  // an independently-typed name would misdescribe it. Idempotent server-side.
  async function newObjectiveFromTask() {
    try {
      await api.tasks.promoteObjective(props.task.id);
      refetchTasks();
      showToast(`"${props.task.title}" is now an objective`, 'success');
      props.close();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    // Opens ABOVE the footer button (the sorting actions now live in the card footer).
    <div class="absolute z-20 bottom-full left-0 mb-1 w-56 rounded-md border border-border bg-popover shadow-lg py-1">
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
            {/* Only a dead end when the footer row below is hidden — otherwise the
                way out is right there, so don't send the owner to another tab. */}
            <p class="px-3 py-1.5 text-xs text-muted-foreground">
              No objectives yet{canPromote() ? '.' : ' — create one on the Objectives tab.'}
            </p>
          </Show>
          <Show when={leafCount() > 0 && rows().length === 0}>
            <p class="px-3 py-1.5 text-xs text-muted-foreground">No match</p>
          </Show>
        </div>
        {/* ENTITY-4 · Pinned BELOW the scroll area (unlike the routine menu, whose
            footer scrolls with its list) so it stays reachable at any list length.
            Hidden for the tasks the server refuses — an owner should never click a
            row we already know answers 422 not_promotable. */}
        <Show when={canPromote()}>
          <button onClick={newObjectiveFromTask} class="w-full text-left px-3 py-1.5 text-sm text-accent-hi hover:bg-sidebar-accent border-t border-border mt-1 flex items-center gap-1"><Plus size={12} /> New objective</button>
        </Show>
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
      // Both archive states un-do to open: 'done' un-completes, 'cancelled' restores.
      // 'cancelled' used to fall through to the else branch, so clicking the checkbox
      // on a Thrown-away card marked it DONE instead of bringing it back.
      if (props.task.status === 'done' || props.task.status === 'cancelled') {
        await api.tasks.update(props.task.id, { status: 'open', completed_at: null });
      } else {
        await api.tasks.update(props.task.id, { completed: true });
        // Close ritual (0137): offered AFTER the completion lands, never as a gate on it.
        // Raised to the APP-LEVEL store because refetchTasks() below drops this task from
        // the open list and unmounts this very card — a card-local modal would die with it.
        // Habits and recurring instances are ticked off constantly and often in bulk;
        // prompting on each would turn a ritual into a nag. One-off tasks only.
        if (!props.task.is_habit && !props.task.recurrence_parent_id) setCloseRitualTask(props.task);
      }
      refetchTasks();
      refetchStreak();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // D4 — memory enrichment for this one task. Always resolves; `enriched:false` carries a
  // reason (memory off, nothing related), which we show verbatim rather than pretending
  // something happened. Only ever FILLS BLANKS server-side — never rewrites the user's own
  // description or replaces a direction they chose.
  const [enriching, setEnriching] = createSignal(false);
  async function enrich() {
    setEnriching(true);
    try {
      const r = await api.tasks.enrich(props.task.id);
      if (r.enriched) {
        const bits = [
          r.description && 'description',
          r.direction && `direction (${r.direction})`,
          r.categories?.length && `categories (${r.categories.join(', ')})`,
        ].filter(Boolean);
        showToast(`Filled in ${bits.join(' + ')}`, 'success');
        refetchTasks();
      } else {
        showToast(r.reason ?? 'Nothing to add', 'default');
      }
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setEnriching(false); }
  }

  async function remove() {
    // DELETE is a soft cancel (services/tasks.ts: status → 'cancelled'), so the task
    // lands in the Archive — but nothing restores it from there, so don't imply it.
    if (!confirm(`Cancel "${props.task.title}"? It moves to the Archive.`)) return;
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
  // Membership for the sorting rail's accent state (objective_id fallback covers
  // payloads from before objective_ids shipped).
  const inObjective = () => !!(props.task.objective_ids?.length || props.task.objective_id);

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

  // Habit toggle — promote a standard task into a habit (server also ensures its Habit
  // pattern) or demote it back to standard. Confirmed like the other footer mutations.
  async function toggleHabit() {
    const makeHabit = !props.task.is_habit;
    if (!confirm(makeHabit
      ? 'Make this a habit? It will recur and be checked off on the planner.'
      : 'Stop tracking this as a habit?')) return;
    try {
      if (makeHabit) await api.tasks.promoteHabit(props.task.id);
      else await api.tasks.update(props.task.id, { is_habit: false });
      showToast(makeHabit ? 'Now a habit' : 'No longer a habit', 'default');
      refetchTasks();
      refetchStreak();
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

  // §D: a task already staged in the flight-plan is dimmed; its flight-plan button stays
  // rendered but reads as "in the flight-plan" (subtle accent tint) instead of the filled
  // "send" CTA — see the button's classList below.
  const inFlightPlan = () => flightPlanTaskIds().has(props.task.id);
  const dimmed = () => props.task.status === 'cancelled' || inFlightPlan();
  // Phase C: EVERY task can paint a texture now (was routine-only). Resolution lives
  // in elementTextureStyle: per-element opt-out → colour override → category stripes
  // (position order) → the legacy routine motif → none. Still skipped when dimmed
  // (opacity-40 × a 3% texture ≈ invisible mud) and gated on the Settings toggle.
  /** A category name → its pref hue (the same map the stripes use), for the chip dot. */
  const categoryDotColor = (name: string) => {
    const t = (tags() ?? []).find((x) => x.kind === 'category' && x.name.toLowerCase() === name.toLowerCase());
    const token = t ? categoryPrefs()?.prefs?.[t.id]?.color_token : undefined;
    return token ? `var(--${token})` : 'var(--muted-foreground)';
  };

  const cardTexture = () => {
    if (!texturesEnabled() || dimmed()) return undefined;
    const r = isRoutineTask(props.task.id) ? patternForTask(props.task.id) : undefined;
    const style = elementTextureStyle(
      props.task,
      tags(),
      categoryPrefs()?.prefs,
      r ? { iconShape: r.type?.icon_shape, seedTag: r.pattern.directions?.[0] ?? r.pattern.tag } : undefined,
    );
    if (!style) return undefined;
    // The motif fallback tints currentColor — feed it the routine's item colour
    // (#391: item wins over type). Stripes carry explicit colours and ignore it.
    return r ? { ...style, color: resolveItemColor(r.pattern.color_token, r.type?.color_token) } : style;
  };

  return (
    <div class={depth() > 0 ? 'pl-6 relative' : ''}>
      {depth() > 0 && <div class="absolute left-4 top-0 bottom-0 w-px bg-surface-600/60" />}

      <div
        // Balanced layout (chips redesign): a vertical stack — title row, description,
        // full-width tags, then a single compact footer that collapses the former
        // left sorting-rail and right priority/date rail into one hairline-topped row.
        class="card group relative isolate flex flex-col"
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
        {/* Phase C texture background — category stripes / colour override / routine
            motif, a low-contrast whisper behind the content (z-index:-1 within the
            card's isolated stacking context; rounded to match). */}
        <Show when={cardTexture()}>
          {(tex) => (
            <div aria-hidden="true" style={{ ...tex(), 'z-index': '-1', 'border-radius': 'inherit' }} />
          )}
        </Show>

        {/* Row A — merged direction-icon / done toggle · title · habit/instance markers ·
            estimate (swaps to edit / delete / skip on hover). */}
        <div class="flex items-start gap-2">
          <div class="flex-shrink-0 flex justify-center">
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
                title={props.task.status === 'done' ? 'Mark open'
                  : props.task.status === 'cancelled' ? 'Restore to open'
                  : 'Mark done'}
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
          </div>

          <span class={`flex-1 min-w-0 text-sm leading-snug ${statusClass[props.task.status] ?? 'text-slate-200'}`}>
            {props.task.title}
          </span>

          <Show when={props.task.is_habit}>
            <span class="badge-neutral text-[10px] flex-shrink-0 inline-flex items-center gap-0.5 mt-0.5"><Repeat size={9} /> habit</span>
          </Show>
          <Show when={isInstance() && !props.task.is_habit}>
            <Repeat size={11} class="text-muted-foreground flex-shrink-0 mt-1" />
          </Show>

          {/* estimate → hover actions (edit / delete / skip) */}
          <div class="relative flex items-center justify-end min-h-[20px] flex-shrink-0 self-start">
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
              <Show when={isInstance()}>
                <button onClick={skip} class="btn-icon" title="Skip this occurrence"><SkipForward size={13} /></button>
              </Show>
              {/* D4 — pull related items from Companion Memory to fill in this task's
                  description (and its direction, if it has none). On demand rather than
                  automatic: it costs a memory round-trip plus a model call. Reports its
                  own no-ops honestly ("memory is off", "nothing related") instead of
                  silently doing nothing. */}
              <button onClick={enrich} disabled={enriching()} class="btn-icon" title="Fill in details from memory">
                <Sparkles size={13} classList={{ 'animate-pulse': enriching() }} />
              </button>
              <button class="btn-icon" title="Edit" onClick={() => setElementModal({ open: true, mode: 'edit', kind: props.task.is_habit ? 'habit' : 'task', editTarget: { kind: props.task.is_habit ? 'habit' : 'task', id: props.task.id } })}><Pencil size={13} /></button>
              <button onClick={remove} class="btn-icon hover:text-red-400" title="Cancel task"><Trash2 size={13} /></button>
            </div>
          </div>
        </div>

        {/* Row B — routine label + description. */}
        <Show when={routine()}>
          {(r) => (
            <div class="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground" title={`In the "${r().pattern.name}" routine`}>
              <span class="inline-flex" style={{ color: resolveItemColor(r().pattern.color_token, r().type?.color_token) }}>
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

        {/* Row C — tags, full width. Phase C (batch-3 comment): the visible secondary
            axis is now the task's CATEGORIES (colour-dotted chips, position order) —
            intentions stay in the data (grouping/auto-tag/filters) but off the card. */}
        <Show when={props.task.tags.length > 0 || (props.task.categories?.length ?? 0) > 0}>
          <div class="flex flex-wrap gap-1.5 mt-2">
            {/* Primary tags (level 1) — solid badge; includes the home/work/community direction. */}
            <For each={props.task.tags}>
              {(t) => <span class="badge-neutral text-[11px]">#{t}</span>}
            </For>
            {/* Categories (entity_categories, position order) — ghost chip + hue dot. */}
            <For each={props.task.categories ?? []}>
              {(c) => (
                <span
                  class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground/80 capitalize"
                  title="category"
                >
                  <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ 'background-color': categoryDotColor(c) }} />
                  {c}
                </span>
              )}
            </For>
          </div>
        </Show>

        {/* Habit streak strip */}
        <Show when={props.task.is_habit && streak()}>
          {(s) => (
            <div class="flex items-center gap-1.5 mt-2">
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

        {/* Row D — footer: [sub · add · objective · habit · routine] ··· [due · start · priority · flight].
            One row of uniform 32px (h-8) controls, hairline-separated. Accent = the
            reference mint (accent-hi / --mint #58ebbf), the same teal the P3 chip uses. */}
        <div class="flex items-center gap-2 flex-wrap mt-2.5 pt-2.5 border-t border-border/60">
          {/* subtask count (expand) — only when there are subtasks */}
          <Show when={subtaskCount() > 0}>
            <button
              onClick={toggleSubs}
              class="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-[10px] font-semibold text-accent-hi bg-accent-hi/10 hover:bg-accent-hi/20 transition-colors flex-shrink-0"
              title={`${subtaskCount()} subtask${subtaskCount() === 1 ? '' : 's'}`}
            >
              <Show when={showSubs()} fallback={<ChevronRight size={11} />}><ChevronDown size={11} /></Show>
              {subtaskCount()} sub
            </button>
          </Show>
          {/* add subtask */}
          <button
            class="flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground bg-muted/40 border border-border hover:text-foreground transition-colors flex-shrink-0"
            title="Add subtask"
            onClick={() => setElementModal({ open: true, mode: 'add', kind: 'task', parentId: props.task.id })}
          >
            <Plus size={15} />
          </button>

          {/* type toggles — objective · habit · routine (accent when the task belongs) */}
          <div class="flex items-center gap-1.5 flex-shrink-0 ml-1">
            <div class="relative">
              <button
                onClick={() => { setRoutineMenu(false); setObjectiveMenu((v) => !v); }}
                class="flex items-center justify-center h-8 w-8 rounded-lg border transition-colors"
                classList={{
                  'text-accent-hi border-accent-hi/50 bg-accent-hi/10': inObjective(),
                  'text-muted-foreground/50 border-border hover:text-foreground': !inObjective(),
                }}
                title={inObjective() ? 'In an objective — manage' : 'Add to objective'}
              >
                <Target size={15} />
              </button>
              <Show when={objectiveMenu()}>
                <ObjectiveMenu task={props.task} close={() => setObjectiveMenu(false)} />
              </Show>
            </div>
            <button
              onClick={toggleHabit}
              class="flex items-center justify-center h-8 w-8 rounded-lg border transition-colors"
              classList={{
                'text-accent-hi border-accent-hi/50 bg-accent-hi/10': props.task.is_habit,
                'text-muted-foreground/50 border-border hover:text-foreground': !props.task.is_habit,
              }}
              title={props.task.is_habit ? 'A habit — click to stop tracking' : 'Make this a habit'}
              aria-pressed={props.task.is_habit}
            >
              <Repeat size={15} />
            </button>
            <div class="relative">
              <button
                onClick={() => { setObjectiveMenu(false); setRoutineMenu((v) => !v); }}
                class="flex items-center justify-center h-8 w-8 rounded-lg border transition-colors"
                classList={{
                  'text-accent-hi border-accent-hi/50 bg-accent-hi/10': isRoutineTask(props.task.id),
                  'text-muted-foreground/50 border-border hover:text-foreground': !isRoutineTask(props.task.id),
                }}
                title={isRoutineTask(props.task.id) ? 'In a routine' : 'Add to a routine'}
              >
                <Shapes size={15} />
              </button>
              <Show when={routineMenu()}>
                <div class="absolute z-20 bottom-full left-0 mb-1 w-44 rounded-md border border-border bg-popover shadow-lg max-h-56 overflow-y-auto py-1">
                  <For each={routines()}>
                    {(r) => (
                      <button onClick={() => addToRoutine(r.id, r.name)} class="w-full text-left px-3 py-1.5 text-sm hover:bg-sidebar-accent truncate">{r.name}</button>
                    )}
                  </For>
                  <Show when={routines().length === 0}>
                    <p class="px-3 py-1.5 text-xs text-muted-foreground">No routines yet</p>
                  </Show>
                  <button onClick={newRoutineWithTask} class="w-full text-left px-3 py-1.5 text-sm text-accent-hi hover:bg-sidebar-accent border-t border-border mt-1 flex items-center gap-1"><Plus size={12} /> New routine</button>
                </div>
              </Show>
            </div>
          </div>

          {/* spacer — pushes dates/priority/flight to the right, balancing the two clusters */}
          <div class="flex-1 min-w-[8px]" />

          {/* dates · priority · send-to-flight-plan */}
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <DateField label="Due" value={props.task.due_at} overdue={dueOverdue()} onSet={setDue} />
            <DateField label="Start" value={props.task.scheduled_for} highlight={startHighlight()} onSet={setStart} />
            <PriorityToggle value={p()} onPick={setPriority} />
            <button
              onClick={sendToFlightPlan}
              class="flex items-center justify-center h-8 w-8 rounded-full flex-shrink-0 transition-all"
              classList={{
                'bg-accent-hi/20 text-accent-hi': inFlightPlan(),
                'bg-accent-hi text-[#041620] hover:brightness-110': !inFlightPlan(),
              }}
              title={inFlightPlan() ? 'In the Flight-plan' : 'Send to Flight-plan'}
            >
              <Rocket size={15} />
            </button>
          </div>
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
