import { For, Show, createSignal } from 'solid-js';
import { ChevronDown, ChevronRight, Check, X, Mail } from 'lucide-solid';
import { suggestions, refetchSuggestions, mutateSuggestions, refetchTasks, showToast } from '../stores/index.js';
import { api, type PossibleTask } from '../lib/api.js';

/**
 * The email review queue: ingest-produced suggestions that are deliberately NOT
 * auto-promoted (services/review-gate.ts server-side), because an inbox is other
 * people's agenda and a message that merely mentions a commitment must not silently
 * become a task.
 *
 * Lives at the top of the Tasks tab rather than behind its own nav entry: AF-7 removed
 * the Inbox on purpose, and a destination the owner must remember to visit is exactly
 * what it removed. Approving drops the task into "New Today" directly below, so the
 * result is visible on the same screen.
 *
 * Renders nothing when the queue is empty — invisible at zero cost.
 */
export function SuggestionsSection() {
  const [open, setOpen] = createSignal(true);
  const [busy, setBusy] = createSignal<Set<string>>(new Set());

  const items = () => suggestions() ?? [];

  const setRowBusy = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Optimistically drop the row, then reconcile. On failure put the list back. */
  async function act(id: string, kind: 'approve' | 'dismiss') {
    if (busy().has(id)) return;
    setRowBusy(id, true);
    const before = items();
    mutateSuggestions(before.filter((p) => p.id !== id));
    try {
      if (kind === 'approve') {
        await api.possibles.promote(id);
        refetchTasks(); // the new task lands in "New Today" right below
        showToast('Added to your tasks', 'success');
      } else {
        await api.possibles.dismiss(id);
        showToast('Suggestion dismissed', 'default');
      }
    } catch (err) {
      mutateSuggestions(before); // the row must not vanish on a failed write
      showToast((err as Error).message, 'error');
    } finally {
      setRowBusy(id, false);
      refetchSuggestions();
    }
  }

  return (
    <Show when={items().length > 0}>
      <div class="card mb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          class="flex items-center gap-2 w-full text-left text-sm font-semibold text-foreground"
        >
          <Show when={open()} fallback={<ChevronRight size={15} class="text-muted-foreground" />}>
            <ChevronDown size={15} class="text-muted-foreground" />
          </Show>
          <Mail size={14} class="text-muted-foreground" />
          Suggested from email
          <span class="opacity-60 tabular-nums font-normal">{items().length}</span>
        </button>

        <Show when={open()}>
          <div class="flex flex-col gap-2 mt-3">
            <For each={items()}>{(p) => <SuggestionRow p={p} busy={busy().has(p.id)} onAct={act} />}</For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function SuggestionRow(props: {
  p: PossibleTask;
  busy: boolean;
  onAct: (id: string, kind: 'approve' | 'dismiss') => void;
}) {
  const meta = () => {
    const bits: string[] = [];
    if (props.p.proposed_due_at) bits.push(`due ${new Date(props.p.proposed_due_at).toLocaleDateString()}`);
    if (props.p.proposed_estimated_minutes) bits.push(`${props.p.proposed_estimated_minutes}m`);
    if (props.p.proposed_priority) bits.push(`P${props.p.proposed_priority}`);
    return bits.join(' · ');
  };

  return (
    <div class="flex items-start gap-2 rounded-md border border-border px-3 py-2">
      <div class="flex-1 min-w-0">
        <div class="text-sm text-foreground truncate">{props.p.raw_title}</div>
        <Show when={props.p.raw_summary}>
          <div class="text-[11px] text-muted-foreground line-clamp-2">{props.p.raw_summary}</div>
        </Show>
        <Show when={meta()}>
          <div class="text-[11px] text-muted-foreground mt-0.5">{meta()}</div>
        </Show>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button
          type="button"
          title="Add this as a task"
          disabled={props.busy}
          onClick={() => props.onAct(props.p.id, 'approve')}
          class="btn-primary text-xs px-2 py-1 disabled:opacity-50"
        >
          <Check size={12} /> Add
        </button>
        <button
          type="button"
          title="Dismiss this suggestion"
          disabled={props.busy}
          onClick={() => props.onAct(props.p.id, 'dismiss')}
          class="btn-ghost text-xs px-2 py-1 disabled:opacity-50"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
