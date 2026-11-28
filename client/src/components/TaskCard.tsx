import { createSignal, Show, For, createResource, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { setActiveTask } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, Archive, Repeat, Flame, SkipForward, Rocket, X, Shapes, Target, Check, Sparkles, Share2 } from 'lucide-solid';
import { type Task, type RecurringScope, api } from '../lib/api.js';
import { ObjectiveMenu } from './ObjectiveMenu.js';
import { RoutineMenu } from './RoutineMenu.js';
import { tasks, refetchTasks, showToast, setElementModal, tags, patternPrefs, patternForTask, isRoutineTask, flightPlanTaskIds, scheduledByTaskId, texturesEnabled, textureColorSource, categoryPrefs, openCloseRitual, askRecurringScope, isRecurringOccurrence } from '../stores/index.js';
import { directionColorForTask, directionShapeForTask, colorVar, resolveItemColor } from '../lib/pattern-meta.js';
import { elementTextureStyle, automaticTextureColor } from '../lib/textures.js';
import { initialsOf } from '../lib/element.js';
import { localISODate } from '../lib/dates.js';
import { isTaskOverdueOnDay } from '../lib/task-buckets.js';
import { ShapeIcon } from './ShapeIcon.js';
import { DatePicker } from '../ui/index.js';

const statusClass: Record<string, string> = {
  open:      'text-foreground',
  done:      'text-muted-foreground line-through',
  scheduled: 'text-info',
  cancelled: 'text-muted-foreground line-through',
  archived: 'text-slate-500',
  deferred:  'text-warning',
};

// Priority selector options (T-TASKS-2). Color treatments live in index.css so
// semantic tokens, rather than view-owned literals, determine foreground contrast.
const PRIO: { label: string; value: number; className: string }[] = [
  { label: 'P1', value: 1, className: 'priority-choice-1' },
  { label: 'P2', value: 2, className: 'priority-choice-2' },
  { label: 'P3', value: 3, className: 'priority-choice-3' },
  { label: 'Later', value: 4, className: 'priority-choice-later' },
];

export function PriorityToggle(props: { value: number; onPick: (v: number) => void }) {
  const isSel = (optVal: number) => (optVal === 4 ? props.value >= 4 : props.value === optVal);
  return (
    <div class="inline-flex h-8 rounded-lg border border-border overflow-hidden text-[10px] font-semibold flex-shrink-0" role="group" title="Priority">
      <For each={PRIO}>
        {(o) => (
          <button
            type="button"
            onClick={() => props.onPick(o.value)}
            class={`px-2 h-full flex items-center transition-colors ${isSel(o.value) ? o.className : 'text-muted-foreground hover:text-foreground'}`}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

// Compact task date pill; the shared picker owns its calendar and clear behavior.
export function DateField(props: {
  label: string;
  value?: string | null;
  overdue?: boolean;
  /** Highlight the Start date when the task is scheduled: 'accent' = placed;
   *  'routine' = a scheduled routine member (a filled pill behind the date). */
  highlight?: 'accent' | 'routine' | null;
  onSet: (v: string) => void;
}) {
  const ymd = () => (props.value ? props.value.slice(0, 10) : '');
  const labelClass = () =>
    props.overdue ? 'text-destructive'
    : props.highlight ? 'text-accent-hi font-medium'
    : 'text-muted-foreground';
  return (
    <DatePicker
      appearance="pill"
      label={`Set ${props.label.toLowerCase()} date`}
      prefix={props.label}
      value={ymd()}
      onChange={props.onSet}
      clearable
      triggerClass={labelClass()}
      class={`text-[11px] ${props.highlight === 'accent' ? 'bg-accent-hi/10 border-accent-hi/40' : ''} ${props.highlight === 'routine' ? 'bg-accent-hi/20 border-accent-hi/60' : ''}`}
    />
  );
}

// AF-6 · Assign-to-objective dropdown (mirrors the add-to-routine menu idiom).
// Mounted only while open, so the objectives tree is fetched lazily on first
// open (fresh on each open) — deliberately NOT a global store resource.
// Every objective node can hold tasks. The picker preserves hierarchy through
// indentation so goals/projects remain distinguishable from their descendants.
interface Props {
  task: Task;
  depth?: number;
  swipeActions?: boolean;
}

export function TaskCard(props: Props) {

  const depth = () => props.depth ?? 0;
  const [expanded, setExpanded] = createSignal(false);
  const [swipeOpen, setSwipeOpen] = createSignal(false);
  const [swipeOffset, setSwipeOffset] = createSignal(0);
  const [archiveMenuOpen, setArchiveMenuOpen] = createSignal(false);
  const [archiveMenuPosition, setArchiveMenuPosition] = createSignal({ top: 0, left: 0 });
  let archiveButton: HTMLButtonElement | undefined;
  const closeArchiveMenu = () => setArchiveMenuOpen(false);
  const onArchiveMenuPointerDown = (event: PointerEvent) => {
    if (!archiveButton?.contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-task-archive-menu]')) closeArchiveMenu();
  };
  const onArchiveMenuKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeArchiveMenu(); };
  onMount(() => {
    document.addEventListener('pointerdown', onArchiveMenuPointerDown);
    document.addEventListener('keydown', onArchiveMenuKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener('pointerdown', onArchiveMenuPointerDown);
    document.removeEventListener('keydown', onArchiveMenuKeyDown);
  });
  const toggleArchiveMenu = (event: MouseEvent) => {
    event.stopPropagation();
    if (archiveMenuOpen()) { closeArchiveMenu(); return; }
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const width = 152;
    setArchiveMenuPosition({ top: Math.min(rect.bottom + 6, window.innerHeight - 96), left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) });
    setArchiveMenuOpen(true);
  };
  const [dragging, setDragging] = createSignal(false);
  const canSwipe = () => !!props.swipeActions && !props.task.shared && !['done', 'cancelled', 'archived'].includes(props.task.status);
  let touchStart: { x: number; y: number; tracking: boolean } | null = null;
  let suppressTap = false;
  const resetSwipe = () => { setDragging(false); setSwipeOffset(swipeOpen() ? -144 : 0); };
  const onSwipeStart = (event: TouchEvent) => {
    if (!canSwipe() || (event.target as HTMLElement).closest('button,a,input,select,textarea')) return;
    const touch = event.touches[0];
    touchStart = { x: touch.clientX, y: touch.clientY, tracking: false };
  };
  const onSwipeMove = (event: TouchEvent) => {
    if (!touchStart) return;
    const touch = event.touches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    if (!touchStart.tracking && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) touchStart.tracking = true;
    if (!touchStart.tracking) return;
    setDragging(true);
    setSwipeOffset(Math.max(-144, Math.min(90, dx + (swipeOpen() ? -144 : 0))));
  };
  const onSwipeEnd = (event: TouchEvent) => {
    const start = touchStart;
    touchStart = null;
    if (!start?.tracking) { resetSwipe(); return; }
    suppressTap = true;
    window.setTimeout(() => { suppressTap = false; }, 350);
    const dx = event.changedTouches[0].clientX - start.x;
    if (dx > 72 && !swipeOpen()) { setSwipeOpen(false); setSwipeOffset(0); void sendToFlightPlan(); }
    else if (dx < -55) { setSwipeOpen(true); setSwipeOffset(-144); }
    else if (dx > 55) { setSwipeOpen(false); setSwipeOffset(0); }
    else resetSwipe();
    setDragging(false);
  };
  const pastScheduled = () => {
    if (!['open', 'scheduled', 'in_progress'].includes(props.task.status) || !props.task.scheduled_for) return false;
    const start = props.task.scheduled_for;
    return /^\d{4}-\d{2}-\d{2}$/.test(start)
      ? start < localISODate()
      : Number.isFinite(Date.parse(start)) && Date.parse(start) < Date.now();
  };
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
      if (props.task.status === 'done' || props.task.status === 'cancelled' || props.task.status === 'archived') {
        await api.tasks.update(props.task.id, { status: 'open', completed_at: null });
      } else {
        await api.tasks.update(props.task.id, { completed: true });
        // Close ritual (0137): offered AFTER the completion lands, never as a gate on it.
        // Raised to the APP-LEVEL store because refetchTasks() below drops this task from
        // the open list and unmounts this very card — a card-local modal would die with it.
        //
        // 0161 removed the habit / recurring-instance exemption. It existed because these
        // get ticked in bursts and one sheet per tick was a nag — but the fix for a burst
        // is the QUEUE ("1 of 3" + skip the rest), not throwing the signal away. Habits are
        // where a felt-rating is most valuable: they are the work you repeat, so whether
        // you enjoy them is the question worth measuring.
        openCloseRitual(props.task);
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

  async function archiveTask() {
    try {
      await api.tasks.archive(props.task.id);
      showToast('Task archived', 'default');
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function confirmOverdueTask() {
    try {
      await api.tasks.update(props.task.id, { scheduled_for: localISODate(), task_time: null, status: 'open' });
      const result = await api.taskAgent.place(props.task.id).catch(() => ({ placement: { placed: false, reason: 'no slot available' } }));
      refetchTasks();
      showToast(result.placement.placed ? 'Confirmed and scheduled for today' : 'Confirmed for today; it remains in Tasks until a slot is available', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function remove() {
    // A repeating occurrence is ambiguous — ask which occurrences this applies to. The
    // dialog carries its own confirmation, so the blunt confirm() is only for one-offs.
    let deleteScope: RecurringScope | undefined;
    if (isRecurringOccurrence(props.task)) {
      const answer = await askRecurringScope({ title: props.task.title, verb: 'delete' });
      if (answer === null) return;
      deleteScope = answer;
    } else {
      // DELETE is a soft cancel (services/tasks.ts: status → 'cancelled'), so the task
      // lands in the Archive — but nothing restores it from there, so don't imply it.
      if (!confirm(`Delete "${props.task.title}"? It moves to Thrown away and can be restored.`)) return;
    }
    try {
      await api.tasks.delete(props.task.id, deleteScope);
      showToast('Task moved to Thrown away', 'default');
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

  const dueOverdue = () => isTaskOverdueOnDay(props.task, localISODate());

  const awaitingHumanApproval = () => !!props.task.auto_generated && !props.task.human_approved_at;
  async function approveAutoTask() {
    try {
      await api.tasks.approve(props.task.id);
      refetchTasks();
      showToast('Task approved', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Direction of the task, defaulting to 'work' when it carries no direction tag (so the
  // merged toggle icon + card accent always read as a direction). Resolved through the
  // shared pure helpers: a real direction tag → its shape/colour; else the 'work' base.
  const dirDefs = () => tags() ?? [];
  const hasDirection = () =>
    dirDefs().some((t) => t.kind === 'direction' && (props.task.tags ?? []).includes(t.name));
  const dirTaskForIcon = (): { tags: string[] } => (hasDirection() ? { tags: props.task.tags ?? [] } : { tags: ['work'] });
  const dirColor = (): string => {
    const token = props.task.texture_color_token ?? automaticTextureColor(props.task, {
      source: textureColorSource(), tags: tags(), categories: categoryPrefs()?.prefs, directions: patternPrefs()?.prefs,
    });
    return token ? colorVar(token) : directionColorForTask(dirTaskForIcon(), dirDefs(), patternPrefs()?.prefs ?? {});
  };
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
  const dimmed = () => props.task.status === 'cancelled' || props.task.status === 'archived' || inFlightPlan();
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
      { source: textureColorSource(), tags: tags(), categories: categoryPrefs()?.prefs, directions: patternPrefs()?.prefs },
    );
    if (!style) return undefined;
    // The motif fallback tints currentColor — feed it the routine's item colour
    // (#391: item wins over type). Stripes carry explicit colours and ignore it.
    return r ? { ...style, color: resolveItemColor(r.pattern.color_token, r.type?.color_token) } : style;
  };

  return (
    <div class={depth() > 0 ? 'pl-6 relative' : ''}>
      {depth() > 0 && <div class="absolute left-4 top-0 bottom-0 w-px bg-surface-600/60" />}

      <div class="relative overflow-hidden">
        <Show when={canSwipe()}>
          <div
            class="absolute inset-y-0 left-0 flex items-center px-4 text-xs text-accent-hi gap-1"
            classList={{ 'opacity-0': inFlightPlan() }}
            aria-hidden="true"
          ><Rocket size={15} /> Flight Plan</div>
          <div
            class="absolute inset-y-0 right-0 flex items-center gap-1 px-1 transition-opacity"
            classList={{ 'opacity-0 pointer-events-none': !swipeOpen() && swipeOffset() >= -8 }}
          >
            <button type="button" class="h-10 px-2 rounded-md bg-muted text-foreground text-xs" aria-label={`Archive ${props.task.title}`} tabIndex={swipeOpen() ? 0 : -1} onClick={() => { setSwipeOpen(false); setSwipeOffset(0); void archiveTask(); }}>Archive</button>
            <button type="button" class="h-10 px-2 rounded-md bg-destructive text-destructive-foreground text-xs" aria-label={`Delete ${props.task.title}`} tabIndex={swipeOpen() ? 0 : -1} onClick={() => { setSwipeOpen(false); setSwipeOffset(0); void remove(); }}>Delete</button>
          </div>
        </Show>
      <div
        onTouchStart={onSwipeStart}
        onTouchMove={onSwipeMove}
        onTouchEnd={onSwipeEnd}
        onTouchCancel={() => { touchStart = null; resetSwipe(); }}
        // A plain tap expands the row; controls retain their own actions.
        onClick={(e) => {
          if (suppressTap || (e.target as HTMLElement).closest('button,a,input,select,textarea,[role="group"]')) return;
          setExpanded((value) => !value);
        }}
        // Balanced layout (chips redesign): a vertical stack — title row, description,
        // full-width tags, then a single compact footer that collapses the former
        // left sorting-rail and right priority/date rail into one hairline-topped row.
        class="task-card card mb-1.5 rounded-none group relative isolate flex flex-col"
        // While a dropdown is open, lift this card above its siblings: each card is
        // `isolate`, so a z-20 popover inside it would otherwise paint UNDER later
        // sibling cards (DOM order wins at equal z) and they'd swallow menu clicks.
        // Also suspend the §D dim (opacity-40 multiplies the whole subtree — a 40%-
        // opaque menu over neighbouring cards is unreadable) until the menu closes.
        classList={{
          'opacity-40': dimmed() && !objectiveMenu() && !routineMenu(),
          'z-30': objectiveMenu() || routineMenu(),
          'touch-pan-y': canSwipe(),
          'transition-transform duration-150 ease-out': canSwipe() && !dragging(),
          'task-card-past-scheduled': pastScheduled(),
          'task-card-awaiting-approval': awaitingHumanApproval(),
        }}
        style={{
          transform: canSwipe() ? `translateX(${swipeOffset()}px)` : undefined,
          '--task-direction-color': dirColor(),
        }}
      >
        {/* Phase C texture background — category stripes / colour override / routine
            motif, a low-contrast whisper behind the content (z-index:-1 within the
            card's isolated stacking context; rounded to match). */}
        <Show when={cardTexture()}>
          {(tex) => (
            <div aria-hidden="true" class="-z-[1] rounded-none" style={tex()} />
          )}
        </Show>

        {/* Row A — merged direction-icon / done toggle · title · habit/instance markers ·
            estimate (swaps to edit / delete / skip on hover). */}
        <div class="flex items-start gap-2">
          <button type="button" class="btn-icon flex-shrink-0" aria-label={expanded() ? 'Collapse task' : 'Expand task'} aria-expanded={expanded()} onClick={() => setExpanded((value) => !value)}>
            <Show when={expanded()} fallback={<ChevronRight size={14} />}><ChevronDown size={14} /></Show>
          </button>
          <div class="flex-shrink-0 flex justify-center">
            <Show
              when={!props.task.is_habit}
              fallback={
                <span class="mt-0.5 w-[18px] h-[18px] rounded-sm border border-border flex items-center justify-center cursor-default opacity-60"
                  title="Habit — mark occurrences done on the planner, not here">
                  <Repeat size={11} class="text-muted-foreground" />
                </span>
              }
            >
              <button
                onClick={toggleDone}
                class="mt-0.5 w-[18px] h-[18px] rounded-sm border flex items-center justify-center transition-colors hover:border-primary"
                classList={{ 'border-border': props.task.status !== 'done' }}
                style={props.task.status === 'done'
                  ? { background: dirColor(), 'border-color': dirColor() }
                  : { 'border-color': dirColor() }}
                title={props.task.status === 'done' ? 'Mark open'
                  : props.task.status === 'cancelled' || props.task.status === 'archived' ? 'Restore to open'
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

          <span class={`flex-1 min-w-0 text-sm leading-snug ${expanded() ? '' : 'truncate'} ${statusClass[props.task.status] ?? 'text-slate-200'}`}>
            {props.task.title}
          </span>

          <Show when={props.task.shared}>
            <span class="inline-flex items-center gap-1 text-[10px] text-muted-foreground shrink-0" title={`Shared task${props.task.shared_by ? ` from ${props.task.shared_by}` : ''}; edits sync to the owner`}>
              <Share2 size={11} /> Shared
            </span>
          </Show>

          <Show when={awaitingHumanApproval()}>
            <button
              class="inline-flex items-center gap-1 text-[10px] auto-generated-approval flex-shrink-0"
              onClick={(ev) => { ev.stopPropagation(); void approveAutoTask(); }}
              title="Approve this AI-created task"
            >
              <Check size={11} /> Approve
            </button>
          </Show>

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
              <Show when={!props.task.shared}>
                <button onClick={enrich} disabled={enriching()} class="btn-icon" title="Fill in details from memory">
                  <Sparkles size={13} classList={{ 'animate-pulse': enriching() }} />
                </button>
              </Show>
              <button class="btn-icon" title="Edit" onClick={() => setElementModal({ open: true, mode: 'edit', kind: props.task.is_habit ? 'habit' : 'task', editTarget: { kind: props.task.is_habit ? 'habit' : 'task', id: props.task.id } })}><Pencil size={13} /></button>
              <button ref={archiveButton} type="button" onClick={toggleArchiveMenu} class="btn-icon" title="Archive or delete task" aria-label={`Archive or delete ${props.task.title}`} aria-haspopup="menu" aria-expanded={archiveMenuOpen()}><Archive size={13} /></button>
            </div>
          </div>
        </div>

        <Show when={archiveMenuOpen()}>
          <Portal>
            <div data-task-archive-menu role="menu" aria-label={`Actions for ${props.task.title}`} class="fixed z-[100] w-40 rounded-md border border-border bg-popover p-1 shadow-lg" style={{ top: `${archiveMenuPosition().top}px`, left: `${archiveMenuPosition().left}px` }}>
              <button type="button" role="menuitem" class="w-full rounded px-3 py-2 text-left text-xs hover:bg-sidebar-accent" onClick={() => { closeArchiveMenu(); void archiveTask(); }}><Archive size={13} class="mr-2 inline" />Archive</button>
              <button type="button" role="menuitem" class="w-full rounded px-3 py-2 text-left text-xs text-destructive hover:bg-destructive/10" onClick={() => { closeArchiveMenu(); void remove(); }}><Trash2 size={13} class="mr-2 inline" />Delete</button>
            </div>
          </Portal>
        </Show>

        <Show when={pastScheduled() && !props.task.is_habit && !props.task.shared}>
          <div class="mt-2 ml-9 flex items-center gap-1.5" role="group" aria-label={`Triage overdue task ${props.task.title}`}>
            <button type="button" class="rounded border border-primary/40 px-2 py-1 text-[11px] text-primary hover:bg-primary/10" title="Keep this task open and move it to today" onClick={() => void confirmOverdueTask()}>Confirmed</button>
            <button type="button" class="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" title="Change this task's details or schedule" onClick={() => setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: props.task.id } })}>Change</button>
            <button type="button" class="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-destructive" title="Forget this task by archiving it; you can restore it later" onClick={() => void archiveTask()}>Forget</button>
          </div>
        </Show>

        <Show when={expanded()}>
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
        <Show when={props.task.tags.length > 0 || (props.task.categories?.length ?? 0) > 0 || (props.task.responsible?.length ?? 0) > 0}>
          <div class="flex flex-wrap gap-1.5 mt-2">
            {/* Primary tags (level 1) — solid badge; includes the home/work/community direction. */}
            <For each={props.task.tags}>
              {(t) => <span class="badge-neutral text-[11px]">#{t}</span>}
            </For>
            {/* Categories (entity_categories, position order) — ghost chip + hue dot. */}
            <For each={props.task.categories ?? []}>
              {(c) => (
                <span
                  class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm border border-border/60 text-muted-foreground/80 capitalize"
                  title="category"
                >
                  <span class="w-1.5 h-1.5 rounded-circle flex-shrink-0" style={{ 'background-color': categoryDotColor(c) }} />
                  {c}
                </span>
              )}
            </For>
            {/* People on work (0151) — initials only. A card has no room for names, and
                the point here is recognition at a glance: "am I on the hook, or is
                somebody else". Responsible only; beneficiaries are a detail for the
                drawer. `title` carries the full names for anyone who needs them. */}
            <For each={(props.task.responsible ?? []).slice(0, 3)}>
              {(person) => (
                <span
                  class="inline-flex items-center justify-center w-4 h-4 rounded-circle border border-border/60 text-[9px] font-semibold text-muted-foreground/90"
                  title={`Responsible: ${(props.task.responsible ?? []).map((p) => p.display_name).join(', ')}`}
                >
                  {initialsOf(person.display_name)}
                </span>
              )}
            </For>
            <Show when={(props.task.responsible?.length ?? 0) > 3}>
              <span class="text-[10px] text-muted-foreground/80 self-center">
                +{(props.task.responsible?.length ?? 0) - 3}
              </span>
            </Show>
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
                      class="w-2 h-2 rounded-circle"
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
        <div class="task-card-footer flex items-center gap-2 flex-wrap mt-2.5 pt-2.5 border-t border-border/60">
          <button type="button" class="btn-ghost text-xs" onClick={() => { setActiveTask(props.task.id); revealDetails(); }}>Details</button>
          <Show when={!props.task.shared}>
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
                onClick={() => {
                  setObjectiveMenu(false);
                  setRoutineMenu((v) => !v);
                }}
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
                <RoutineMenu taskId={props.task.id} close={() => setRoutineMenu(false)} />
              </Show>
            </div>
          </div>
          </Show>

          {/* spacer — pushes dates/priority/flight to the right, balancing the two clusters */}
          <div class="task-card-footer-spacer flex-1 min-w-[8px]" />

          {/* dates · priority · send-to-flight-plan */}
          <div class="task-card-footer-meta flex items-center gap-1.5 flex-shrink-0">
            <DateField label="Due" value={props.task.due_at} overdue={dueOverdue()} onSet={setDue} />
            <DateField label="Start" value={props.task.scheduled_for} highlight={startHighlight()} onSet={setStart} />
            <PriorityToggle value={p()} onPick={setPriority} />
            <Show when={!props.task.shared}>
            <button
              onClick={sendToFlightPlan}
              class="flex items-center justify-center h-8 w-8 rounded-sm flex-shrink-0 transition-all"
              classList={{
                'bg-accent-hi/20 text-accent-hi': inFlightPlan(),
                'bg-accent-hi text-accent-hi-foreground hover:brightness-110': !inFlightPlan(),
              }}
              title={inFlightPlan() ? 'In the Flight-plan' : 'Send to Flight-plan'}
            >
              <Rocket size={15} />
            </button>
            </Show>
          </div>
        </div>
        </Show>
      </div>
      </div>

      {/* Subtasks */}
      <Show when={expanded() && showSubs()}>
        <div class="animate-slide-down">
          <Show when={subtasks.loading}>
            <div class="pl-6 py-2 text-xs text-slate-500 animate-pulse2">Loading subtasks…</div>
          </Show>
          <For each={subtasks()}>
            {(sub) => <TaskCard task={sub} depth={(depth()) + 1} swipeActions={props.swipeActions} />}
          </For>
          <Show when={(subtasks()?.length ?? 0) === 0 && !subtasks.loading}>
            <div class="pl-6 py-1.5 text-xs text-slate-600 italic">No subtasks yet</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
