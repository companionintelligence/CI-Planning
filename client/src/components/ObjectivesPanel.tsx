import { createResource, createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { on } from '../lib/sse.js';
import {
  Plus, ChevronRight, ChevronDown, Circle, Square, Diamond,
  AlertTriangle, Clock, ArrowRight, Pencil, Trash2, Star,
  CheckCircle2, ListPlus, Archive, RotateCcw,
} from 'lucide-solid';
import { STAR_GOLD } from '../lib/stars.js';
import { api, type Objective, type ObjectiveTaskSummary } from '../lib/api.js';
import { showToast, refetchTasks, setElementModal, elementModal } from '../stores/index.js';
import { localISODate } from '../lib/dates.js';
import { isLeafObjective, visibleLeafTasks, executeQuickAdd } from '../lib/objectives-quickadd.js';
import { ObjectiveModal } from './ObjectiveModal.js';

/** Whether `id` is `o` or anywhere in its subtree — used to auto-expand to a focused node. */
function subtreeHas(o: Objective, id: string): boolean {
  if (o.id === id) return true;
  return (o.children ?? []).some((c) => subtreeHas(c, id));
}

// ── Level icons: goal=circle, project=square, objective (leaf)=diamond ──────────
function LevelIcon(props: { level: string; class?: string }) {
  return (
    <Show when={props.level === 'goal'} fallback={
      <Show when={props.level === 'project'} fallback={<Diamond size={14} class={props.class} />}>
        <Square size={14} class={props.class} />
      </Show>
    }>
      <Circle size={14} class={props.class} />
    </Show>
  );
}

const STATUS_CLASSES: Record<string, string> = {
  active: 'text-foreground',
  paused: 'text-muted-foreground',
  done: 'text-muted-foreground line-through',
  dropped: 'text-muted-foreground line-through opacity-50',
};

/**
 * The Objectives tree — lifted out of the retired /objectives view (AF-1) so it can
 * mount as the Tasks-screen **Objectives** tab (`/tasks?tab=objectives`).
 * Each row shows: level icon · progress track · title · next_action chip.
 * Rot = amber dot when progress_cache IS NULL or (cadence!=none AND no next_action).
 * Deep-links (`?focus=<id>`, §K — a task's objective star) still auto-expand and
 * scroll to the focused node; the param now lives on the /tasks URL.
 */
/** Mirrors PURGE_WINDOW_HOURS in server/src/services/objectives.ts — display only;
 *  the authoritative deadline is the absolute `purge_after` the server stamped. */
const PURGE_WINDOW_HOURS = 48;

/** "deletes in ~47h" / "deletes in ~12m". The hourly purge job keeps this honest to
 *  within an hour; a nightly job would make it wrong by up to a day. */
function purgeCountdown(purgeAfter: string): string {
  const ms = Date.parse(purgeAfter) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'deleting…';
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `deletes in ~${Math.round(mins / 60)}h` : `deletes in ~${mins}m`;
}

export function ObjectivesPanel() {
  const [data, { refetch }] = createResource(() => api.objectives.list());
  // AF-5: refetch() recreates every ObjectiveNode, which used to reset each node's
  // expand/collapse to the depth default — collapsing the leaf you just added a task
  // to. Panel-scoped (non-reactive) memory of explicit toggles survives refetches.
  const expandState = new Map<string, boolean>();
  const [params] = useSearchParams();
  const focusId = () => (typeof params.focus === 'string' ? params.focus : undefined); // §K: clicking a task's star deep-links here
  // AF-CU2: the ?focus scroll must be ONE-SHOT. Nothing consumes the param, so
  // every refetch (quick-add, toggle-done, delete, wizard-close) used to remount
  // the nodes and yank the viewport back to the focused row. Panel-scoped,
  // non-reactive (like expandState): remember which id already scrolled; a NEW
  // focus id scrolls once again. focusId keeps driving ancestor auto-expand.
  const focusScroll: { consumedId?: string } = {};
  const [modal, setModal] = createSignal<
    null | { mode: 'create'; parentId?: string } | { mode: 'edit'; objective: Objective }
  >(null);

  // AF-5: "More details" hands off to the global ElementWizard (add or edit mode).
  // The wizard has no save callback we can reach without editing it (file fence),
  // so refetch the tree whenever it closes while this panel is mounted — covers
  // add-mode auto-promotion saves and edit-mode changes. Harmless when nothing changed.
  createEffect<boolean>((wasOpen) => {
    const open = elementModal().open;
    if (wasOpen && !open) refetch();
    return open;
  }, elementModal().open);

  // AF-CU2 (owner decision): live tree updates. The server broadcasts these four
  // events (routes/objectives.ts, services/task-promotion.ts) but nothing client-
  // side consumed them — the tab only refreshed on its own actions. Component-
  // scoped on purpose (stores/index.ts belongs to another lane); `on()` returns
  // an unsubscribe. Debounced trailing 300ms so an SSE burst (e.g. task-promotion
  // fanning out objective + link events) collapses into one refetch.
  let sseTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefetch = () => {
    clearTimeout(sseTimer);
    sseTimer = setTimeout(() => refetch(), 300);
  };
  const unsubscribes = [
    'objective:created', 'objective:updated', 'objective:deleted', 'objective_task:updated',
  ].map((ev) => on(ev, debouncedRefetch));
  onCleanup(() => {
    clearTimeout(sseTimer);
    for (const off of unsubscribes) off();
  });

  // ── Archive (0129) ──────────────────────────────────────────────────────────
  // Its own surface: the Tasks archive is structurally unreachable from this tab
  // (AllTasks gates its showArchive flag on isTaskTab() and force-clears it on tab
  // change), and its ArchiveSection is hard-typed to Task[].
  const [showArchive, setShowArchive] = createSignal(false);
  const [archived, { refetch: refetchArchive }] = createResource(
    showArchive, // only fetches once opened
    () => api.objectives.list({ archived: '1' }).then((r) => r.objectives),
  );
  const refetchBoth = () => { refetch(); if (showArchive()) refetchArchive(); };

  async function deleteObjective(obj: Objective) {
    if (!confirm(`Archive "${obj.title}"? You can restore it from the archive.`)) return;
    try {
      await api.objectives.delete(obj.id);
      refetchBoth();
      showToast('Moved to the archive', 'default');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function restore(obj: Objective) {
    try {
      await api.objectives.restore(obj.id);
      refetchBoth();
      showToast(`"${obj.title}" restored`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function purge(obj: Objective) {
    if (!confirm(`Delete "${obj.title}" permanently? You can undo this for ${PURGE_WINDOW_HOURS} hours.`)) return;
    try {
      await api.objectives.purge(obj.id);
      refetchArchive();
      showToast('Will be deleted permanently — undo available', 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function undoPurge(obj: Objective) {
    try {
      await api.objectives.cancelPurge(obj.id);
      refetchArchive();
      showToast('Permanent deletion cancelled', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="flex flex-col gap-4">
      {/* Panel header — the page-level header belongs to the Tasks view. */}
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-foreground">Goals · Projects · Objectives</h2>
        <div class="flex items-center gap-2">
          <button
            class="btn-ghost text-xs px-2 py-1"
            classList={{ 'text-primary': showArchive() }}
            onClick={() => setShowArchive((v) => !v)}
            title={showArchive() ? 'Hide the archive' : 'Show archived objectives'}
          >
            <Archive size={13} /> Archive
          </button>
          <button
            class="btn-primary text-xs px-3 py-1.5"
            onClick={() => setModal({ mode: 'create' })}
          >
            <Plus size={13} /> New Objective
          </button>
        </div>
      </div>

      {/* Archive — a FLAT list: an archived subtree is not a tree worth rendering.
          Restore is free (the row never left the table); permanent deletion is a
          deadline that stays undoable until the hourly purge job passes it. */}
      <Show when={showArchive()}>
        <div class="rounded-xl border border-border bg-card/50 p-3 flex flex-col gap-1.5">
          <Show
            when={(archived()?.length ?? 0) > 0}
            fallback={<p class="text-xs text-muted-foreground px-1 py-2">Nothing archived.</p>}
          >
            <For each={archived() ?? []}>
              {(obj) => (
                <div class="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2.5 py-1.5">
                  <span class="flex-1 text-sm text-muted-foreground truncate" title={obj.title}>{obj.title}</span>
                  <Show when={obj.archive_root_id}>
                    <span class="badge-neutral text-[10px] flex-shrink-0" title="Archived together with its parent">in subtree</span>
                  </Show>
                  <Show when={obj.purge_after} fallback={
                    <>
                      <button class="btn-ghost text-[11px] px-2 py-0.5" onClick={() => restore(obj)}>
                        <RotateCcw size={11} /> Restore
                      </button>
                      <button class="btn-ghost text-[11px] px-2 py-0.5 hover:text-destructive" onClick={() => purge(obj)}>
                        <Trash2 size={11} /> Delete permanently
                      </button>
                    </>
                  }>
                    <span class="text-[11px] text-red-400 flex-shrink-0">{purgeCountdown(obj.purge_after!)}</span>
                    <button class="btn-ghost text-[11px] px-2 py-0.5 text-primary" onClick={() => undoPurge(obj)}>
                      <RotateCcw size={11} /> Undo
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* Tree */}
      <Show
        when={data() && (data()?.objectives?.length ?? 0) > 0}
        fallback={
          <div class="rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
            <p class="text-sm text-muted-foreground mb-3">No objectives yet.</p>
            <button
              class="btn-primary text-sm px-4 py-2"
              onClick={() => setModal({ mode: 'create' })}
            >
              <Plus size={14} /> Create your first objective
            </button>
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={data()?.objectives ?? []}>
            {(obj) => (
              <ObjectiveNode
                obj={obj}
                depth={0}
                expandState={expandState}
                focusScroll={focusScroll}
                focusId={focusId()}
                onEdit={(o) => setModal({ mode: 'edit', objective: o })}
                onDelete={deleteObjective}
                onAddChild={(parentId) => setModal({ mode: 'create', parentId })}
                onRefetch={refetch}
              />
            )}
          </For>
        </div>
      </Show>

      {/* Modal */}
      <Show when={modal()}>
        {(m) => {
          const mv = m();
          if (mv.mode === 'edit') {
            return (
              <ObjectiveModal
                objective={mv.objective}
                onClose={() => setModal(null)}
                onSaved={() => refetch()}
              />
            );
          }
          return (
            <ObjectiveModal
              defaultParentId={mv.mode === 'create' ? mv.parentId : undefined}
              onClose={() => setModal(null)}
              onSaved={() => refetch()}
            />
          );
        }}
      </Show>
    </div>
  );
}

// ── Single objective row (recursive) ──────────────────────────────────────────

function ObjectiveNode(props: {
  obj: Objective;
  depth: number;
  /** Panel-scoped memory of explicit expand/collapse toggles — survives tree refetches. */
  expandState: Map<string, boolean>;
  /** Panel-scoped one-shot latch for the ?focus scroll (AF-CU2) — survives refetch remounts. */
  focusScroll: { consumedId?: string };
  focusId?: string;
  onEdit: (o: Objective) => void;
  onDelete: (o: Objective) => void;
  onAddChild: (parentId: string) => void;
  onRefetch: () => void;
}) {
  // Expand: a remembered explicit toggle wins; otherwise the top two levels by
  // default, or any branch on the path to a focused node.
  const [expanded, setExpandedSignal] = createSignal(
    props.expandState.get(props.obj.id) ??
      (props.depth < 2 || (!!props.focusId && subtreeHas(props.obj, props.focusId))),
  );
  const setExpanded = (v: boolean) => {
    props.expandState.set(props.obj.id, v);
    setExpandedSignal(v);
  };
  const obj = () => props.obj;
  const isFocus = () => !!props.focusId && props.obj.id === props.focusId;

  // §K: when deep-linked (?focus=id), scroll the target node into view + highlight it.
  // AF-CU2: ONE-SHOT per focus id — refetches remount every node, and without the
  // latch each remount re-scrolled the viewport back here. Highlight (ring) stays.
  let rowRef: HTMLDivElement | undefined;
  onMount(() => {
    if (isFocus() && rowRef && props.focusScroll.consumedId !== props.obj.id) {
      props.focusScroll.consumedId = props.obj.id;
      rowRef.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });

  // Rot: progress is null OR (cadence not 'none' AND no next action).
  const isRotting = () =>
    obj().progress_cache === null ||
    (obj().cadence !== 'none' && !obj().next_action);

  const progressPct = () =>
    obj().progress_cache != null ? `${Math.round(obj().progress_cache! * 100)}%` : null;

  // Behind: pace_expected exists AND progress+deadband < pace_expected; never if null.
  const isBehind = () =>
    obj().pace_expected != null &&
    obj().progress_cache != null &&
    obj().progress_cache! + 0.1 < obj().pace_expected!;

  const hasChildren = () => (obj().children?.length ?? 0) > 0;

  // ── AF-5: linked tasks under a leaf + title-only quick-add ────────────────────
  const leaf = () => isLeafObjective(obj());
  // Visible rows: open/scheduled always; done only if completed today (shown checked);
  // cancelled never. completed_at is a UTC timestamp → compare on the LOCAL date.
  const leafTasks = () =>
    leaf()
      ? visibleLeafTasks(obj().tasks ?? [], localISODate(), (ts) => localISODate(new Date(ts)))
      : [];
  const [quickAdd, setQuickAdd] = createSignal(false);
  const [qaTitle, setQaTitle] = createSignal('');
  const [qaBusy, setQaBusy] = createSignal(false);
  const expandable = () => hasChildren() || leafTasks().length > 0;

  function openQuickAdd() {
    setQuickAdd(true);
    setExpanded(true);
  }
  function closeQuickAdd() {
    setQuickAdd(false);
    setQaTitle('');
  }

  /** Enter on the inline input: create per plan (subtask when source_task_id, else
   *  create-then-link), then refresh tree + task store. `openWizardAfter` = the
   *  "More details" path — same create, then jump into the wizard in EDIT mode on
   *  the new task (guarantees the link without touching ElementWizard). */
  async function submitQuickAdd(openWizardAfter = false) {
    const title = qaTitle().trim();
    if (!title || qaBusy()) return;
    setQaBusy(true);
    try {
      const { taskId } = await executeQuickAdd(obj(), title, {
        createTask: (input) => api.tasks.create(input),
        linkTask: (oid, tid) => api.objectives.linkTask(oid, tid),
      });
      closeQuickAdd();
      refetchTasks();
      props.onRefetch();
      if (openWizardAfter) {
        setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: taskId } });
      } else {
        showToast('Task added', 'default');
      }
    } catch (err) {
      // Defensive non_leaf 422 (stale tree: the node grew children elsewhere) or any
      // other failure: surface it and re-sync the tree.
      showToast((err as Error).message, 'error');
      props.onRefetch();
    } finally {
      setQaBusy(false);
    }
  }

  /** "More details": with a typed title → create now (link guaranteed) + open the
   *  wizard in edit mode. With an EMPTY title → only possible for auto-promoted
   *  objectives (source_task_id): open the add-task wizard nested under the source
   *  task; task-promotion links the save. (Manual objectives disable the button
   *  until a title is typed — post-save linking isn't reachable without editing
   *  ElementWizard, which another lane owns.) */
  function moreDetails() {
    if (qaTitle().trim()) { void submitQuickAdd(true); return; }
    const src = obj().source_task_id;
    if (!src) return; // button is disabled in this state
    closeQuickAdd();
    setElementModal({ open: true, mode: 'add', kind: 'task', parentId: src });
  }

  async function toggleTaskDone(t: ObjectiveTaskSummary) {
    try {
      if (t.status === 'done') {
        await api.tasks.update(t.id, { status: 'open', completed_at: null });
      } else {
        await api.tasks.update(t.id, { completed: true });
      }
      // A done⇄not-done PATCH recomputes progress server-side (updateTask, alongside
      // link/unlink/delete), so onRefetch's re-read of the objective picks up the moved
      // % track — no explicit /recompute needed.
      refetchTasks();
      props.onRefetch();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  return (
    <div ref={rowRef} class="rounded-xl border bg-card overflow-hidden transition-shadow"
         classList={{ 'border-primary ring-1 ring-primary': isFocus(), 'border-border': !isFocus() }}
         style={{ 'margin-left': `${props.depth * 20}px` }}>
      {/* Row header */}
      <div class="flex items-center gap-2 px-3 py-2.5 group">
        {/* Expand/collapse chevron */}
        <button
          class="flex-shrink-0 btn-icon opacity-50 hover:opacity-100"
          classList={{ 'invisible': !expandable() }}
          onClick={() => setExpanded(!expanded())}
          title={expanded() ? 'Collapse' : 'Expand'}
        >
          <Show when={expanded()} fallback={<ChevronRight size={13} />}>
            <ChevronDown size={13} />
          </Show>
        </button>

        {/* Level icon + rot dot */}
        <span class="relative flex-shrink-0">
          <LevelIcon
            level={obj().level}
            class={`flex-shrink-0 ${obj().status === 'active' ? 'text-primary' : 'text-muted-foreground'}`}
          />
          <Show when={isRotting()}>
            <span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400" title="Needs attention" />
          </Show>
        </span>

        {/* Progress track — completion reads as color filling in (Phase O · O3). A
            done objective fills the ring gold; NULL progress stays the rot dashes. */}
        <div class="relative flex-shrink-0 w-16 h-1.5 rounded-full bg-background border border-border overflow-hidden"
             title={obj().status === 'done' ? 'Complete' : (progressPct() ?? 'No plan yet')}>
          <Show when={obj().status === 'done'}>
            <div class="absolute inset-0 rounded-full" style={{ 'background-color': STAR_GOLD }} />
          </Show>
          <Show when={obj().status !== 'done' && obj().progress_cache != null}>
            <div
              class="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: progressPct()! }}
            />
          </Show>
          <Show when={obj().status !== 'done' && obj().progress_cache === null}>
            {/* Dashed — no plan */}
            <div class="absolute inset-0 border border-dashed border-border rounded-full" />
          </Show>
        </div>

        {/* Title + meta */}
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-2 flex-wrap">
            <span
              class={`text-sm font-medium truncate cursor-pointer ${STATUS_CLASSES[obj().status]}`}
              onClick={() => props.onEdit(obj())}
            >
              {obj().title}
            </span>
            <Show when={obj().status === 'done'}>
              <Star size={12} color={STAR_GOLD} fill={STAR_GOLD} class="flex-shrink-0" />
            </Show>
            <Show when={obj().level !== 'goal'}>
              <span class="text-[10px] text-muted-foreground capitalize">{obj().level}</span>
            </Show>
            <Show when={isBehind()}>
              <span class="text-[10px] text-amber-400 flex items-center gap-0.5">
                <AlertTriangle size={10} /> Behind
              </span>
            </Show>
            <Show when={obj().target_date}>
              <span class="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <Clock size={10} /> {obj().effective_target ?? obj().target_date}
              </span>
            </Show>
          </div>

          {/* Next action chip */}
          <Show when={obj().next_action}>
            <div class="flex items-center gap-1 mt-0.5">
              <ArrowRight size={10} class="text-muted-foreground flex-shrink-0" />
              <span class="text-[11px] text-muted-foreground truncate">
                {obj().next_action!.title}
              </span>
            </div>
          </Show>
          <Show when={!obj().next_action && obj().cadence !== 'none' && obj().status === 'active'}>
            <span class="text-[11px] text-amber-400 italic">No next action</span>
          </Show>
        </div>

        {/* Actions (hover reveal) */}
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {/* AF-5: task quick-add — LEAF objectives only (server rejects non-leaf links). */}
          <Show when={leaf()}>
            <button
              class="btn-icon text-muted-foreground hover:text-primary"
              onClick={openQuickAdd}
              title="Add task"
            >
              <ListPlus size={13} />
            </button>
          </Show>
          <button
            class="btn-icon text-muted-foreground hover:text-foreground"
            onClick={() => props.onAddChild(obj().id)}
            title="Add child"
          >
            <Plus size={13} />
          </button>
          <button
            class="btn-icon text-muted-foreground hover:text-foreground"
            onClick={() => props.onEdit(obj())}
            title="Edit"
          >
            <Pencil size={13} />
          </button>
          <button
            class="btn-icon text-muted-foreground hover:text-destructive"
            onClick={() => props.onDelete(obj())}
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Progress label */}
      <Show when={obj().progress_cache !== null}>
        <div class="px-3 pb-1.5 text-[10px] text-muted-foreground">
          {progressPct()} complete
        </div>
      </Show>
      <Show when={obj().progress_cache === null && obj().status === 'active'}>
        <div class="px-3 pb-1.5 text-[10px] text-muted-foreground italic">No plan yet</div>
      </Show>

      {/* AF-5: linked tasks under an expanded LEAF + inline title-only quick-add */}
      <Show when={expanded() && leaf() && (leafTasks().length > 0 || quickAdd())}>
        <div class="border-t border-border/50 px-3 py-1.5 flex flex-col">
          <For each={leafTasks()}>
            {(t) => (
              <div class="flex items-center gap-2 pl-6 py-1 min-w-0">
                <button
                  class="btn-icon flex-shrink-0"
                  onClick={() => toggleTaskDone(t)}
                  title={t.status === 'done' ? 'Reopen' : 'Mark done'}
                >
                  <Show
                    when={t.status === 'done'}
                    fallback={<Circle size={12} class="text-muted-foreground hover:text-primary" />}
                  >
                    <CheckCircle2 size={12} class="text-primary" />
                  </Show>
                </button>
                <span
                  class="text-xs truncate"
                  classList={{
                    'text-muted-foreground line-through': t.status === 'done',
                    'text-foreground': t.status !== 'done',
                  }}
                >
                  {t.title}
                </span>
                <Show when={t.due_at}>
                  {/* Same normalization as TaskCard's DateField: due_at may carry a
                      full timestamp — display the plain YYYY-MM-DD only. */}
                  <span class="text-[10px] text-muted-foreground flex items-center gap-0.5 flex-shrink-0">
                    <Clock size={9} /> {t.due_at!.slice(0, 10)}
                  </span>
                </Show>
              </div>
            )}
          </For>

          {/* Inline quick-add: Enter = create+link, Esc = cancel, "More details" = wizard. */}
          <Show when={quickAdd()}>
            <div class="flex items-center gap-2 pl-6 py-1">
              <ListPlus size={12} class="text-muted-foreground flex-shrink-0" />
              <input
                ref={(el) => {
                  // Solid runs refs at element creation, BEFORE the node is inserted
                  // (verified: el.isConnected is false here and a synchronous focus()
                  // does not take). One microtask later the input is attached — focus
                  // then, guarded in case it was removed (Esc) in the meantime.
                  queueMicrotask(() => { if (el.isConnected) el.focus(); });
                }}
                type="text"
                class="flex-1 min-w-0 bg-background border border-border rounded-md px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                placeholder="Task title — Enter to add, Esc to cancel"
                value={qaTitle()}
                disabled={qaBusy()}
                onInput={(e) => setQaTitle(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void submitQuickAdd(); }
                  if (e.key === 'Escape') { e.preventDefault(); closeQuickAdd(); }
                }}
              />
              <button
                class="text-[11px] text-muted-foreground hover:text-primary flex-shrink-0 disabled:opacity-40 disabled:hover:text-muted-foreground"
                disabled={qaBusy() || (!qaTitle().trim() && !obj().source_task_id)}
                title={
                  !qaTitle().trim() && !obj().source_task_id
                    ? 'Type a title first'
                    : 'Open the full task wizard'
                }
                onClick={moreDetails}
              >
                More details
              </button>
            </div>
          </Show>
        </div>
      </Show>

      {/* Children */}
      <Show when={expanded() && hasChildren()}>
        <div class="border-t border-border/50 px-3 py-2 flex flex-col gap-2">
          <For each={obj().children}>
            {(child) => (
              <ObjectiveNode
                obj={child}
                depth={props.depth + 1}
                expandState={props.expandState}
                focusScroll={props.focusScroll}
                focusId={props.focusId}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
                onAddChild={props.onAddChild}
                onRefetch={props.onRefetch}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
