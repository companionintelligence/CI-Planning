import { Show, For, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Pencil, Repeat, Unlink, LockOpen, Lock, Trash2, X, Save, Star, Sparkles, Play, Plus, LayoutTemplate } from 'lucide-solid';
import {
  tasks, taskOf, blocks, tags, patternPrefs, categoryPrefs, patterns, patternTypes, blockTemplates,
  setElementModal, showToast, refetchBlocks, refetchFlightPlan, refetchTasks,
} from '../stores/index.js';
import { activeTask, activeBlock, clearActiveEntity } from '../stores/selection.js';
import { api, type Block, type Task } from '../lib/api.js';
import { directionColorForTask, BASE_TAG_DEFAULTS } from '../lib/pattern-meta.js';
import { blockColorVar } from '../lib/textures.js';
import { displayTag } from '../lib/tag-tax.js';
import { splitTagNames } from '../lib/multi-tag.js';
import { PX_PER_MIN, minutesIntoDay } from '../lib/grid.js';
import { type AxisState, yOf as axisYOf, axisHeightPx, visibleExtent, topCollapseEnd, bottomCollapseStart } from '../lib/day-axis.js';
import { isImmovable } from '../lib/drag.js';
import { ShapeIcon } from './ShapeIcon.js';

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Estimated card height (px) — used only to clamp the anchor so the card stays on-grid. */
const CARD_H = 196;

/**
 * The expanded Planner entity card (replaces the old header strip for tasks and the
 * pop-up menu for blocks). Clicking a task / habit / Time-Block on the Planner
 * expands it into this card, overlaid on the grid at the entity's slot, showing its
 * details and the full set of actions. Renders nothing when no entity is expanded.
 *
 * Rendered inside the grid column so it moves with the timeline and aligns to the
 * entity it describes; a transparent backdrop closes it without falling through to
 * click-to-create.
 *
 * `state` is the Planner's segmented day-axis expand state: the card anchors to its
 * entity's slot via the piecewise `yOf` and clamps into the full axis height so it is
 * never clipped. If the entity's start falls in a currently-collapsed region, the card
 * pins to that region's expanded edge (via `visibleExtent`). Omitted (e.g. in
 * isolation) the state defaults to both-collapsed.
 */
export function PlannerEntityCard(props: {
  day: string;
  onRequestDeletePlan: (block: Block) => void;
  state?: () => AxisState;
}) {
  const axisState = (): AxisState => props.state?.() ?? { topExpanded: false, bottomExpanded: false };
  // Resolve the expanded entity: a focused task, or a focused block.
  const taskSel = (): Task | undefined => {
    const id = activeTask();
    if (!id) return undefined;
    return taskOf(id) ?? (tasks() ?? []).find((t) => t.id === id);
  };
  const blockSel = (): Block | undefined => {
    const id = activeBlock();
    if (!id) return undefined;
    return (blocks() ?? []).find((b) => b.id === id);
  };
  const open = () => !!activeTask() || !!activeBlock();

  // The block to position against + act on: the focused block, or the focused task's
  // block on the viewed day (absent when the task isn't scheduled today).
  const block = (): Block | undefined => blockSel() ?? (blocks() ?? []).find((b) => b.task_id === activeTask());
  // The task behind the card: the focused task, or the focused block's linked task.
  const task = (): Task | undefined => taskSel() ?? (block()?.task_id ? taskOf(block()!.task_id) : undefined);
  // Linked subtasks of the focused task (excludes thrown-away) — listed in the card so
  // each can be completed independently without leaving the Planner.
  const subtasks = (): Task[] => {
    const t = task();
    return t ? (tasks() ?? []).filter((s) => s.parent_id === t.id && s.status !== 'cancelled') : [];
  };

  const isContainer = () => blockSel()?.block_kind === 'timeblock';
  const title = () => task()?.title ?? block()?.title ?? '';
  const kindLabel = () => {
    if (isContainer()) return 'Time Block';
    const t = task();
    if (t) return t.is_habit ? 'Habit' : 'Task';
    return (blockSel()?.block_kind ?? 'block').replace(/^\w/, (c) => c.toUpperCase());
  };

  // Direction (shape + colour) — from the task, else the block's category/tag colour.
  const dirTag = () => {
    const t = task();
    if (!t) return undefined;
    return (tags() ?? []).find((x) => x.kind === 'direction' && (t.tags ?? []).includes(x.name));
  };
  const dirShape = () => {
    const d = dirTag();
    if (!d) return 'circle';
    return patternPrefs()?.prefs?.[d.id]?.icon_shape ?? BASE_TAG_DEFAULTS[d.name.toLowerCase()]?.icon_shape ?? 'circle';
  };
  const accent = () => {
    const t = task();
    if (t) return directionColorForTask(t, tags() ?? [], patternPrefs()?.prefs ?? {});
    const b = block();
    return b ? blockColorVar(b, categoryPrefs()?.prefs) : 'var(--primary)';
  };

  // The grouping labels: a block's #tag(s) or its Time Block Category name (0069); a
  // task's first tag. AF-11 Slice 5: a block tag can be a comma-joined multi-direction
  // union (legacy wizard / routine-container rows) — each name gets its own chip.
  const groupLabels = (): string[] => {
    const b = blockSel();
    if (b) {
      if (b.tag) return splitTagNames(b.tag).map((n) => `#${n}`);
      if (b.category_id) { const c = (tags() ?? []).find((t) => t.id === b.category_id); if (c) return [displayTag(c.name)]; }
      return [];
    }
    const t = task();
    return t?.tags?.[0] ? [`#${t.tags[0]}`] : [];
  };
  const secondary = () => task()?.secondary_tags ?? blockSel()?.secondary_tags ?? [];
  const durationMin = () => {
    const b = block();
    return b ? Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000) : undefined;
  };
  const locked = () => { const b = block(); return b ? isImmovable(b) : false; };

  // ── Position: anchor to the entity's slot on the segmented axis, clamped so the
  // whole card stays inside the full axis height (never clipped). A start inside a
  // collapsed region pins to that region's expanded edge via visibleExtent.
  const topPx = () => {
    const st = axisState();
    const total = axisHeightPx(st, PX_PER_MIN);
    const lo = 0;
    const hi = Math.max(lo, total - CARD_H);
    const b = block();
    if (!b) return lo + 8;
    const startMin = minutesIntoDay(b.start_at, props.day);
    const ext = visibleExtent(startMin, startMin + 1, st);
    // Wholly-collapsed start → anchor to the region's expanded-facing edge (07:00 for
    // the top bar, 21:00 for the bottom), not inside the thin bar. This mirrors
    // day-axis minAt's collapsed clamp (top→endMin, bottom→startMin).
    const edgeMin = startMin < topCollapseEnd(st) ? topCollapseEnd(st) : bottomCollapseStart(st);
    const y = axisYOf(ext ? ext.startMin : edgeMin, st, PX_PER_MIN);
    return Math.max(lo, Math.min(y, hi));
  };

  // ── Actions ────────────────────────────────────────────────────────────────────
  function edit() {
    if (isContainer()) { const b = blockSel()!; setElementModal({ open: true, mode: 'edit', kind: 'timeblock', editTarget: { kind: 'timeblock', id: b.id } }); return; }
    const t = task();
    if (t) { setElementModal({ open: true, mode: 'edit', kind: t.is_habit ? 'habit' : 'task', editTarget: { kind: t.is_habit ? 'habit' : 'task', id: t.id } }); return; }
    showToast('Nothing to edit on this block', 'default');
  }
  async function promoteHabit() {
    const t = task(); if (!t) return;
    try { await api.tasks.promoteHabit(t.id); showToast(`"${t.title}" is now a habit`, 'success'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function detach() {
    const b = block(); if (!b) return;
    try { await api.blocks.update(b.id, { parent_block_id: null }); refetchBlocks(); showToast('Removed from Time Block', 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function unlock() {
    const b = block(); if (!b) return;
    try { await api.blocks.update(b.id, { is_locked: false }); refetchBlocks(); showToast('Unlocked', 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function saveTemplate() {
    const b = blockSel(); if (!b) return;
    const s = Date.parse(b.start_at), e = Date.parse(b.end_at);
    const members = (blocks() ?? [])
      .filter((x) => x.block_kind === 'task' && Date.parse(x.start_at) < e && Date.parse(x.end_at) > s)
      .map((x) => ({
        title: taskOf(x.task_id)?.title ?? x.title,
        tag: taskOf(x.task_id)?.tags?.[0] ?? x.tag ?? null,
        estimated_minutes: Math.round((Date.parse(x.end_at) - Date.parse(x.start_at)) / 60000),
        offset_minutes: Math.max(0, Math.round((Date.parse(x.start_at) - s) / 60000)),
      }));
    try {
      // AF-8: upsert by name — re-saving a same-named block refreshes its template.
      const { updated } = await api.blockTemplates.create({ name: b.title, tag: b.tag ?? undefined, default_minutes: Math.round((e - s) / 60000), tasks: members, upsert: true });
      showToast(`${updated ? 'Updated' : 'Saved'} "${b.title}" template (${members.length} task${members.length === 1 ? '' : 's'})`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  // §L: quick-add a routine's tasks into this Plan (reuses place-today with a block_id).
  const [routineMenu, setRoutineMenu] = createSignal(false);
  const routineTypeId = () => (patternTypes() ?? []).find((t) => t.name === 'Routine')?.id;
  const routines = () => (patterns() ?? []).filter((p) => p.type_id === routineTypeId());
  async function addRoutine(routineId: string, name: string) {
    const b = blockSel(); if (!b) return;
    try {
      const { result } = await api.patterns.placeToday(routineId, { block_id: b.id, date: props.day });
      refetchBlocks(); refetchTasks();
      setRoutineMenu(false);
      // The engine only places routine members whose tag matches a tagged block, and
      // only where a gap fits — so "placed 0" is a real outcome, not a success.
      if (result.placed > 0) showToast(`Added ${result.placed} from "${name}"`, 'success');
      // AF-11 Slice 5: the block tag can be a multi-name union — show every name.
      else if (b.tag) showToast(`Nothing in "${name}" is tagged ${splitTagNames(b.tag).map((n) => `#${n}`).join(' / ')} — nothing added`, 'default');
      else showToast(`"${name}" didn't fit this block`, 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // §M: swap this Plan's contents for a saved template (of the same tag / type).
  const [templateMenu, setTemplateMenu] = createSignal(false);
  const applicableTemplates = () => {
    const b = blockSel();
    const all = blockTemplates() ?? [];
    // Prefer templates matching the block's tag ("of a type"); fall back to all when
    // the block is untagged/category-owned so the picker is never empty. AF-11 Slice 5:
    // equality is PER-NAME — a multi-direction block matches a template on any of its
    // names (and a legacy multi-name template tag is split the same way).
    if (!b?.tag) return all;
    const blockNames = new Set(splitTagNames(b.tag).map((n) => n.toLowerCase()));
    return all.filter((t) => splitTagNames(t.tag).some((n) => blockNames.has(n.toLowerCase())));
  };
  async function applyTemplate(templateId: string, name: string) {
    const b = blockSel(); if (!b) return;
    if (!confirm(`Replace this block's tasks with the "${name}" template? Current open tasks return to the backlog.`)) return;
    try {
      await api.blockTemplates.applyToBlock(templateId, b.id);
      refetchBlocks(); refetchTasks(); refetchFlightPlan();
      showToast(`Applied "${name}"`, 'success');
      setTemplateMenu(false);
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function remove() {
    const b = block();
    // All container deletes route through requestDeletePlan in the Planner — it
    // recomputes childCount from the authoritative store and either deletes directly
    // (0 children) or shows the keep/remove dialog (>0 children). Bypassing this
    // path with a client-side childCount check risks leaving orphaned child chips
    // visible when the store is stale.
    if (isContainer() && b) { clearActiveEntity(); props.onRequestDeletePlan(b); return; }
    if (!b) { clearActiveEntity(); return; }
    try {
      await api.blocks.delete(b.id);
      if (b.task_id) await api.flightPlan.addTask(b.task_id); // re-stage the task
      refetchBlocks(); refetchFlightPlan();
      showToast(b.task_id ? 'Removed — sent back to the flight-plan' : 'Removed', 'default');
      clearActiveEntity();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  // Complete / re-open a single subtask in place — independent of the parent.
  async function toggleSub(s: Task) {
    try {
      if (s.status === 'done') await api.tasks.update(s.id, { status: 'open', completed_at: null });
      else await api.tasks.update(s.id, { completed: true });
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Esc closes the card.
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open()) clearActiveEntity(); };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  const rationale = createMemo(() => blockSel()?.rationale ?? null);

  return (
    <Show when={open()}>
      {/* Backdrop: closes the card; stops propagation so it never falls through to
          click-to-create on the grid. */}
      <div class="absolute inset-0 z-[44]" onPointerDown={(e) => { e.stopPropagation(); clearActiveEntity(); }} />
      <div
        class="absolute left-1.5 right-1.5 z-[45] rounded-xl border border-border bg-popover shadow-2xl overflow-hidden"
        style={{ top: `${topPx()}px`, 'border-left': `4px solid ${accent()}` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Header: type + title + close */}
        <div class="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-border">
          <div class="flex-shrink-0 mt-0.5" style={{ color: accent() }}>
            <Show when={dirTag()} fallback={<Star size={15} />}><ShapeIcon shape={dirShape()} size={15} strokeWidth={1.75} /></Show>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground leading-none">{kindLabel()}</div>
            <div class="text-sm font-semibold text-foreground truncate mt-0.5" title={title()}>{title()}</div>
          </div>
          <button onClick={clearActiveEntity} class="btn-icon flex-shrink-0" title="Close (Esc)"><X size={15} /></button>
        </div>

        {/* Details */}
        <div class="px-3 py-2 flex flex-col gap-1.5 text-xs">
          <Show when={block()}>
            {(b) => (
              <div class="flex items-center gap-2 text-muted-foreground tabular-nums">
                <span class="text-foreground">{fmtTime(b().start_at)}–{fmtTime(b().end_at)}</span>
                <Show when={durationMin()}>{(m) => <span>· {m()}m</span>}</Show>
                <Show when={locked()}><span class="inline-flex items-center gap-0.5"><Lock size={11} /> locked</span></Show>
                <Show when={b().status === 'completed'}><span class="inline-flex items-center gap-0.5 text-primary"><Play size={10} /> done</span></Show>
              </div>
            )}
          </Show>
          <Show when={groupLabels().length > 0 || secondary().length > 0}>
            <div class="flex flex-wrap items-center gap-1">
              <For each={groupLabels()}>{(lbl) => <span class="text-[11px] px-1.5 py-0.5 rounded-full" style={{ color: accent(), 'background-color': `color-mix(in srgb, ${accent()} 14%, transparent)` }}>{lbl}</span>}</For>
              <For each={secondary()}>{(name) => <span class="text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground">{name}</span>}</For>
            </div>
          </Show>
          <Show when={rationale()}>
            {(r) => (
              <div class="flex items-start gap-1.5 text-[11px] text-primary leading-snug mt-0.5">
                <Sparkles size={11} class="flex-shrink-0 mt-0.5" /><span>{r()}</span>
              </div>
            )}
          </Show>
          <Show when={task()?.notes || task()?.description}>
            <p class="text-[11px] text-muted-foreground leading-snug whitespace-pre-wrap line-clamp-4">{task()!.notes ?? task()!.description}</p>
          </Show>
          <Show when={!block()}>
            <div class="text-[11px] text-muted-foreground italic">Not scheduled on this day.</div>
          </Show>
        </div>

        {/* Subtasks — the primary task's children; each completes independently. */}
        <Show when={subtasks().length > 0}>
          <div class="px-3 py-2 border-t border-border flex flex-col gap-1">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
              Subtasks · {subtasks().filter((s) => s.status === 'done').length}/{subtasks().length}
            </div>
            <div class="flex flex-col gap-0.5 max-h-44 overflow-y-auto -mx-1 px-1">
              <For each={subtasks()}>
                {(s) => (
                  <div class="flex items-center gap-2 py-0.5">
                    <button
                      onClick={() => toggleSub(s)}
                      class={`checkbox flex-shrink-0 ${s.status === 'done' ? 'checkbox-checked' : ''}`}
                      title={s.status === 'done' ? 'Mark open' : 'Mark done'}
                    >
                      <Show when={s.status === 'done'}>
                        <svg viewBox="0 0 10 10" class="w-full h-full p-0.5" fill="none">
                          <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                      </Show>
                    </button>
                    <span class={`text-xs truncate ${s.status === 'done' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>{s.title}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Actions */}
        <div class="flex flex-wrap items-center gap-1 px-2.5 py-2 border-t border-border bg-card/40">
          <button onClick={edit} class="btn-ghost text-xs px-2 py-1"><Pencil size={13} /> Edit</button>
          <Show when={isContainer()}>
            {/* §L: quick-add a routine's tasks into this Plan. */}
            <div class="relative">
              <button onClick={() => { setRoutineMenu((v) => !v); setTemplateMenu(false); }} class="btn-ghost text-xs px-2 py-1"><Plus size={13} /> Routine</button>
              <Show when={routineMenu()}>
                <div class="absolute z-20 left-0 bottom-full mb-1 w-48 rounded-md border border-border bg-popover shadow-lg max-h-56 overflow-y-auto py-1">
                  <For each={routines()}>
                    {(r) => <button onClick={() => addRoutine(r.id, r.name)} class="w-full text-left px-3 py-1.5 text-sm hover:bg-sidebar-accent truncate">{r.name}</button>}
                  </For>
                  <Show when={routines().length === 0}><p class="px-3 py-1.5 text-xs text-muted-foreground">No routines yet</p></Show>
                </div>
              </Show>
            </div>
            {/* §M: swap this block's contents for a saved template. */}
            <div class="relative">
              <button onClick={() => { setTemplateMenu((v) => !v); setRoutineMenu(false); }} class="btn-ghost text-xs px-2 py-1"><LayoutTemplate size={13} /> Apply template</button>
              <Show when={templateMenu()}>
                <div class="absolute z-20 left-0 bottom-full mb-1 w-48 rounded-md border border-border bg-popover shadow-lg max-h-56 overflow-y-auto py-1">
                  <For each={applicableTemplates()}>
                    {(t) => <button onClick={() => applyTemplate(t.id, t.name)} class="w-full text-left px-3 py-1.5 text-sm hover:bg-sidebar-accent truncate">{t.name}<span class="text-muted-foreground"> · {t.tasks?.length ?? 0}</span></button>}
                  </For>
                  <Show when={applicableTemplates().length === 0}><p class="px-3 py-1.5 text-xs text-muted-foreground">No templates yet</p></Show>
                </div>
              </Show>
            </div>
            <button onClick={saveTemplate} class="btn-ghost text-xs px-2 py-1"><Save size={13} /> Save as template</button>
          </Show>
          <Show when={task() && !task()!.is_habit && !isContainer()}>
            <button onClick={promoteHabit} class="btn-ghost text-xs px-2 py-1"><Repeat size={13} /> Promote to habit</button>
          </Show>
          <Show when={block()?.parent_block_id != null}>
            <button onClick={detach} class="btn-ghost text-xs px-2 py-1"><Unlink size={13} /> Remove from Time Block</button>
          </Show>
          <Show when={locked()}>
            <button onClick={unlock} class="btn-ghost text-xs px-2 py-1"><LockOpen size={13} /> Unlock</button>
          </Show>
          <Show when={block()}>
            <button onClick={remove} class="btn-ghost text-xs px-2 py-1 hover:text-destructive ml-auto"><Trash2 size={13} /> Remove</button>
          </Show>
        </div>
      </div>
    </Show>
  );
}
