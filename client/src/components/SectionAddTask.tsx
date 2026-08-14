import { Show, For, createSignal, createResource, createMemo, onMount } from 'solid-js';
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
/**
 * Which section's box should take focus when it next mounts. A successful add
 * refetches the day, which rebuilds the section's rows — so the input the owner was
 * typing in is a NEW element by the time the toast lands, and focusing the old one
 * would put the caret nowhere. Module-level (not per-instance) precisely because the
 * instance that starts the add is not the instance that finishes it.
 */
const [refocusBlockId, setRefocusBlockId] = createSignal<string | null>(null);

export function SectionAddTask(props: { block: Block; memberTaskIds: ReadonlySet<string> }) {
  const [query, setQuery] = createSignal('');
  const [highlight, setHighlight] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  let inputEl: HTMLInputElement | undefined;

  // Claim focus if this section is the one that just added something — whether this
  // is the same instance (no remount yet) or a fresh one (the usual case).
  //
  // Deliberately does NOT clear the claim: an add fires TWO refetches (blocks and
  // tasks are separate resources), so the section can remount more than once and the
  // LAST instance is the one that must end up focused. An instance that cleared the
  // flag left its successor with nothing to claim — which is why the caret still
  // vanished after the first attempt at this fix. `refocus()`'s timer is the single
  // owner of clearing.
  //
  // The activeElement guard keeps this from stealing focus if the owner has clicked
  // somewhere else in the meantime: we only restore focus that a remount destroyed.
  onMount(() => {
    if (refocusBlockId() !== props.block.id) return;
    const active = document.activeElement;
    if (active === null || active === document.body) inputEl?.focus();
  });

  /**
   * Keep the keyboard flow alive so a second task can be typed straight away.
   *
   * The add refetches the day, which rebuilds `entries()` and therefore remounts this
   * section — but that lands a tick or two later, over the network. So claim focus
   * BOTH ways and let whichever happens win: focus the current element now (correct
   * when nothing remounts), and leave the flag set so a remounting instance can claim
   * it in `onMount`. The flag must NOT be cleared here — doing so was the whole bug:
   * the microtask consumed it against the doomed element, and the fresh input that
   * replaced it a moment later found nothing to claim and never took focus.
   *
   * A short timer drops the claim so a later, unrelated remount cannot steal focus.
   */
  function refocus() {
    setRefocusBlockId(props.block.id);
    queueMicrotask(() => {
      if (refocusBlockId() === props.block.id) inputEl?.focus();
    });
    setTimeout(() => {
      if (refocusBlockId() === props.block.id) setRefocusBlockId(null);
    }, 2000);
  }

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

  /** Pick an existing backlog task — an explicit choice, nothing to disambiguate. */
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
      refocus();
    }
  }

  /**
   * The Enter / "create" path: decide pick-vs-create against a RESOLVED backlog.
   *
   * `matches()` is empty both when nothing matches AND while the backlog resource is
   * still in flight. Reading the second as the first meant a fast typist got a
   * duplicate task instead of the existing one — and typing fast is the normal case
   * for the keyboard-only flow this box exists to serve. So when the resource has not
   * landed yet, wait for a fetch and decide on real data.
   */
  async function submit() {
    const title = query().trim();
    if (!title || busy()) return;
    setBusy(true);
    try {
      const backlog = openTasks.loading || openTasks() === undefined
        ? await api.tasks.list({ status: 'open' }).then((r) => r.tasks)
        : openTasks()!;
      const m = addCandidates(backlog, title, props.memberTaskIds);
      if (m.length === 0) {
        const { task } = await api.tasks.create({ title });
        await place(task.id, task.title);
      } else {
        const chosen = m[Math.min(highlight(), m.length - 1)];
        await place(chosen.id, chosen.title);
      }
      reset();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
      refocus();
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
      void submit();
    }
  }

  return (
    <div class="relative px-2 pb-2 pl-6">
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-dashed border-border/70 focus-within:border-primary/60 transition-colors">
        <Plus size={13} class="flex-shrink-0 text-muted-foreground" />
        <input
          ref={inputEl}
          class="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground read-only:opacity-50"
          placeholder="Add a task to this block…"
          value={query()}
          // readOnly, NOT disabled: disabling a focused element blurs it, and
          // re-enabling does not give focus back — which broke adding several tasks
          // in a row from the keyboard. The in-flight guards in submit()/pick() are
          // what actually prevent a double send.
          readOnly={busy()}
          aria-busy={busy()}
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
                // Also gated on `loading`: while the backlog is in flight this button
                // says "Searching…", and clicking it would have created a duplicate of
                // a task the fetch was about to surface.
                disabled={busy() || openTasks.loading}
                onClick={() => void submit()}
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
