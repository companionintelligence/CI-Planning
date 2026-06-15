import { createResource, Show, For, createSignal } from 'solid-js';
import { Zap, Sparkles, Clock, TrendingUp, AlertCircle } from 'lucide-solid';
import { tasks, blocks, refetchTasks, refetchBlocks, showToast, setTaskModal } from '../stores/index.js';
import { api } from '../lib/api.js';
import { localISODate } from '../lib/dates.js';
import { TaskCard } from '../components/TaskCard.js';
import { BlockCard } from '../components/BlockCard.js';

export function Today() {
  const [runningSchedule, setRunningSchedule] = createSignal(false);
  const [summary] = createResource(
    () => localISODate(),
    (date) => api.summary.get(date)
  );

  const todayBlocks = () =>
    (blocks() ?? [])
      .filter(b => !['break','buffer'].includes(b.block_kind))
      .sort((a, b) => a.start_at.localeCompare(b.start_at));

  const upcomingBlocks = () => {
    const now = new Date().toISOString();
    return todayBlocks().filter(b => b.end_at > now && b.status === 'planned').slice(0, 3);
  };

  const openTasks = () =>
    (tasks() ?? []).filter(t => t.status === 'open' && !t.parent_id).slice(0, 6);

  function openFocus(taskId: number) {
    const t = (tasks() ?? []).find((x) => x.id === taskId);
    if (t) setTaskModal({ open: true, editTask: t });
    else showToast('Open it from the Tasks list', 'default');
  }

  async function runSchedule() {
    setRunningSchedule(true);
    try {
      await api.schedule.run();
      showToast('Day scheduled', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunningSchedule(false);
    }
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div class="flex-1 overflow-auto p-6 page-enter">
      {/* Header */}
      <div class="flex items-start justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-slate-100">Today</h1>
          <p class="text-slate-500 text-sm mt-0.5">{today}</p>
        </div>
        <button onClick={runSchedule} disabled={runningSchedule()} class="btn-primary">
          <Zap size={14} />
          {runningSchedule() ? 'Scheduling…' : 'Auto-schedule'}
        </button>
      </div>

      {/* AI Summary card */}
      <Show when={summary()}>
        {(s) => (
          <div class="card mb-6 border-accent/20 bg-accent/5">
            <div class="flex items-center gap-2 mb-2">
              <Sparkles size={14} class="text-accent-light" />
              <span class="text-xs font-semibold text-accent-light uppercase tracking-wide">
                {s().llm ? 'AI Briefing' : 'Day Overview'}
              </span>
              <div class="ml-auto flex gap-3 text-xs text-slate-500">
                <Show when={s().stats.overdue > 0}>
                  <span class="text-red-400 flex items-center gap-1">
                    <AlertCircle size={11} /> {s().stats.overdue} overdue
                  </span>
                </Show>
                <span class="flex items-center gap-1">
                  <Clock size={11} /> {s().stats.blocks} blocks
                </span>
                <span class="flex items-center gap-1">
                  <TrendingUp size={11} /> {s().stats.open} open
                </span>
              </div>
            </div>
            <p class="text-sm text-slate-300 leading-relaxed">{s().prose}</p>
            <Show when={s().focus?.length}>
              <div class="flex flex-wrap gap-2 mt-3">
                <For each={s().focus}>
                  {(f) => (
                    <button
                      class="text-xs px-2.5 py-1 rounded-full border border-surface-600 hover:border-accent text-slate-300 transition-colors"
                      title={f.reason}
                      onClick={() => openFocus(f.taskId)}
                    >
                      {f.title} <span class="text-slate-500">· {f.reason}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
        {/* Next up */}
        <section>
          <div class="section-label">Next Up</div>
          <Show when={upcomingBlocks().length > 0} fallback={
            <div class="card text-center text-slate-500 py-8 text-sm">
              No blocks scheduled — hit <strong class="text-slate-300">Auto-schedule</strong>
            </div>
          }>
            <div class="flex flex-col gap-2">
              <For each={upcomingBlocks()}>
                {(b) => <BlockCard block={b} onUpdated={refetchBlocks} />}
              </For>
            </div>
          </Show>
        </section>

        {/* Open tasks */}
        <section>
          <div class="section-label">Open Tasks</div>
          <Show when={openTasks().length > 0} fallback={
            <div class="card text-center text-slate-500 py-8 text-sm">
              All clear — no open tasks
            </div>
          }>
            <div class="flex flex-col gap-2">
              <For each={openTasks()}>
                {(t) => <TaskCard task={t} />}
              </For>
            </div>
          </Show>
        </section>
      </div>
    </div>
  );
}
