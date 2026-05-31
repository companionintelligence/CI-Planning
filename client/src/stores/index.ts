import { createSignal, createResource } from 'solid-js';
import { api, type Task, type Block, type Possible, type Tag, type Prefs } from '../lib/api.js';
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

on('possible:promoted', () => { refetchPossibles(); refetchTasks(); });
on('possible:dismissed', () => refetchPossibles());

// ── Tags ─────────────────────────────────────────────────────────────────────
export const [tags, { refetch: refetchTags }] = createResource(() =>
  api.tags.list().then((r) => r.tags)
);

// ── Prefs ────────────────────────────────────────────────────────────────────
export const [prefs, { refetch: refetchPrefs }] = createResource(() =>
  api.prefs.get().then((r) => r.prefs)
);

// ── Jobs ─────────────────────────────────────────────────────────────────────
export const [jobs, { refetch: refetchJobs }] = createResource(() =>
  api.jobs.list().then((r) => r.jobs)
);

on('job:run', () => refetchJobs());
