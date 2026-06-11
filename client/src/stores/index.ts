import { createSignal, createResource } from 'solid-js';
import { api } from '../lib/api.js';
import { on } from '../lib/sse.js';

// ── Tasks ────────────────────────────────────────────────────────────────────
export const [taskFilter, setTaskFilter] = createSignal<Record<string, string>>({});

export const [tasks, { refetch: refetchTasks }] = createResource(taskFilter, (f) =>
  api.tasks.list(f).then((r) => r.tasks)
);

on('task:created', () => refetchTasks());
on('task:updated', () => refetchTasks());

// ── Blocks ───────────────────────────────────────────────────────────────────
function todayRange() {
  const d = new Date().toISOString().slice(0, 10);
  return { from: `${d}T00:00:00.000Z`, to: `${d}T23:59:59.000Z` };
}

export const [blockRange, setBlockRange] = createSignal(todayRange());
export const [blocks, { refetch: refetchBlocks }] = createResource(blockRange, (r) =>
  api.blocks.list(r.from, r.to).then((res) => res.blocks)
);

on('block:created', () => refetchBlocks());
on('block:updated', () => refetchBlocks());
on('block:deleted', () => refetchBlocks());
on('schedule:done',  () => refetchBlocks());

// ── Possibles ────────────────────────────────────────────────────────────────
export const [possibles, { refetch: refetchPossibles }] = createResource(() =>
  api.possibles.list().then((r) => r.possibles)
);

on('possible:promoted',  () => { refetchPossibles(); refetchTasks(); });
on('possible:dismissed', () => refetchPossibles());

// ── Tags ─────────────────────────────────────────────────────────────────────
export const [tags, { refetch: refetchTags }] = createResource(() =>
  api.tags.list().then((r) => r.tags)
);

// ── Prefs ────────────────────────────────────────────────────────────────────
export const [prefs, { refetch: refetchPrefs }] = createResource(() =>
  api.prefs.get().then((r) => r.prefs)
);

// ── Priorities ────────────────────────────────────────────────────────────────
export const [priorities, { refetch: refetchPriorities }] = createResource(() =>
  api.priorities.list().then((r) => r.priorities)
);

// ── Jobs ─────────────────────────────────────────────────────────────────────
export const [jobs, { refetch: refetchJobs }] = createResource(() =>
  api.jobs.list().then((r) => r.jobs)
);

on('job:run', () => refetchJobs());

// ── Toast ─────────────────────────────────────────────────────────────────────
export type ToastKind = 'default' | 'success' | 'error';
export interface Toast { id: number; message: string; kind: ToastKind; }

const [_toasts, setToasts] = createSignal<Toast[]>([]);
export const toasts = _toasts;

let _tid = 0;
export function showToast(message: string, kind: ToastKind = 'default', durationMs = 3000) {
  const id = ++_tid;
  setToasts((prev) => [...prev, { id, message, kind }]);
  setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs);
}

// ── Task form modal ───────────────────────────────────────────────────────────
export const [taskModal, setTaskModal] = createSignal<{
  open: boolean;
  editTask?: import('../lib/api.js').Task;
  parentId?: number;
  defaultDueAt?: string;
  defaultTaskTime?: string;
}>({ open: false });

// ── Habits ───────────────────────────────────────────────────────────────────
export const [habits, { refetch: refetchHabits }] = createResource(() =>
  api.habits.list().then((r) => r.habits)
);

// ── Active Timer Store (Pomodoro/Time Tracker) ────────────────────────────────
export interface ActiveTimer {
  taskId: number;
  taskTitle: string;
  seconds: number;
  isPaused: boolean;
}

const [activeTimer, setActiveTimer] = createSignal<ActiveTimer | null>(null);
export { activeTimer };

let timerInterval: any = null;

export function startTimer(taskId: number, taskTitle: string) {
  if (activeTimer()) {
    stopTimer();
  }

  setActiveTimer({
    taskId,
    taskTitle,
    seconds: 0,
    isPaused: false,
  });

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const t = activeTimer();
    if (t && !t.isPaused) {
      setActiveTimer({ ...t, seconds: t.seconds + 1 });
    }
  }, 1000);
}

export function pauseTimer() {
  const t = activeTimer();
  if (t) {
    setActiveTimer({ ...t, isPaused: true });
  }
}

export function resumeTimer() {
  const t = activeTimer();
  if (t) {
    setActiveTimer({ ...t, isPaused: false });
  }
}

export async function stopTimer() {
  const t = activeTimer();
  if (!t) return;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  const elapsedMins = Math.max(1, Math.round(t.seconds / 60));
  setActiveTimer(null);

  try {
    const existing = tasks()?.find(x => x.id === t.taskId);
    const prevMins = existing?.actual_minutes ?? 0;
    
    await api.tasks.update(t.taskId, {
      actual_minutes: prevMins + elapsedMins,
    });
    showToast(`Tracked ${elapsedMins}m for "${t.taskTitle}"`, 'success');
    refetchTasks();
  } catch (err) {
    showToast((err as Error).message, 'error');
  }
}

export async function scheduleTaskNextGap(taskId: number, title: string, estMinutes: number, dateStr: string) {
  const gapDuration = estMinutes;
  
  // Calculate workday start and end timestamps
  const workdayStartHour = Number(prefs()?.workday_start?.split(':')[0] ?? 9);
  const workdayEndHour = Number(prefs()?.workday_end?.split(':')[0] ?? 18);
  
  const startDay = `${dateStr}T00:00:00.000Z`;
  const endDay = `${dateStr}T23:59:59.000Z`;
  
  const startLimit = new Date(`${dateStr}T${String(workdayStartHour).padStart(2, '0')}:00:00.000Z`).getTime();
  const endLimit = new Date(`${dateStr}T${String(workdayEndHour).padStart(2, '0')}:00:00.000Z`).getTime();
  
  // Get occupied times
  const sortedBlocks = [...(blocks() ?? [])]
    .filter(b => b.start_at >= startDay && b.end_at <= endDay)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
    
  let cursor = Math.max(startLimit, Date.now()); // don't schedule in the past if today
  if (dateStr !== new Date().toISOString().slice(0, 10)) {
    cursor = startLimit; // if scheduling for a future day, start from workday start
  }
  
  const neededMs = gapDuration * 60 * 1000;
  let scheduledStart: number | null = null;
  
  for (const block of sortedBlocks) {
    const bStart = new Date(block.start_at).getTime();
    const bEnd = new Date(block.end_at).getTime();
    
    if (cursor + neededMs <= bStart) {
      scheduledStart = cursor;
      break;
    }
    cursor = Math.max(cursor, bEnd);
  }
  
  if (scheduledStart === null && cursor + neededMs <= endLimit) {
    scheduledStart = cursor;
  }
  
  if (scheduledStart === null) {
    throw new Error('No available workday gaps on this day to schedule this task.');
  }
  
  const startIso = new Date(scheduledStart).toISOString();
  const endIso = new Date(scheduledStart + neededMs).toISOString();
  
  await api.blocks.create({
    task_id: taskId,
    title: title,
    block_kind: 'task',
    start_at: startIso,
    end_at: endIso,
    is_locked: true,
  });
  
  await api.tasks.update(taskId, { status: 'scheduled' });
  refetchBlocks();
  refetchTasks();
}
