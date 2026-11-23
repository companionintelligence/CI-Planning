import { createSignal, For, Show } from 'solid-js';
import { MicButton } from './MicButton.js';
import { ViewportOverlay } from './ViewportOverlay.js';
import { api } from '../lib/api.js';
import { refetchTasks, showToast } from '../stores/index.js';

type Draft = { id: number; title: string; selected: boolean };

export function BulkTaskAdd(props: { onClose: () => void }) {
  const [input, setInput] = createSignal('');
  const [drafts, setDrafts] = createSignal<Draft[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let nextId = 0;

  const splitItems = (value: string) => value
    .split(/\r?\n|;|,\s+|[.!?]\s+(?=[A-Z])/)
    .map((item) => item.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, '').replace(/[.!?]$/, '').trim())
    .filter(Boolean);
  const prepare = () => {
    const items = splitItems(input());
    if (!items.length) { setError('Enter at least one task.'); return; }
    setDrafts((current) => [...current, ...items.map((title) => ({ id: nextId++, title, selected: true }))]);
    setInput('');
    setError('');
  };
  const update = (id: number, patch: Partial<Draft>) => setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
  const save = async (ids: number[]) => {
    if (busy()) return;
    const chosen = drafts().filter((draft) => ids.includes(draft.id));
    if (chosen.some((draft) => !draft.title.trim())) { setError('Give each selected task a title or delete it.'); return; }
    if (!chosen.length) { setError('Select at least one draft.'); return; }
    setBusy(true);
    setError('');
    let created = 0;
    try {
      for (const draft of chosen) {
        await api.tasks.create({ title: draft.title.trim() });
        setDrafts((current) => current.filter((item) => item.id !== draft.id));
        created++;
      }
      refetchTasks();
      showToast(`${created} task${created === 1 ? '' : 's'} created`);
      if (!drafts().length && !input().trim()) props.onClose();
    } catch {
      if (created) refetchTasks();
      setError(`${created} created. The remaining drafts are still here; try again.`);
    } finally { setBusy(false); }
  };

  return <ViewportOverlay class="z-[100] bg-black/70 flex items-center justify-center p-3" role="presentation">
    <div role="dialog" aria-modal="true" aria-label="Add tasks in bulk" class="card w-full max-w-xl max-h-full overflow-y-auto flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3"><h2 class="text-lg font-semibold">Add tasks in bulk</h2><button class="btn-ghost" onClick={props.onClose} disabled={busy()}>Close</button></div>
      <p class="text-sm text-muted-foreground">Type or dictate a list. Use a new line, comma, or sentence for each task. Review them before saving.</p>
      <div class="flex items-start gap-2">
        <textarea class="input min-h-28 flex-1 min-w-0" aria-label="Task list" placeholder={'Buy groceries\nCall Alex\nPlan weekend'} value={input()} onInput={(event) => setInput(event.currentTarget.value)} />
        <MicButton title="Dictate tasks" onTranscript={(text) => setInput((current) => `${current}${current.trim() ? '\n' : ''}${text}`)} onError={setError} disabled={busy()} />
      </div>
      <button class="btn-secondary self-start" onClick={prepare} disabled={busy()}>Create drafts</button>
      <Show when={drafts().length}>
        <div class="flex flex-col gap-2" aria-label="Task drafts">
          <For each={drafts()}>{(draft) => <div class="flex items-center gap-2 min-w-0">
            <input type="checkbox" aria-label={`Select ${draft.title}`} checked={draft.selected} onChange={(event) => update(draft.id, { selected: event.currentTarget.checked })} />
            <input class="input flex-1 min-w-0" aria-label="Draft task title" value={draft.title} onInput={(event) => update(draft.id, { title: event.currentTarget.value })} />
            <button class="btn-ghost" onClick={() => void save([draft.id])} disabled={busy()}>Confirm</button>
            <button class="btn-ghost" onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))} disabled={busy()} aria-label={`Delete ${draft.title}`}>Delete</button>
          </div>}</For>
        </div>
        <button class="btn-primary self-end" onClick={() => void save(drafts().filter((draft) => draft.selected).map((draft) => draft.id))} disabled={busy()}>{busy() ? 'Saving…' : 'Confirm selected tasks'}</button>
      </Show>
      <Show when={error()}><p role="alert" class="text-sm text-destructive">{error()}</p></Show>
    </div>
  </ViewportOverlay>;
}
