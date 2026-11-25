import { createSignal, Show, For } from 'solid-js';
import { Plus } from 'lucide-solid';
import { api } from '../lib/api.js';
import { patterns, patternTypes, refetchPatterns, showToast } from '../stores/index.js';

export function RoutineMenu(props: { taskId: string; close: () => void }) {
  const [routineName, setRoutineName] = createSignal('');
  const [routineNameForm, setRoutineNameForm] = createSignal(false);
  const [creatingRoutine, setCreatingRoutine] = createSignal(false);
  const routineTypeId = () => (patternTypes() ?? []).find((t) => t.name === 'Routine')?.id;
  const routines = () => (patterns() ?? []).filter((p) => p.type_id === routineTypeId());

  async function addToRoutine(routineId: string, name: string) {
    try {
      await api.patterns.addTask(routineId, props.taskId);
      refetchPatterns();
      showToast(`Added to "${name}"`, 'success');
      props.close();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function newRoutineWithTask() {
    const name = routineName().trim();
    if (!name || creatingRoutine()) return;
    setCreatingRoutine(true);
    try {
      await api.patterns.promoteFromTasks([props.taskId], name);
      refetchPatterns();
      showToast(`Added to new routine "${name}"`, 'success');
      props.close();
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setCreatingRoutine(false); }
  }

  return (
                <div class="absolute z-20 bottom-full left-0 mb-1 w-60 rounded-sm border border-border bg-popover shadow-lg max-h-64 overflow-y-auto py-1">
                  <Show when={!routineNameForm()} fallback={
                    <form
                      class="p-2 flex flex-col gap-2"
                      onSubmit={(e) => { e.preventDefault(); void newRoutineWithTask(); }}
                    >
                      <label class="text-xs text-muted-foreground" for={`routine-name-${props.taskId}`}>New routine name</label>
                      <input
                        id={`routine-name-${props.taskId}`}
                        class="input w-full text-sm"
                        placeholder="e.g. Morning routine"
                        value={routineName()}
                        autofocus
                        onInput={(e) => setRoutineName(e.currentTarget.value)}
                      />
                      <div class="flex justify-end gap-1.5">
                        <button type="button" onClick={() => { setRoutineNameForm(false); setRoutineName(''); }} class="btn-ghost text-xs px-2 py-1">Cancel</button>
                        <button type="submit" disabled={!routineName().trim() || creatingRoutine()} class="btn-primary text-xs px-2 py-1 disabled:opacity-50">
                          {creatingRoutine() ? 'Creating…' : 'Create'}
                        </button>
                      </div>
                    </form>
                  }>
                    <For each={routines()}>
                      {(r) => (
                        <button onClick={() => addToRoutine(r.id, r.name)} class="w-full text-left px-3 py-1.5 text-sm hover:bg-sidebar-accent truncate">{r.name}</button>
                      )}
                    </For>
                    <Show when={routines().length === 0}>
                      <p class="px-3 py-1.5 text-xs text-muted-foreground">No routines yet</p>
                    </Show>
                    <button onClick={() => { setRoutineName(''); setRoutineNameForm(true); }} class="w-full text-left px-3 py-1.5 text-sm text-accent-hi hover:bg-sidebar-accent border-t border-border mt-1 flex items-center gap-1"><Plus size={12} /> New routine</button>
                  </Show>
                </div>
  );
}
