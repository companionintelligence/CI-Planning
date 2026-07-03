import { createSignal, Show } from 'solid-js';
import { Plus, Sparkles } from 'lucide-solid';
import { api } from '../lib/api.js';
import { refetchTasks, showToast } from '../stores/index.js';

/** One-line natural-language task entry. Enter parses + creates via /tasks/quick.
 * `onAdded` fires after a successful add so the host view can refresh its own
 * resources (the tasks store is already refetched here). */
export function QuickAdd(props: { onAdded?: () => void } = {}) {
  const [text, setText] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [aiLast, setAiLast] = createSignal(false);

  async function add() {
    const v = text().trim();
    if (!v || busy()) return;
    setBusy(true);
    try {
      const res = await api.tasks.quick(v);
      setAiLast(res.llm);
      setText('');
      refetchTasks();
      props.onAdded?.();
      showToast('Task added', 'success');
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="relative">
      <Plus size={15} class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <input
        class="input-lg pl-9"
        placeholder="Add a task… e.g. 'pay invoice fri 3pm #finance ~20m'"
        value={text()}
        disabled={busy()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      <Show when={aiLast()}>
        <span
          class="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 text-[10px] text-accent-light"
          title="Last add used AI enrichment"
        >
          <Sparkles size={11} /> AI
        </span>
      </Show>
    </div>
  );
}
