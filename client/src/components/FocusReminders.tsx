import { createSignal, For, Show } from 'solid-js';
import { Bell, Plus, Trash2 } from 'lucide-solid';
import { api } from '../lib/api.js';
import { reminders, refetchReminders, tasks, taskOf, blocks, showToast } from '../stores/index.js';
import { localISODate } from '../lib/dates.js';

/**
 * FocusReminders (#388) — the Focus view's reminders card: the first UI ever to
 * reach GET/POST/DELETE /api/reminders (until now reminders only existed as a
 * fire-time toast with a Snooze action; there was nowhere to see what's coming
 * or manage it). Owner placement ruling 2026-07-19: Focus, not Today.
 *
 * Resting state is a single "Add reminder" pill — with zero reminders there is
 * deliberately NO empty-state card chrome. Create targets a TASK only (the
 * server requires taskId XOR blockId; block reminders keep arriving via the
 * auto engine) and sends `{ taskId, date, time }` so the SERVER resolves the
 * owner's timezone (`zonedWallTimeToUTC`) — never a client-composed naive
 * `${date}T${time}Z` instant. Date is fixed to today: Focus is the today-only
 * surface.
 *
 * Deleting an `auto` reminder is allowed but the engine may re-derive it on the
 * next task edit (`syncTaskReminders`) — the badge's tooltip says so.
 */

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** The create form's default: the NEXT quarter hour (always in the future). */
function nextQuarterHHMM(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + (15 - (d.getMinutes() % 15)));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function FocusReminders() {
  const [adding, setAdding] = createSignal(false);
  const [taskId, setTaskId] = createSignal('');
  const [time, setTime] = createSignal(nextQuarterHHMM());
  const [busy, setBusy] = createSignal(false);

  const rows = () => reminders() ?? [];
  /** Actionable targets — TODAY's tasks only (backlog-3, 2026-07-21): a reminder's date
   *  is hard-fixed to today (Focus is the today-only surface), so offering the whole
   *  open backlog was noise. "Today's" = scheduled for today OR holding a block today
   *  (the shared blocks resource is pinned to today on this view). Still open-ish —
   *  the server rejects another owner's id anyway. */
  const candidates = () => {
    const today = localISODate();
    const blockedToday = new Set(
      (blocks() ?? []).filter((b) => b.task_id && !['completed', 'skipped', 'cancelled'].includes(b.status)).map((b) => b.task_id),
    );
    return (tasks() ?? []).filter(
      (t) =>
        ['open', 'scheduled', 'in_progress'].includes(t.status ?? '') &&
        (t.scheduled_for === today || blockedToday.has(t.id)),
    );
  };

  const titleOf = (r: { task_id: string | null; block_id: string | null }) => {
    if (r.task_id) return taskOf(r.task_id)?.title ?? 'Reminder';
    if (r.block_id) return (blocks() ?? []).find((b) => b.id === r.block_id)?.title ?? 'Reminder';
    return 'Reminder';
  };

  const create = async () => {
    if (!taskId() || !time() || busy()) return;
    setBusy(true);
    try {
      await api.reminders.create({ taskId: taskId(), date: localISODate(), time: time() });
      setAdding(false);
      setTaskId('');
      setTime(nextQuarterHHMM());
      refetchReminders();
    } catch (err) {
      showToast((err as Error).message, 'error'); // the server's 422 copy, verbatim
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.reminders.remove(id);
    } catch (err) {
      // A 404 means it's already gone (fired+pruned, another device) — refetch quietly.
      if (!/not found/i.test((err as Error).message)) showToast((err as Error).message, 'error');
    }
    refetchReminders();
  };

  return (
    <div class="mb-5">
      <Show when={rows().length > 0}>
        <div class="rounded-2xl border border-border/60 p-4 mb-2">
          <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <Bell size={11} /> Reminders
          </div>
          <div class="flex flex-col gap-1.5">
            <For each={rows()}>
              {(r) => (
                <div
                  class="flex items-center gap-3 px-3 py-2 rounded-xl border border-border/60 text-sm"
                  classList={{ 'opacity-50': r.status === 'fired' }}
                >
                  <span class="font-mono text-xs text-muted-foreground flex-shrink-0 tabular-nums">{fmtTime(r.fire_at)}</span>
                  <span class="flex-1 truncate text-foreground">{titleOf(r)}</span>
                  <Show when={r.status === 'fired'}>
                    <span class="text-[10px] text-muted-foreground">fired</span>
                  </Show>
                  <Show when={r.source === 'auto'}>
                    <span
                      class="text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground"
                      title="Auto reminder — may be re-created when the task changes"
                    >
                      auto
                    </span>
                  </Show>
                  <button type="button" class="btn-icon flex-shrink-0" title="Delete reminder" onClick={() => void remove(r.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            class="flex items-center gap-1 h-7 px-2.5 rounded-lg bg-muted/40 text-muted-foreground text-[11px] font-semibold hover:text-foreground transition-colors"
            onClick={() => { setTime(nextQuarterHHMM()); setAdding(true); }}
          >
            <Plus size={12} /> Add reminder
          </button>
        }
      >
        {/* Backlog-3 restyle: a proper labeled card (was a bare unlabeled inline row). */}
        <div class="rounded-2xl border border-border/60 bg-card p-4 flex flex-col gap-3 max-w-sm">
          <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground flex items-center gap-1.5">
            <Bell size={11} /> New reminder — today
          </div>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase tracking-wider text-muted-foreground">Task (today's)</span>
            <select class="input text-sm w-full" value={taskId()} onChange={(e) => setTaskId(e.currentTarget.value)}>
              <option value="">Pick one of today's tasks…</option>
              <For each={candidates()}>{(t) => <option value={t.id}>{t.title}</option>}</For>
            </select>
            <Show when={candidates().length === 0}>
              <span class="text-[11px] text-muted-foreground">Nothing on today's plate yet — schedule a task first.</span>
            </Show>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase tracking-wider text-muted-foreground">Time</span>
            <input
              type="time" step={900} class="input text-sm w-full"
              value={time()} onInput={(e) => setTime(e.currentTarget.value)}
            />
          </label>
          <div class="flex gap-2">
            <button type="button" class="btn-primary text-xs" disabled={!taskId() || busy()} onClick={() => void create()}>
              Remind me
            </button>
            <button type="button" class="btn-ghost text-xs" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
