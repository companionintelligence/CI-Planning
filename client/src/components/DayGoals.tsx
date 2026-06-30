import { createResource, createSignal, For, Show } from 'solid-js';
import { Check, X } from 'lucide-solid';
import { api, type WeeklyGoal } from '../lib/api.js';
import { isoWeekKey } from '../lib/dates.js';
import { showToast, type ToastAction } from '../stores/index.js';

type Tab = 'today' | 'week';

/**
 * Phase N0 — Goals card in the Today cockpit.
 * One today goal + three stable weekly goal slots. Inline edit, no modal.
 * Category color as a 3px left border (color-styling-rules.md).
 */
export function DayGoals(props: { date: string }) {
  const [tab, setTab] = createSignal<Tab>('today');

  const [data, { refetch }] = createResource(() => props.date, (d) => api.reflections.get(d));

  const weekKey = () => isoWeekKey(props.date);

  // ── Today goal ─────────────────────────────────────────────────────────────
  const [editingToday, setEditingToday] = createSignal(false);
  const [todayDraft, setTodayDraft] = createSignal('');

  function startEditToday() {
    setTodayDraft(data()?.today?.body ?? '');
    setEditingToday(true);
  }

  async function saveToday() {
    try {
      await api.reflections.setToday({ period_key: props.date, body: todayDraft() });
      refetch();
    } catch (err) { showToast((err as Error).message, 'error'); }
    setEditingToday(false);
  }

  async function clearToday() {
    const prev = data()?.today?.body ?? '';
    try {
      await api.reflections.setToday({ period_key: props.date, body: '' });
      refetch();
      const undo: ToastAction = {
        label: 'Undo',
        run: async () => {
          await api.reflections.setToday({ period_key: props.date, body: prev });
          refetch();
        },
      };
      showToast('Goal cleared', 'default', 4000, undo);
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function toggleTodayDone() {
    const current = data()?.today;
    if (!current) return;
    try {
      await api.reflections.setDone('today_goal', 0, props.date, !current.done_at);
      refetch();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Weekly goals ───────────────────────────────────────────────────────────
  const [editingWeekly, setEditingWeekly] = createSignal<number | null>(null);
  const [weeklyDraft, setWeeklyDraft] = createSignal('');

  function weeklyAt(pos: number): WeeklyGoal | undefined {
    return data()?.weekly.find((g) => g.position === pos);
  }

  function startEditWeekly(pos: number) {
    setWeeklyDraft(weeklyAt(pos)?.body ?? '');
    setEditingWeekly(pos);
  }

  async function saveWeekly(pos: 0 | 1 | 2) {
    try {
      await api.reflections.setWeekly(pos, { period_key: weekKey(), body: weeklyDraft() });
      refetch();
    } catch (err) { showToast((err as Error).message, 'error'); }
    setEditingWeekly(null);
  }

  async function clearWeekly(pos: 0 | 1 | 2) {
    const prev = weeklyAt(pos)?.body ?? '';
    try {
      await api.reflections.setWeekly(pos, { period_key: weekKey(), body: '' });
      refetch();
      const undo: ToastAction = {
        label: 'Undo',
        run: async () => {
          await api.reflections.setWeekly(pos, { period_key: weekKey(), body: prev });
          refetch();
        },
      };
      showToast('Intention cleared', 'default', 4000, undo);
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function colorBorder(colorToken: string | null | undefined): string {
    if (!colorToken) return 'var(--border)';
    return `var(--${colorToken})`;
  }

  return (
    <div class="rounded-xl border border-border bg-card p-4">
      {/* Header + tab toggle */}
      <div class="flex items-center justify-between mb-3">
        <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Goals</div>
        <div class="flex rounded-md border border-border overflow-hidden text-[11px]">
          <button
            class={`px-2.5 py-1 ${tab() === 'today' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setTab('today')}
          >
            Today
          </button>
          <button
            class={`px-2.5 py-1 ${tab() === 'week' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setTab('week')}
          >
            This week
          </button>
        </div>
      </div>

      {/* Today tab */}
      <Show when={tab() === 'today'}>
        <Show
          when={data()?.today}
          fallback={
            <Show when={!editingToday()}>
              <button
                class="w-full text-left text-sm text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2 hover:border-primary/50 hover:text-foreground transition-colors"
                onClick={startEditToday}
              >
                + Set today's goal
              </button>
            </Show>
          }
        >
          {(goal) => (
            <Show when={!editingToday()}>
              <div
                class="flex items-start gap-2 rounded-lg px-3 py-2 border border-border"
                style={{ 'border-left': `3px solid ${colorBorder(goal().color_token ?? null)}` }}
              >
                <button
                  title={goal().done_at ? 'Mark undone' : 'Mark done'}
                  class={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${goal().done_at ? 'bg-primary border-primary' : 'border-border hover:border-primary'}`}
                  onClick={toggleTodayDone}
                >
                  <Show when={goal().done_at}><Check size={10} class="text-primary-foreground" /></Show>
                </button>
                <span
                  class={`flex-1 text-sm cursor-pointer ${goal().done_at ? 'line-through text-muted-foreground' : 'text-foreground'}`}
                  onClick={startEditToday}
                >
                  {goal().body}
                </span>
                <button class="btn-icon opacity-50 hover:opacity-100" onClick={clearToday} title="Clear">
                  <X size={13} />
                </button>
              </div>
            </Show>
          )}
        </Show>

        <Show when={editingToday()}>
          <div class="flex flex-col gap-2">
            <input
              autofocus
              class="input text-sm"
              placeholder="What's the one thing you want to accomplish today?"
              value={todayDraft()}
              onInput={(e) => setTodayDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveToday();
                if (e.key === 'Escape') setEditingToday(false);
              }}
            />
            <div class="flex gap-2 justify-end">
              <button class="btn-ghost text-xs px-2 py-1" onClick={() => setEditingToday(false)}>Cancel</button>
              <button class="btn-primary text-xs px-3 py-1" onClick={saveToday}>Save</button>
            </div>
          </div>
        </Show>
      </Show>

      {/* Weekly tab — three stable slots */}
      <Show when={tab() === 'week'}>
        <div class="flex flex-col gap-2">
          <For each={[0, 1, 2] as const}>
            {(pos) => {
              const goal = () => weeklyAt(pos);
              const isEditing = () => editingWeekly() === pos;

              return (
                <Show
                  when={!isEditing()}
                  fallback={
                    <div class="flex flex-col gap-2">
                      <input
                        autofocus
                        class="input text-sm"
                        placeholder="Add a weekly intention…"
                        value={weeklyDraft()}
                        onInput={(e) => setWeeklyDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveWeekly(pos);
                          if (e.key === 'Escape') setEditingWeekly(null);
                        }}
                      />
                      <div class="flex gap-2 justify-end">
                        <button class="btn-ghost text-xs px-2 py-1" onClick={() => setEditingWeekly(null)}>Cancel</button>
                        <button class="btn-primary text-xs px-3 py-1" onClick={() => saveWeekly(pos)}>Save</button>
                      </div>
                    </div>
                  }
                >
                  <Show
                    when={goal()}
                    fallback={
                      <button
                        class="w-full text-left text-sm text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2 hover:border-primary/50 hover:text-foreground transition-colors"
                        onClick={() => startEditWeekly(pos)}
                      >
                        + Add a weekly intention
                      </button>
                    }
                  >
                    {(g) => (
                      <div
                        class="flex items-start gap-2 rounded-lg px-3 py-2 border border-border"
                        style={{ 'border-left': `3px solid ${colorBorder(g().color_token ?? null)}` }}
                      >
                        <span
                          class="flex-1 text-sm cursor-pointer text-foreground"
                          onClick={() => startEditWeekly(pos)}
                        >
                          {g().body}
                        </span>
                        <button class="btn-icon opacity-50 hover:opacity-100" onClick={() => clearWeekly(pos)} title="Clear">
                          <X size={13} />
                        </button>
                      </div>
                    )}
                  </Show>
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
