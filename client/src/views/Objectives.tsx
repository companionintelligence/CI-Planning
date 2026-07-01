import { createResource, createSignal, For, Show, onMount } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import {
  Plus, ChevronRight, ChevronDown, Circle, Square, Diamond,
  AlertTriangle, Clock, ArrowRight, Pencil, Trash2, Star,
} from 'lucide-solid';
import { STAR_GOLD } from '../lib/stars.js';
import { api, type Objective } from '../lib/api.js';
import { showToast } from '../stores/index.js';
import { ObjectiveModal } from '../components/ObjectiveModal.js';

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
 * Phase N1 — /objectives view: tree default.
 * Each row shows: level icon · progress track · title · next_action chip.
 * Rot = amber dot when progress_cache IS NULL or (cadence!=none AND no next_action).
 */
export function Objectives() {
  const [data, { refetch }] = createResource(() => api.objectives.list());
  const [params] = useSearchParams();
  const focusId = () => (typeof params.focus === 'string' ? params.focus : undefined); // §K: clicking a task's star deep-links here
  const [modal, setModal] = createSignal<
    null | { mode: 'create'; parentId?: string } | { mode: 'edit'; objective: Objective }
  >(null);

  async function deleteObjective(obj: Objective) {
    if (!confirm(`Delete "${obj.title}"?`)) return;
    try {
      await api.objectives.delete(obj.id);
      refetch();
      showToast('Objective deleted', 'default');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  return (
    <div class="flex flex-col gap-4 p-4 md:p-6 page-enter min-h-full">
      {/* Header */}
      <div class="flex items-center justify-between">
        <div>
          <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary mb-0.5">Objectives</div>
          <h1 class="text-xl font-semibold text-foreground">Goals · Projects · Objectives</h1>
        </div>
        <button
          class="btn-primary text-xs px-3 py-1.5"
          onClick={() => setModal({ mode: 'create' })}
        >
          <Plus size={13} /> New Objective
        </button>
      </div>

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
  focusId?: string;
  onEdit: (o: Objective) => void;
  onDelete: (o: Objective) => void;
  onAddChild: (parentId: string) => void;
  onRefetch: () => void;
}) {
  // Expand the top two levels by default, or any branch on the path to a focused node.
  const [expanded, setExpanded] = createSignal(
    props.depth < 2 || (!!props.focusId && subtreeHas(props.obj, props.focusId)),
  );
  const obj = () => props.obj;
  const isFocus = () => !!props.focusId && props.obj.id === props.focusId;

  // §K: when deep-linked (?focus=id), scroll the target node into view + highlight it.
  let rowRef: HTMLDivElement | undefined;
  onMount(() => { if (isFocus() && rowRef) rowRef.scrollIntoView({ block: 'center', behavior: 'smooth' }); });

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

  return (
    <div ref={rowRef} class="rounded-xl border bg-card overflow-hidden transition-shadow"
         classList={{ 'border-primary ring-1 ring-primary': isFocus(), 'border-border': !isFocus() }}
         style={{ 'margin-left': `${props.depth * 20}px` }}>
      {/* Row header */}
      <div class="flex items-center gap-2 px-3 py-2.5 group">
        {/* Expand/collapse chevron */}
        <button
          class="flex-shrink-0 btn-icon opacity-50 hover:opacity-100"
          classList={{ 'invisible': !hasChildren() }}
          onClick={() => setExpanded((v) => !v)}
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

      {/* Children */}
      <Show when={expanded() && hasChildren()}>
        <div class="border-t border-border/50 px-3 py-2 flex flex-col gap-2">
          <For each={obj().children}>
            {(child) => (
              <ObjectiveNode
                obj={child}
                depth={props.depth + 1}
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
