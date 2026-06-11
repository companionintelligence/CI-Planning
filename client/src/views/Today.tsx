import { createResource, Show, For, createSignal } from 'solid-js';
import { Zap, Sparkles, Clock, TrendingUp, AlertCircle, Check, Calendar, X, FileText } from 'lucide-solid';
import { tasks, blocks, refetchTasks, refetchBlocks, showToast, refetchPossibles } from '../stores/index.js';
import { api } from '../lib/api.js';
import { TaskCard } from '../components/TaskCard.js';
import { BlockCard } from '../components/BlockCard.js';

export function Today() {
  const [runningSchedule, setRunningSchedule] = createSignal(false);
  const [notes, setNotes] = createSignal('');
  const [extracting, setExtracting] = createSignal(false);

  const [summary] = createResource(
    () => new Date().toISOString().slice(0, 10),
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

  const endedBlocks = () => {
    const now = new Date().toISOString();
    return (blocks() ?? [])
      .filter(b => b.status === 'planned' && b.end_at < now && !['break','buffer'].includes(b.block_kind))
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
  };

  const openTasks = () =>
    (tasks() ?? []).filter(t => t.status === 'open' && !t.parent_id).slice(0, 6);

  async function runSchedule() {
    setRunningSchedule(true);
    try {
      await api.schedule.run();
      showToast('Day scheduled', 'success');
      refetchBlocks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRunningSchedule(false);
    }
  }

  async function handleExtract() {
    if (!notes().trim()) return;
    setExtracting(true);
    try {
      const res = await api.possibles.extract(notes());
      showToast(res.log || 'Task suggestions extracted successfully!', 'success');
      setNotes('');
      refetchPossibles();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setExtracting(false);
    }
  }

  async function handleAuditComplete(b: any) {
    try {
      if (b.task_id) {
        await api.tasks.update(b.task_id, { completed: true });
      }
      await api.blocks.update(b.id, { status: 'completed' });
      showToast('Task and block completed', 'success');
      refetchBlocks();
      refetchTasks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function handleAuditReschedule(b: any) {
    try {
      if (b.task_id) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().slice(0, 10);
        await api.tasks.update(b.task_id, { due_at: tomorrowStr, status: 'open' });
      }
      await api.blocks.update(b.id, { status: 'skipped' });
      showToast('Task deferred to tomorrow', 'success');
      refetchBlocks();
      refetchTasks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function handleAuditDismiss(b: any) {
    try {
      await api.blocks.update(b.id, { status: 'skipped' });
      showToast('Block skipped', 'default');
      refetchBlocks();
      refetchTasks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div class="flex-1 overflow-auto p-6 page-enter">
      {/* Header */}
      <div class="flex items-start justify-between mb-6">
        <div>
          <h1 class="text-2xl font-heading font-bold text-ci-1 tracking-wide">Today</h1>
          <p class="text-ci-1/60 text-sm mt-0.5">{today}</p>
        </div>
        <button onClick={runSchedule} disabled={runningSchedule()} class="btn-primary">
          <Zap size={14} />
          {runningSchedule() ? 'Scheduling…' : 'Auto-schedule'}
        </button>
      </div>

      {/* AI Summary card */}
      <Show when={summary()}>
        {(s) => (
          <div class="card mb-6 border-accent/20 bg-accent/5 scroll-reveal">
            <div class="flex items-center gap-2 mb-2">
              <Sparkles size={14} class="text-accent-light" />
              <span class="text-xs font-semibold text-accent-light uppercase tracking-wide">
                {s().llm ? 'AI Briefing' : 'Day Overview'}
              </span>
              <div class="ml-auto flex gap-3 text-xs text-ci-1/60">
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
            <p class="text-sm text-ci-1 leading-relaxed">{s().prose}</p>
          </div>
        )}
      </Show>

      {/* Schedule Auditing Card */}
      <Show when={endedBlocks().length > 0}>
        <div class="card mb-6 border-red-500/20 bg-red-500/5 scroll-reveal text-left">
          <div class="flex items-center gap-2 mb-3">
            <AlertCircle size={14} class="text-red-400" />
            <span class="text-xs font-semibold text-red-400 uppercase tracking-wide">
              Schedule Audit: Recently Ended Blocks
            </span>
          </div>
          <div class="flex flex-col gap-2">
            <For each={endedBlocks()}>
              {(b) => {
                const timeStr = () => {
                  const s = new Date(b.start_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                  const e = new Date(b.end_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                  return `${s} - ${e}`;
                };
                return (
                  <div class="flex flex-col sm:flex-row sm:items-center justify-between p-3 gap-2 rounded-xl bg-surface-900 border border-surface-700/50">
                    <div class="min-w-0">
                      <div class="text-[10px] text-ci-1/50 font-mono mb-0.5">{timeStr()}</div>
                      <div class="text-xs font-semibold text-ci-1 truncate">{b.title}</div>
                    </div>
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <button
                        onClick={() => handleAuditComplete(b)}
                        class="btn text-xs bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20 px-2 py-0.5"
                      >
                        <Check size={12} />
                        <span>Complete</span>
                      </button>
                      <Show when={b.task_id}>
                        <button
                          onClick={() => handleAuditReschedule(b)}
                          class="btn text-xs bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/20 px-2 py-0.5"
                        >
                          <Calendar size={12} />
                          <span>Defer</span>
                        </button>
                      </Show>
                      <button
                        onClick={() => handleAuditDismiss(b)}
                        class="btn text-xs bg-surface-700 text-ci-1 border border-surface-600 hover:bg-surface-600 px-2 py-0.5"
                      >
                        <X size={12} />
                        <span>Skip</span>
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>

      {/* Quick Capture Scratchpad */}
      <div class="card mb-6 border-surface-700 hover:border-accent/30 bg-surface-800 scroll-reveal text-left">
        <div class="flex items-center gap-2 mb-3">
          <FileText size={14} class="text-accent-light" />
          <span class="text-xs font-semibold text-accent-light uppercase tracking-wide">
            Quick Capture Notes
          </span>
        </div>
        <textarea
          class="textarea w-full min-h-[90px] text-xs bg-surface-950/45 border-surface-700"
          placeholder="Type or paste meeting minutes, raw emails, or bullet points to extract to-dos... (e.g. 'Need to draft the newsletter today and call David at 3pm')"
          value={notes()}
          onInput={(e) => setNotes(e.currentTarget.value)}
        />
        <div class="flex justify-end mt-2">
          <button
            onClick={handleExtract}
            disabled={!notes().trim() || extracting()}
            class="btn-primary text-xs flex items-center gap-1.5 px-4 py-1.5"
          >
            <Zap size={12} />
            <span>{extracting() ? 'Extracting with AI…' : 'Extract Tasks'}</span>
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
        {/* Next up */}
        <section>
          <div class="section-label">Next Up</div>
          <Show when={upcomingBlocks().length > 0} fallback={
            <div class="card text-center text-ci-1/60 py-8 text-sm scroll-reveal">
              No blocks scheduled — hit <strong class="text-ci-1">Auto-schedule</strong>
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
            <div class="card text-center text-ci-1/60 py-8 text-sm scroll-reveal">
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
