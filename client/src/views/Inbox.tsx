import { Show, For, createSignal, onMount, onCleanup } from 'solid-js';
import { InboxIcon, ThumbsUp, ThumbsDown } from 'lucide-solid';
import { possibles, refetchPossibles, refetchTasks, showToast } from '../stores/index.js';
import { api, type Possible } from '../lib/api.js';

const confColor = (c?: number) =>
  !c ? 'text-ci-1/60' : c >= 0.8 ? 'text-green-400' : c >= 0.5 ? 'text-yellow-400' : 'text-orange-400';

function PossibleCard(props: { possible: Possible; onAction: () => void }) {
  const [loading, setLoading] = createSignal<'promote' | 'dismiss' | null>(null);

  async function promote() {
    setLoading('promote');
    try {
      await api.possibles.promote(props.possible.id);
      showToast('Added to tasks', 'success');
      props.onAction();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally { setLoading(null); }
  }

  async function dismiss() {
    setLoading('dismiss');
    try {
      await api.possibles.dismiss(props.possible.id);
      showToast('Dismissed', 'default');
      props.onAction();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally { setLoading(null); }
  }

  return (
    <div class="card hover:border-surface-600 transition-colors">
      <div class="flex items-start gap-4">
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-ci-1 leading-snug">{props.possible.raw_title}</div>
          <Show when={props.possible.raw_summary}>
            <p class="text-xs text-ci-1/60 mt-1 line-clamp-2">{props.possible.raw_summary}</p>
          </Show>
          <div class="flex flex-wrap gap-2 mt-2 items-center">
            <Show when={props.possible.source_kind}>
              <span class="badge-neutral capitalize">{props.possible.source_kind}</span>
            </Show>
            <Show when={props.possible.proposed_due_at}>
              <span class="text-xs text-ci-1/60">
                Due {new Date(props.possible.proposed_due_at!).toLocaleDateString()}
              </span>
            </Show>
            <Show when={props.possible.proposed_priority}>
              <span class="text-xs text-ci-1/60">P{props.possible.proposed_priority}</span>
            </Show>
            <Show when={props.possible.confidence !== undefined}>
              <span class={`font-mono text-xs ${confColor(props.possible.confidence)}`}>
                {((props.possible.confidence ?? 0) * 100).toFixed(0)}% confident
              </span>
            </Show>
          </div>
        </div>
        <div class="flex gap-2 flex-shrink-0 mt-0.5">
          <button
            onClick={promote}
            disabled={!!loading()}
            class="btn-primary text-xs px-3 py-1.5"
            title="Add as task (P)"
          >
            <ThumbsUp size={12} />
            {loading() === 'promote' ? '…' : 'Add'}
          </button>
          <button
            onClick={dismiss}
            disabled={!!loading()}
            class="btn-ghost text-xs px-2 py-1.5"
            title="Dismiss (D)"
          >
            <ThumbsDown size={12} />
            {loading() === 'dismiss' ? '…' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Inbox() {
  const pending = () => possibles() ?? [];

  // Keyboard shortcuts: P = promote first, D = dismiss first
  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'p' && pending().length > 0) {
      api.possibles.promote(pending()[0].id)
        .then(() => { showToast('Added to tasks', 'success'); refetchPossibles(); refetchTasks(); })
        .catch(err => showToast((err as Error).message, 'error'));
    }
    if (e.key === 'd' && pending().length > 0) {
      api.possibles.dismiss(pending()[0].id)
        .then(() => { showToast('Dismissed', 'default'); refetchPossibles(); })
        .catch(err => showToast((err as Error).message, 'error'));
    }
  }

  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      <div class="flex items-center justify-between mb-5">
        <div>
          <h1 class="text-2xl font-heading font-bold text-ci-1 tracking-wide">Inbox</h1>
          <p class="text-ci-1/60 text-sm mt-0.5">AI-proposed tasks — <kbd class="badge-neutral">P</kbd> promote · <kbd class="badge-neutral">D</kbd> dismiss</p>
        </div>
        <Show when={pending().length > 0}>
          <span class="badge-accent text-sm px-3 py-1">{pending().length} pending</span>
        </Show>
      </div>

      <Show when={pending().length > 0} fallback={
        <div class="card text-center py-16 flex flex-col items-center gap-3 scroll-reveal">
          <InboxIcon size={36} class="text-ci-1/40" />
          <div class="text-ci-1/80 font-medium">Inbox zero</div>
          <p class="text-xs text-ci-1/50 max-w-xs">
            Suggestions appear here after the Gmail/Calendar ingestion jobs run.
          </p>
        </div>
      }>
        <div class="flex flex-col gap-2">
          <For each={pending()}>
            {(p) => (
              <PossibleCard
                possible={p}
                onAction={() => { refetchPossibles(); refetchTasks(); }}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
