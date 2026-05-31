import { type Task, api } from '../lib/api.js';
import { refetchTasks } from '../stores/index.js';

const priorityClass = ['', 'p1', 'p2', 'p3', 'p4', 'p5'] as const;
const statusColors: Record<string, string> = {
  open: 'text-slate-300',
  done: 'text-slate-500 line-through',
  scheduled: 'text-blue-300',
  cancelled: 'text-slate-600 line-through',
  deferred: 'text-yellow-500',
};

interface Props {
  task: Task;
  onUpdated?: () => void;
}

export function TaskCard(props: Props) {
  const p = () => Math.min(Math.max(props.task.priority, 1), 5);

  async function toggleDone() {
    if (props.task.status === 'done') {
      await api.tasks.update(props.task.id, { status: 'open', completed_at: undefined } as any);
    } else {
      await api.tasks.update(props.task.id, { completed: true });
    }
    props.onUpdated?.();
  }

  async function cancel() {
    await api.tasks.delete(props.task.id);
    props.onUpdated?.();
  }

  const dueLabel = () => {
    if (!props.task.due_at) return null;
    const d = new Date(props.task.due_at);
    const today = new Date();
    const isOverdue = d < today && props.task.status !== 'done';
    return (
      <span class={`font-mono text-xs ${isOverdue ? 'text-red-400' : 'text-slate-500'}`}>
        {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    );
  };

  return (
    <div class={`card flex gap-3 group ${props.task.status === 'done' ? 'opacity-50' : ''}`}>
      <button
        onClick={toggleDone}
        class={`mt-0.5 w-4 h-4 rounded border-2 flex-shrink-0 transition-colors
                ${props.task.status === 'done' ? 'bg-accent-600 border-accent-600' : 'border-surface-600 hover:border-accent-500'}`}
        title="Toggle done"
      />

      <div class="flex-1 min-w-0">
        <div class="flex items-start gap-2">
          <span class={`priority-dot mt-1.5 ${priorityClass[p()]}`} title={`Priority ${p()}`} />
          <span class={`flex-1 text-sm ${statusColors[props.task.status] ?? 'text-slate-300'}`}>
            {props.task.title}
          </span>
          {dueLabel()}
        </div>

        {props.task.description && (
          <p class="text-xs text-slate-500 mt-1 ml-4 line-clamp-2">{props.task.description}</p>
        )}

        {props.task.tags.length > 0 && (
          <div class="flex flex-wrap gap-1 mt-2 ml-4">
            {props.task.tags.map((t) => (
              <span class="badge bg-surface-700 text-slate-400">#{t}</span>
            ))}
          </div>
        )}
      </div>

      <div class="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
        {props.task.estimated_minutes && (
          <span class="text-xs text-slate-500 self-center font-mono">{props.task.estimated_minutes}m</span>
        )}
        <button onClick={cancel} class="btn-danger text-xs py-0.5 px-1.5" title="Cancel">×</button>
      </div>
    </div>
  );
}
