import { Show, For } from 'solid-js';
import { Pencil, Repeat, Unlink, LockOpen, Trash2, X } from 'lucide-solid';
import { tasks, taskOf, blocks, tags, patternPrefs, setElementModal, showToast, refetchBlocks, refetchFlightPlan } from '../stores/index.js';
import { activeTask, clearActiveTask } from '../stores/selection.js';
import { api } from '../lib/api.js';
import { directionColorForTask, BASE_TAG_DEFAULTS } from '../lib/pattern-meta.js';
import { ShapeIcon } from './ShapeIcon.js';

/**
 * Selected Task Summary (T-PLAN-3) — the inline panel that replaces the Planner
 * block-click pop-up (T-PLAN-4). Driven by the `activeTask` signal (set when a
 * task chip is clicked). Shows the task's name in its direction colour, the
 * direction shape icon, its secondary tags, and the same actions the old chip
 * menu offered (Edit · Promote to habit · Remove from Time Block · Remove) — so
 * dropping the pop-up loses no capability. Renders nothing when no task is active.
 */
export function SelectedTaskSummary() {
  const task = () => {
    const id = activeTask();
    if (!id) return undefined;
    return taskOf(id) ?? (tasks() ?? []).find((t) => t.id === id);
  };
  // The task's block on the current day (for detach / remove). May be absent if
  // the active task isn't scheduled on the viewed day → those actions hide.
  const block = () => (blocks() ?? []).find((b) => b.task_id === activeTask());

  const dirTag = () => {
    const t = task();
    if (!t) return undefined;
    return (tags() ?? []).find((x) => x.kind === 'pattern' && (t.tags ?? []).includes(x.name));
  };
  const dirShape = () => {
    const d = dirTag();
    if (!d) return 'circle';
    return patternPrefs()?.prefs?.[d.id]?.icon_shape ?? BASE_TAG_DEFAULTS[d.name.toLowerCase()]?.icon_shape ?? 'circle';
  };
  const dirColor = () => {
    const t = task();
    return t ? directionColorForTask(t, tags() ?? [], patternPrefs()?.prefs ?? {}) : 'var(--primary)';
  };
  const secondary = () => task()?.secondary_tags ?? [];

  function edit() {
    const t = task();
    if (!t) return;
    setElementModal({ open: true, mode: 'edit', kind: t.is_habit ? 'habit' : 'task', editTarget: { kind: t.is_habit ? 'habit' : 'task', id: t.id } });
  }
  async function promoteHabit() {
    const t = task();
    if (!t) return;
    try { await api.tasks.promoteHabit(t.id); showToast(`"${t.title}" is now a habit`, 'success'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function detach() {
    const b = block();
    if (!b) return;
    try { await api.blocks.update(b.id, { parent_block_id: null }); refetchBlocks(); showToast('Removed from Time Block', 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function unlock() {
    const b = block();
    if (!b) return;
    try { await api.blocks.update(b.id, { is_locked: false }); refetchBlocks(); showToast('Unlocked', 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function removeFromDay() {
    const b = block();
    if (!b) return;
    try {
      await api.blocks.delete(b.id);
      if (b.task_id) await api.flightPlan.addTask(b.task_id); // re-stage, like the old chip menu
      refetchBlocks();
      refetchFlightPlan();
      showToast(b.task_id ? 'Removed — sent back to the flight-plan' : 'Removed', 'default');
      clearActiveTask();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <Show when={task()}>
      {(t) => (
        <div class="flex items-center gap-3 px-3 py-2 border-b border-border bg-card/60 flex-shrink-0">
          <div style={{ color: dirColor() }} class="flex-shrink-0">
            <ShapeIcon shape={dirShape()} size={16} strokeWidth={1.75} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold truncate" style={{ color: dirColor() }} title={t().title}>{t().title}</div>
            <Show when={secondary().length > 0}>
              <div class="flex flex-wrap gap-1 mt-0.5">
                <For each={secondary()}>
                  {(name) => (
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground/80">{name}</span>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="flex items-center gap-1 flex-shrink-0">
            <button onClick={edit} class="btn-icon" title="Edit"><Pencil size={14} /></button>
            <Show when={!t().is_habit}>
              <button onClick={promoteHabit} class="btn-icon" title="Promote to habit"><Repeat size={14} /></button>
            </Show>
            <Show when={block()?.parent_block_id != null}>
              <button onClick={detach} class="btn-icon" title="Remove from Time Block"><Unlink size={14} /></button>
            </Show>
            <Show when={block()?.is_locked}>
              <button onClick={unlock} class="btn-icon" title="Unlock (let auto-scheduling move it again)"><LockOpen size={14} /></button>
            </Show>
            <Show when={block()}>
              <button onClick={removeFromDay} class="btn-icon hover:text-destructive" title="Remove from the day (sends the task back to the flight-plan)"><Trash2 size={14} /></button>
            </Show>
            <button onClick={clearActiveTask} class="btn-icon" title="Close"><X size={14} /></button>
          </div>
        </div>
      )}
    </Show>
  );
}
