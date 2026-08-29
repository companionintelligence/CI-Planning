import { For, Show, createSignal } from 'solid-js';
import { AlertTriangle, X, ChevronDown, ChevronUp } from 'lucide-solid';
import { conflicts, resolveConflict, resolveAllConflicts, type ConflictRecord } from '../stores/conflicts.js';

/**
 * What happened to the edit, in the owner's terms. A rejected op never applied at
 * all, so telling them another device overwrote it would be plainly false — and
 * would send them looking for a change on their phone that was never made there.
 */
function conflictReason(record: ConflictRecord): string {
  return record.kind === 'rejected' ? "couldn't be saved" : 'overwritten by another device';
}

function ConflictRow(props: { record: ConflictRecord }) {
  const fieldList = () => props.record.fields.join(', ');
  return (
    <div class="flex items-center gap-3 py-1.5 border-b border-amber-700/30 last:border-0">
      <span class="flex-1 text-xs text-amber-100 min-w-0 truncate">
        <span class="font-medium">"{props.record.entityTitle}"</span>
        {' '}— {fieldList()} {conflictReason(props.record)}
      </span>
      <button
        type="button"
        class="text-xs font-medium text-amber-300 hover:text-white px-2 py-0.5 rounded border border-amber-600/50 hover:border-amber-400 transition-colors flex-shrink-0"
        onClick={() => { props.record.recover(); resolveConflict(props.record.id); }}
      >
        Keep mine
      </button>
      <button
        type="button"
        class="text-amber-400/60 hover:text-amber-200 transition-colors flex-shrink-0"
        title="Dismiss — server version stays"
        onClick={() => resolveConflict(props.record.id)}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function ConflictBanner() {
  const [expanded, setExpanded] = createSignal(false);

  const count = () => conflicts().length;
  const single = (): ConflictRecord | undefined => conflicts()[0];

  return (
    <Show when={count() > 0}>
      <div class="flex-shrink-0 bg-amber-950/80 border-b border-amber-700/50 px-4 md:px-6 text-sm">
        <Show
          when={count() === 1}
          fallback={
            /* Multiple conflicts — collapsed summary with expand toggle */
            <div>
              <div class="flex items-center gap-2 py-2">
                <AlertTriangle size={14} class="text-amber-400 flex-shrink-0" />
                <span class="flex-1 text-xs text-amber-200">
                  {count()} edits need your attention
                </span>
                <button
                  type="button"
                  class="text-xs text-amber-300 hover:text-white flex items-center gap-1 transition-colors"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded() ? 'Collapse' : 'Review'}
                  {expanded() ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                <button
                  type="button"
                  class="text-xs text-amber-400/60 hover:text-amber-200 ml-2 transition-colors"
                  title="Dismiss all — server versions stay"
                  onClick={resolveAllConflicts}
                >
                  Dismiss all
                </button>
              </div>
              <Show when={expanded()}>
                <div class="pb-1">
                  <For each={conflicts()}>
                    {(record) => <ConflictRow record={record} />}
                  </For>
                </div>
              </Show>
            </div>
          }
        >
          {/* Single conflict — always fully visible */}
          <div class="flex items-center gap-2 py-2">
            <AlertTriangle size={14} class="text-amber-400 flex-shrink-0" />
            <span class="flex-1 text-xs text-amber-200 min-w-0 truncate">
              <span class="font-medium">"{single()!.entityTitle}"</span>
              {' '}— {single()!.fields.join(', ')} {conflictReason(single()!)}
            </span>
            <button
              type="button"
              class="text-xs font-medium text-amber-300 hover:text-white px-2 py-0.5 rounded border border-amber-600/50 hover:border-amber-400 transition-colors flex-shrink-0"
              onClick={() => { single()!.recover(); resolveConflict(single()!.id); }}
            >
              Keep mine
            </button>
            <button
              type="button"
              class="text-amber-400/60 hover:text-amber-200 transition-colors flex-shrink-0 ml-1"
              title="Dismiss — server version stays"
              onClick={() => resolveConflict(single()!.id)}
            >
              <X size={13} />
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
