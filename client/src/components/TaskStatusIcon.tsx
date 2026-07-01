import { Show } from 'solid-js';
import { CalendarDays } from 'lucide-solid';
import { ShapeIcon } from './ShapeIcon.js';
import { type Task } from '../lib/api.js';
import { tags, patternPrefs, scheduledByTaskId } from '../stores/index.js';
import { directionShapeForTask } from '../lib/pattern-meta.js';
import { shortDate, clockLabel } from '../lib/dates.js';

/**
 * The task's at-a-glance status marker (replaces the old priority dot).
 *  - scheduled (and not a habit) → a calendar icon + the next date/time it's placed
 *  - open tasks + habits         → an empty outline icon in the task's direction shape
 * "Scheduled" is derived from actual placement (a task-block in view) OR a persisted
 * `status='scheduled'`, so it's honest no matter which engine placed the task. Date/time
 * prefer the task's own scheduling-intent fields, falling back to the block placement.
 * Routine membership is shown separately as the card's background texture, not here.
 */
export function TaskStatusIcon(props: { task: Task }) {
  const shape = () => directionShapeForTask(props.task, tags() ?? [], patternPrefs()?.prefs ?? {});
  const placement = () => scheduledByTaskId().get(props.task.id);
  const isScheduled = () => !props.task.is_habit && (props.task.status === 'scheduled' || !!placement());
  const dateLabel = () => {
    const date = shortDate(props.task.scheduled_for) || shortDate(placement()?.date);
    const time = clockLabel(props.task.task_time) || clockLabel(placement()?.time);
    return [date, time].filter(Boolean).join(' ');
  };
  return (
    <Show
      when={isScheduled()}
      fallback={<ShapeIcon shape={shape()} size={13} strokeWidth={1.5} class="text-muted-foreground" />}
    >
      <span class="inline-flex items-center gap-1 text-[11px] text-blue-300 whitespace-nowrap" title={`Scheduled ${dateLabel()}`.trim()}>
        <CalendarDays size={12} class="flex-shrink-0" />
        <Show when={dateLabel()}>{dateLabel()}</Show>
      </span>
    </Show>
  );
}
