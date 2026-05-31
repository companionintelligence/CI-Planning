import { Show, For, createSignal } from 'solid-js';
import { possibles, refetchPossibles, refetchTasks } from '../stores/index.js';
import { api, type Possible } from '../lib/api.js';

const confidenceColor = (c?: number) =>
  !c ? 'text-slate-500' : c >= 0.8 ? 'text-green-400' : c >= 0.5 ? 'text-yellow-400' : 'text-red-400';

function PossibleCard(props: { possible: Possible }) {
  const [loading, setLoading] = createSignal<'promote' | 'dismiss' | null>(null);

  async function promote() {
    setLoading('promote');
    await api.possibles.promote(props.possible.id);
    setLoading(null);
  }

  async function dismiss() {
    setLoading('dismiss');
    await api.possibles.dismiss(props.possible.id);
    setLoading(null);
  }

  return (
    <div class="card flex flex-col gap-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-200">{props.possible.raw_title}</div>
          <Show when={props.possible.raw_summary}>
            <p class="text-xs text-slate-500 mt-1 line-clamp-2">{props.possible.raw_summary}</p>
          </Show>
          <div class="flex gap-3 mt-2 text-xs">
            <Show when={props.possible.source_kind}>
              <span class="badge bg-surface-700 text-slate-400">{props.possible.source_kind}</span>
            </Show>
            <Show when={props.possible.proposed_due_at}>
              <span class="text-slate-500">
                Due {new Date(props.possible.proposed_due_at!).toLocaleDateString()}
              </span>
            </Show>
            <Show when={props.possible.confidence !== undefined}>
              <span class={`font-mono ${confidenceColor(props.possible.confidence)}`}>
                {((props.possible.confidence ?? 0) * 100).toFixed(0)}% confidence
              </span>
            </Show>
          </div>
        </div>
        <div class="flex gap-2 flex-shrink-0">
          <button
            onClick={promote}
            disabled={!!loading()}
            class="btn-primary text-xs"
            title="Promote to task (P)"
          >
            {loading() === 'promote' ? '…' : '+ Task'}
          </button>
          <button
            onClick={dismiss}
            disabled={!!loading()}
            class="btn-ghost text-xs"
            title="Dismiss (D)"
          >
            {loading() === 'dismiss' ? '…' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Inbox() {
  return (
    <div class="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
      <div class="mb-6">
        <h1 class="text-2xl font-semibold text-slate-100">Inbox</h1>
        <p class="text-slate-500 text-sm mt-0.5">AI-proposed tasks waiting for your review</p>
      </div>

      <Show when={(possibles() ?? []).length > 0} fallback={
        <div class="card text-center text-slate-500 py-16">
          <div class="text-3xl mb-3">📭</div>
          <div>Inbox zero — no pending suggestions.</div>
          <p class="text-xs mt-2">Suggestions appear here after the ingestion job runs.</p>
        </div>
      }>
        <div class="flex flex-col gap-2">
          <For each={possibles()}>
            {(p) => <PossibleCard possible={p} />}
          </For>
        </div>
      </Show>
    </div>
  );
}
