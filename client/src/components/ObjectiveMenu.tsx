import { createSignal, createResource, Show, For } from 'solid-js';
import { Check, Plus } from 'lucide-solid';
import { type Task, api } from '../lib/api.js';
import { refetchTasks, showToast } from '../stores/index.js';
import { buildLinkablePickerRows, linkableObjectives, PICKER_SEARCH_THRESHOLD } from '../lib/objective-picker.js';
import { isPromotableToObjective } from '../lib/objective-promote.js';

export function ObjectiveMenu(props: { task: Task; close: () => void }) {
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
  const objectiveCount = () => linkableObjectives(objectivesTree() ?? []).length;
  // AF-10: checked-state comes from the FULL linked set (M:N), not just the first
  // link. objective_id fallback covers payloads from before objective_ids shipped.
  const linkedIds = () =>
    props.task.objective_ids ?? (props.task.objective_id ? [props.task.objective_id] : []);
  const rows = () => buildLinkablePickerRows(objectivesTree() ?? [], query(), linkedIds());
  const canPromote = () => isPromotableToObjective(props.task);

  async function link(id: string, title: string) {
    try {
      await api.objectives.linkTask(id, props.task.id);
      showToast(`Linked to "${title}"`, 'success');
      refetchTasks(); // SSE also broadcasts; explicit refetch keeps the star snappy
    } catch (err) {
      // Defensive: any server validation failure.
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
        <Show when={objectiveCount() > PICKER_SEARCH_THRESHOLD}>
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
          <Show when={objectiveCount() === 0 && !loadFailed()}>
            {/* Only a dead end when the footer row below is hidden — otherwise the
                way out is right there, so don't send the owner to another tab. */}
            <p class="px-3 py-1.5 text-xs text-muted-foreground">
              No objectives yet{canPromote() ? '.' : ' — create one on the Objectives tab.'}
            </p>
          </Show>
          <Show when={objectiveCount() > 0 && rows().length === 0}>
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

