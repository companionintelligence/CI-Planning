import { createResource, For, Show } from 'solid-js';
import { RefreshCw } from 'lucide-solid';
import { api } from '../lib/api.js';

function dueLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : `Due ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

/** A list-only view. Shared task details and actions stay private to their owner. */
export function SharedTasksPanel() {
  const [shared, { refetch }] = createResource(async () => (await api.sharedTasks.list()).tasks);

  return (
    <section class="flex flex-col gap-3" aria-labelledby="shared-tasks-heading">
      <div>
        <h2 id="shared-tasks-heading" class="text-sm font-semibold text-foreground">Shared with you</h2>
        <p class="text-xs text-muted-foreground mt-1">
          This read-only list shows tasks you help with or benefit from.
        </p>
      </div>

      <Show when={shared.loading}>
        <div class="card text-sm text-muted-foreground" role="status">Loading shared tasks…</div>
      </Show>

      <Show when={shared.error}>
        <div class="card flex items-center justify-between gap-3 text-sm" role="alert">
          <span class="text-muted-foreground">Shared tasks could not load.</span>
          <button type="button" class="btn-secondary text-xs" onClick={() => refetch()}>
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      </Show>

      <Show when={!shared.loading && !shared.error && (shared() ?? []).length === 0}>
        <div class="card text-center text-sm text-muted-foreground py-10">
          No tasks have been shared with you.
        </div>
      </Show>

      <div class="flex flex-col gap-2">
        <For each={shared()}>
          {(task) => (
            <article class="card flex flex-col gap-2" aria-label={`Shared task: ${task.title}`}>
              <div class="flex items-start justify-between gap-3">
                <h3 class="text-sm font-medium text-foreground min-w-0 break-words">{task.title}</h3>
                <span class="text-[11px] text-muted-foreground shrink-0">
                  {task.priority <= 3 ? `P${task.priority}` : 'Later'}
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <For each={task.shared_as}>
                  {(role) => (
                    <span class="rounded-sm border border-border px-1.5 py-0.5">
                      {role === 'responsible' ? 'Responsible' : 'Beneficiary'}
                    </span>
                  )}
                </For>
                <span class="capitalize">{statusLabel(task.status)}</span>
                <Show when={dueLabel(task.due_at)}>{(label) => <span>{label()}</span>}</Show>
                <Show when={task.estimated_minutes != null}>
                  <span>{task.estimated_minutes} min</span>
                </Show>
              </div>
            </article>
          )}
        </For>
      </div>
    </section>
  );
}
