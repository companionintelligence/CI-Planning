import { createResource, createSignal, createMemo, For, Show } from 'solid-js';
import { Check, X, Link as LinkIcon, Target, Cpu, RefreshCw, Circle, Moon } from 'lucide-solid';
import { api, type WeeklyGoal, type ReflectionWrite, type DaySummary, type TopTask } from '../lib/api.js';
import { isoWeekKey } from '../lib/dates.js';
import { flattenObjectives, matchObjectives, type FlatObjective } from '../lib/objectives.js';
import { showToast, setElementModal, refetchTasks, type ToastAction } from '../stores/index.js';

type Tab = 'today' | 'week';

/**
 * Phase O · O0 (Phase AC — collapsed to a header button): the Focus menu, a
 * bullseye-triggered popover in the Today header. One today focus + three weekly
 * focuses, each a typeahead that can LINK to existing work (a task for today, any
 * objective for the week) while still accepting freeform text (source_kind='manual').
 * The "Today's Brief" pop-up (`TodaysBrief`, exported) is now a sibling header button.
 * Category color as a 3px left border (color-styling-rules.md).
 */
export function FocusMenu(props: { date: string }) {
  const [open, setOpen] = createSignal(false);
  const [tab, setTab] = createSignal<Tab>('today');

  const [data, { refetch }] = createResource(() => props.date, (d) => api.reflections.get(d));

  const weekKey = () => isoWeekKey(props.date);

  // ── Today's tasks (for the "1 for today" typeahead) — the day's plannable tasks,
  // the same non-habit/non-routine set the Brief shows.
  const [todayTasks] = createResource(() => props.date, (d) => api.summary.topTasks(d).then((r) => r.tasks).catch(() => [] as TopTask[]));

  // ── Objective tree (for the "3 for the week" typeahead) ──────────────────────
  const [objectives] = createResource(() => api.objectives.list().then((r) => r.objectives).catch(() => []));
  const flatObjectives = createMemo<FlatObjective[]>(() => flattenObjectives(objectives() ?? []));

  // ── Today focus ──────────────────────────────────────────────────────────────
  const [editingToday, setEditingToday] = createSignal(false);
  const [todayDraft, setTodayDraft] = createSignal('');
  const [todayLink, setTodayLink] = createSignal<{ kind: 'task'; ref: string } | null>(null);

  function startEditToday() {
    const t = data()?.today;
    setTodayDraft(t?.body ?? '');
    setTodayLink(t?.source_kind === 'task' && t.source_ref ? { kind: 'task', ref: t.source_ref } : null);
    setEditingToday(true);
  }

  async function saveToday() {
    const link = todayLink();
    const write: ReflectionWrite & { period_key: string } = {
      period_key: props.date,
      body: todayDraft(),
      source_kind: link ? 'task' : 'manual',
      source_ref: link ? link.ref : null,
    };
    try {
      await api.reflections.setToday(write);
      refetch();
    } catch (err) { showToast((err as Error).message, 'error'); }
    setEditingToday(false);
  }

  async function clearToday() {
    const prev = data()?.today;
    try {
      await api.reflections.setToday({ period_key: props.date, body: '' });
      refetch();
      const undo: ToastAction = {
        label: 'Undo',
        run: async () => {
          await api.reflections.setToday({
            period_key: props.date,
            body: prev?.body ?? '',
            source_kind: prev?.source_kind ?? 'manual',
            source_ref: prev?.source_ref ?? null,
          });
          refetch();
        },
      };
      showToast('Focus cleared', 'default', 4000, undo);
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

  // ── Weekly focuses ───────────────────────────────────────────────────────────
  const [editingWeekly, setEditingWeekly] = createSignal<number | null>(null);
  const [weeklyDraft, setWeeklyDraft] = createSignal('');
  const [weeklyLink, setWeeklyLink] = createSignal<{ kind: 'objective'; ref: string } | null>(null);

  function weeklyAt(pos: number): WeeklyGoal | undefined {
    return data()?.weekly.find((g) => g.position === pos);
  }

  function startEditWeekly(pos: number) {
    const g = weeklyAt(pos);
    setWeeklyDraft(g?.body ?? '');
    setWeeklyLink(g?.source_kind === 'objective' && g.source_ref ? { kind: 'objective', ref: g.source_ref } : null);
    setEditingWeekly(pos);
  }

  async function saveWeekly(pos: 0 | 1 | 2) {
    const link = weeklyLink();
    try {
      await api.reflections.setWeekly(pos, {
        period_key: weekKey(),
        body: weeklyDraft(),
        source_kind: link ? 'objective' : 'manual',
        source_ref: link ? link.ref : null,
      });
      refetch();
    } catch (err) { showToast((err as Error).message, 'error'); }
    setEditingWeekly(null);
  }

  async function clearWeekly(pos: 0 | 1 | 2) {
    const prev = weeklyAt(pos);
    try {
      await api.reflections.setWeekly(pos, { period_key: weekKey(), body: '' });
      refetch();
      const undo: ToastAction = {
        label: 'Undo',
        run: async () => {
          await api.reflections.setWeekly(pos, {
            period_key: weekKey(),
            body: prev?.body ?? '',
            source_kind: prev?.source_kind ?? 'manual',
            source_ref: prev?.source_ref ?? null,
          });
          refetch();
        },
      };
      showToast('Focus cleared', 'default', 4000, undo);
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function toggleWeeklyDone(pos: 0 | 1 | 2) {
    const current = weeklyAt(pos);
    if (!current) return;
    try {
      await api.reflections.setDone('weekly_goal', pos, weekKey(), !current.done_at);
      refetch();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function colorBorder(colorToken: string | null | undefined): string {
    if (!colorToken) return 'var(--border)';
    return `var(--${colorToken})`;
  }

  const hasFocus = () => !!data()?.today || (data()?.weekly?.length ?? 0) > 0;

  return (
    <div class="relative">
      {/* Bullseye trigger — accent-tinted when a focus is set. */}
      <button
        class="btn-icon"
        classList={{ 'text-primary': hasFocus(), 'text-muted-foreground': !hasFocus() }}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open()}
        title="Focus — today & this week"
      >
        <Target size={16} />
      </button>
      <Show when={open()}>
        {/* click-away backdrop */}
        <div class="fixed inset-0 z-20" onClick={() => setOpen(false)} />
        <div class="absolute right-0 mt-1 z-30 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 shadow-lg">
          {/* FOCUS label · [ Today | This week ] toggle */}
          <div class="flex items-center justify-between mb-3">
            <div class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Focus</div>
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

          {/* Today tab — the single today focus (typeahead over today's tasks) */}
      <Show when={tab() === 'today'}>
        <Show
          when={data()?.today}
          fallback={
            <Show when={!editingToday()}>
              <button
                class="w-full text-left text-sm text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2 hover:border-primary/50 hover:text-foreground transition-colors"
                onClick={startEditToday}
              >
                + Set today's focus
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
                <Show when={goal().source_kind === 'task'}>
                  <span class="mt-0.5 flex-shrink-0 text-primary" title="Linked to a task"><LinkIcon size={12} /></span>
                </Show>
                <button class="btn-icon opacity-50 hover:opacity-100" onClick={clearToday} title="Clear">
                  <X size={13} />
                </button>
              </div>
            </Show>
          )}
        </Show>

        <Show when={editingToday()}>
          <Typeahead
            placeholder="What's the one thing you want to accomplish today?"
            value={todayDraft()}
            onInput={(v) => { setTodayDraft(v); setTodayLink(null); }}
            options={(todayTasks() ?? [])
              .filter((t) => !t.done)
              .filter((t) => !todayDraft().trim() || t.title.toLowerCase().includes(todayDraft().trim().toLowerCase()))
              .map((t) => ({ id: t.id, label: t.title }))}
            query={todayDraft()}
            onPick={(opt) => { setTodayDraft(opt.label); setTodayLink({ kind: 'task', ref: opt.id }); }}
            linked={!!todayLink()}
            linkLabel="task"
            onSave={saveToday}
            onCancel={() => setEditingToday(false)}
          />
        </Show>
      </Show>

      {/* Weekly tab — three stable slots (typeahead over the objective tree) */}
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
                    <Typeahead
                      placeholder="Add a weekly focus…"
                      value={weeklyDraft()}
                      onInput={(v) => { setWeeklyDraft(v); setWeeklyLink(null); }}
                      options={matchObjectives(flatObjectives(), weeklyDraft()).map((o) => ({ id: o.id, label: o.title, hint: o.path || o.level }))}
                      query={weeklyDraft()}
                      onPick={(opt) => { setWeeklyDraft(opt.label); setWeeklyLink({ kind: 'objective', ref: opt.id }); }}
                      linked={!!weeklyLink()}
                      linkLabel="objective"
                      onSave={() => saveWeekly(pos)}
                      onCancel={() => setEditingWeekly(null)}
                    />
                  }
                >
                  <Show
                    when={goal()}
                    fallback={
                      <button
                        class="w-full text-left text-sm text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2 hover:border-primary/50 hover:text-foreground transition-colors"
                        onClick={() => startEditWeekly(pos)}
                      >
                        + Add a weekly focus
                      </button>
                    }
                  >
                    {(g) => (
                      <div
                        class="flex items-start gap-2 rounded-lg px-3 py-2 border border-border"
                        style={{ 'border-left': `3px solid ${colorBorder(g().color_token ?? null)}` }}
                      >
                        <button
                          title={g().done_at ? 'Mark undone' : 'Mark done'}
                          class={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${g().done_at ? 'bg-primary border-primary' : 'border-border hover:border-primary'}`}
                          onClick={() => toggleWeeklyDone(pos)}
                        >
                          <Show when={g().done_at}><Check size={10} class="text-primary-foreground" /></Show>
                        </button>
                        <span
                          class={`flex-1 text-sm cursor-pointer ${g().done_at ? 'line-through text-muted-foreground' : 'text-foreground'}`}
                          onClick={() => startEditWeekly(pos)}
                        >
                          {g().body}
                        </span>
                        <Show when={g().source_kind === 'objective'}>
                          <span class="mt-0.5 flex-shrink-0 text-primary" title="Linked to an objective"><Target size={12} /></span>
                        </Show>
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
      </Show>
    </div>
  );
}

/**
 * A freeform text input with a filtered dropdown of linkable options. Typing keeps
 * the entry freeform (source stays 'manual'); picking an option links it. Enter
 * saves; Escape cancels.
 */
function Typeahead(props: {
  placeholder: string;
  value: string;
  query: string;
  options: { id: string; label: string; hint?: string }[];
  linked: boolean;
  linkLabel: string;
  onInput: (v: string) => void;
  onPick: (opt: { id: string; label: string }) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [showList, setShowList] = createSignal(true);
  return (
    <div class="flex flex-col gap-2">
      <div class="relative">
        <input
          autofocus
          class="input text-sm w-full"
          placeholder={props.placeholder}
          value={props.value}
          onInput={(e) => { props.onInput(e.currentTarget.value); setShowList(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onSave();
            if (e.key === 'Escape') props.onCancel();
          }}
        />
        <Show when={showList() && props.options.length > 0}>
          <div class="absolute z-20 left-0 right-0 mt-1 max-h-44 overflow-auto rounded-md border border-border bg-popover shadow-lg">
            <For each={props.options.slice(0, 8)}>
              {(opt) => (
                <button
                  class="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-primary/10 flex items-center justify-between gap-2"
                  onClick={() => { props.onPick(opt); setShowList(false); }}
                >
                  <span class="truncate">{opt.label}</span>
                  <Show when={opt.hint}><span class="text-[10px] text-muted-foreground flex-shrink-0">{opt.hint}</span></Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="flex items-center gap-2 justify-between">
        <Show when={props.linked} fallback={<span class="text-[10px] text-muted-foreground">Type freely, or pick to link a {props.linkLabel}</span>}>
          <span class="inline-flex items-center gap-1 text-[10px] text-primary"><LinkIcon size={10} /> Linked to a {props.linkLabel}</span>
        </Show>
        <div class="flex gap-2">
          <button class="btn-ghost text-xs px-2 py-1" onClick={props.onCancel}>Cancel</button>
          <button class="btn-primary text-xs px-3 py-1" onClick={props.onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Today's Brief — a bullseye-sibling popover in the Today header (same idiom as
 * FocusMenu): the parked Morning Briefing (prose + capacity) plus the top-tasks
 * list (non-habit, non-routine, day-ranked). The only surface top tasks appear on.
 * Each row links to the real task; the done-circle completes it.
 */
export function BriefMenu(props: { date: string }) {
  const [open, setOpen] = createSignal(false);
  // Fetch only while the popover is open (matches the old modal's mount-on-open).
  const [summary, { mutate }] = createResource(() => (open() ? props.date : null), (d) => api.summary.get(d));
  const [topTasks, { refetch: refetchTop }] = createResource(() => (open() ? props.date : null), (d) => api.summary.topTasks(d).then((r) => r.tasks));
  const [refreshing, setRefreshing] = createSignal(false);

  const capacity = () => summary()?.capacity;
  const capacityPct = () => {
    const c = capacity();
    if (!c || c.workday_minutes === 0) return 0;
    return Math.min(100, Math.round((c.scheduled_minutes / c.workday_minutes) * 100));
  };
  const capacityLabel = () => {
    const c = capacity();
    if (!c) return '';
    return `${c.scheduled_minutes}m scheduled / ${c.workday_minutes}m workday`;
  };
  const capacityTone = () => {
    const pct = capacityPct();
    if (pct >= 90) return 'text-destructive';
    if (pct >= 70) return 'text-amber-400';
    return 'text-primary';
  };

  async function refresh() {
    setRefreshing(true);
    try {
      const updated = await api.summary.refresh(props.date);
      mutate(updated as DaySummary);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  }

  async function completeTask(t: TopTask) {
    if (t.done) return;
    try {
      await api.tasks.update(t.id, { completed: true });
      refetchTasks();
      refetchTop();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  function openTask(t: TopTask) {
    setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: t.id } });
    setOpen(false);
  }

  return (
    <div class="relative">
      {/* Cpu trigger — same btn-icon idiom as the FocusMenu bullseye. */}
      <button
        class="btn-icon text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open()}
        title="Today's Brief"
      >
        <Cpu size={16} />
      </button>
      <Show when={open()}>
        {/* click-away backdrop */}
        <div class="fixed inset-0 z-20" onClick={() => setOpen(false)} />
        <div class="absolute right-0 mt-1 z-30 w-[24rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover shadow-lg">
          <div class="px-4 py-3 border-b border-border flex items-center justify-between">
            <span class="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Cpu size={14} class="text-primary" /> Today's Brief
              <Show when={summary()?.llm}><span class="text-[10px] text-muted-foreground font-normal ml-0.5">(AI)</span></Show>
            </span>
            <button class="btn-icon opacity-50 hover:opacity-100" onClick={refresh} disabled={refreshing()} title="Regenerate briefing">
              <RefreshCw size={13} classList={{ 'animate-spin': refreshing() }} />
            </button>
          </div>

        <div class="p-4 flex flex-col gap-3 max-h-[70vh] overflow-auto">
          {/* Prose */}
          <Show when={summary()} fallback={<p class="text-sm text-muted-foreground">Loading…</p>}>
            <p class="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">{summary()!.prose}</p>
          </Show>

          {/* Phase Z · Z2 — last night's EOD Alignment folded in (Time-Sense on).
              Present only when the server attaches it; degrades to carry-forward
              alone when the evening modal was never opened (prose null). */}
          <Show when={summary()?.evening && (summary()!.evening!.prose || summary()!.evening!.carry_forward.length)}>
            {(() => {
              const ev = () => summary()!.evening!;
              const openCarry = (taskId: string) => {
                setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: taskId } });
                setOpen(false);
              };
              return (
                <div class="border-t border-border/50 pt-3">
                  <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                    <Moon size={11} /> Last night
                  </div>
                  <Show when={ev().prose}>
                    <p class="text-sm text-muted-foreground leading-relaxed whitespace-pre-line mb-2">{ev().prose}</p>
                  </Show>
                  <Show when={ev().carry_forward.length}>
                    <div class="text-[10px] text-muted-foreground mb-1">Carry forward first</div>
                    <ul class="flex flex-col gap-1.5">
                      <For each={ev().carry_forward}>
                        {(c) => (
                          <li class="flex items-center gap-2 text-sm">
                            <Circle size={8} class="flex-shrink-0 text-amber-400" />
                            <button class="flex-1 text-left truncate hover:underline text-foreground" onClick={() => openCarry(c.task_id)}>
                              {c.title}
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              );
            })()}
          </Show>

          {/* Capacity line */}
          <Show when={capacity() && capacity()!.workday_minutes > 0}>
            <div>
              <div class="flex items-center justify-between mb-1">
                <span class="text-[10px] text-muted-foreground">Capacity</span>
                <span class={`text-[10px] tabular-nums ${capacityTone()}`}>{capacityLabel()}</span>
              </div>
              <div class="relative h-1.5 rounded-full bg-background border border-border overflow-hidden">
                <div
                  class="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
                  classList={{ 'bg-amber-400': capacityPct() >= 70, 'bg-destructive': capacityPct() >= 90 }}
                  style={{ width: `${capacityPct()}%` }}
                />
              </div>
            </div>
          </Show>

          {/* Top tasks — non-habit, non-routine, day-ranked */}
          <div class="border-t border-border/50 pt-3">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Top tasks</div>
            <Show
              when={(topTasks() ?? []).length > 0}
              fallback={<p class="text-sm text-muted-foreground">No tasks planned for today.</p>}
            >
              <ul class="flex flex-col gap-1.5">
                <For each={topTasks()}>
                  {(t) => (
                    <li class="flex items-center gap-2 text-sm">
                      <button
                        title={t.done ? 'Completed' : 'Mark done'}
                        class={`flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${t.done ? 'bg-primary border-primary' : 'border-border hover:border-primary'}`}
                        onClick={() => completeTask(t)}
                      >
                        <Show when={t.done} fallback={<Circle size={8} class="opacity-0" />}><Check size={10} class="text-primary-foreground" /></Show>
                      </button>
                      <button
                        class={`flex-1 text-left truncate hover:underline ${t.done ? 'line-through text-muted-foreground' : 'text-foreground'}`}
                        onClick={() => openTask(t)}
                      >
                        {t.title}
                      </button>
                      <Show when={t.planned}><span class="text-[10px] text-muted-foreground flex-shrink-0">planned</span></Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
        </div>
      </Show>
    </div>
  );
}
