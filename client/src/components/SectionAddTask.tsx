import { Show, For, createSignal, createResource, createMemo } from 'solid-js';
import { Plus } from 'lucide-solid';
import { api, type Block, type Task } from '../lib/api.js';
import { refetchBlocks, refetchTasks, showToast } from '../stores/index.js';
import { addCandidates, moveHighlight, describeAddOutcome } from '../lib/focus-add.js';

/**
 * Phase 3 — one inline input per expanded Time-Block section: type to search the
 * open backlog, or type something new and press Enter to create it. Either way the
 * task lands INSIDE this container as a member block.
 *
 * Placement is not reimplemented here. `POST /blocks/:id/add-tasks`
 * (`placeTasksInBlock`) already scatters chosen tasks into a container's free gaps
 * using the same gap math the scheduler and the routine path use, skips tasks
 * already inside, and reports what did not fit. Focus calls it exactly as the
 * Time-Block modal does, so the two surfaces cannot drift.
 *
 * Keyboard-complete by design (the phase's acceptance bar): ↓/↑ move the highlight,
 * Enter picks the highlighted match or creates when there is none, Escape clears.
 */
export function SectionAddTask(props: { block: Block; memberTaskIds: ReadonlySet<string> }) {
  const [query, setQuery] = createSignal('');
  const [highlight, setHighlight] = createSignal(0);
  const [busy, setBusy] = createSignal(false);

  // Fetch the open backlog once a search actually begins, then filter reactively —
  // FlightPlan's pattern, so a section's box costs nothing until it is used.
  const searching = () => query().trim().length > 0;
  const [openTasks] = createResource(
    () => (searching() ? 'open' : null),
    () => api.tasks.list({ status: 'open' }).then((r) => r.tasks),
  );

  const matches = createMemo(() => addCandidates(openTasks() ?? [], query(), props.memberTaskIds));

  function reset() {
    setQuery('');
    setHighlight(0);
  }

  async function place(taskId: string, title: string) {
    const r = await api.blocks.addTasks(props.block.id, [taskId]);
    const { message, kind } = describeAddOutcome(title, r);
    refetchBlocks();
    refetchTasks();
    showToast(message, kind);
  }

  /** Pick an existing backlog task. */
  async function pick(t: Task) {
    if (busy()) return;
    setBusy(true);
    try {
      await place(t.id, t.title);
      reset();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Create the typed title, then place it — one gesture, both cases. */
  async function createAndPlace() {
    const title = query().trim();
    if (!title || busy()) return;
    setBusy(true);
    try {
      const { task } = await api.tasks.create({ title });
      await place(task.id, task.title);
      reset();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); reset(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => moveHighlight(h, e.key === 'ArrowDown' ? 1 : -1, matches().length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches();
      // No match under the cursor ⇒ Enter means "create what I typed".
      if (m.length === 0) void createAndPlace();
      else void pick(m[Math.min(highlight(), m.length - 1)]);
    }
  }

  return (
    <div class="relative px-2 pb-2 pl-6">
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-dashed border-border/70 focus-within:border-primary/60 transition-colors">
        <Plus size={13} class="flex-shrink-0 text-muted-foreground" />
        <input
          class="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
          placeholder="Add a task to this block…"
          value={query()}
          disabled={busy()}
          aria-label={`Add a task to ${props.block.title}`}
          onInput={(e) => { setQuery(e.currentTarget.value); setHighlight(0); }}
          onKeyDown={onKeyDown}
        />
      </div>

      <Show when={searching()}>
        <div class="mt-1 rounded-lg border border-border bg-card overflow-hidden">
          <For
            each={matches()}
            fallback={
              <button
                type="button"
                class="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
                disabled={busy()}
                onClick={() => void createAndPlace()}
              >
                <Show when={!openTasks.loading} fallback={<span class="text-muted-foreground">Searching…</span>}>
                  Create <span class="font-medium">“{query().trim()}”</span> and add it here
                </Show>
              </button>
            }
          >
            {(t, i) => (
              <button
                type="button"
                class="w-full text-left px-3 py-2 text-sm transition-colors disabled:opacity-50"
                classList={{ 'bg-muted/60': i() === Math.min(highlight(), matches().length - 1), 'hover:bg-muted/40': true }}
                disabled={busy()}
                onMouseEnter={() => setHighlight(i())}
                onClick={() => void pick(t)}
              >
                {t.title}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
