import { Show, For, createMemo, createSignal } from 'solid-js';
import { A } from '@solidjs/router';
import { CheckCircle2, AlertTriangle, CalendarRange, Target, Check, TrendingUp, Pentagon, ArrowUpRight, ChevronDown } from 'lucide-solid';
import { api, type Block, type WeekReview, type MonthReview, type Calibration } from '../lib/api.js';
import { concepts, prefs, refetchBlocks, refetchConcepts, refetchTasks, showToast } from '../stores/index.js';
import { addDays, durationLabel, localISODate, shortDate } from '../lib/dates.js';
import { mergeTagNames, splitBlockTag } from '../lib/element.js';

/**
 * Calendar review panel for the current weekly or rolling 30-day period.
 */
export function CalendarReview(props: {
  data: WeekReview | MonthReview | undefined;
  period: 'week' | 'month';
  calibration?: Calibration | undefined;
}) {
  const d = () => props.data;
  const [promotingId, setPromotingId] = createSignal<string | null>(null);
  const [openTasksExpanded, setOpenTasksExpanded] = createSignal(false);
  const [objectivesExpanded, setObjectivesExpanded] = createSignal(false);
  const weeklyData = () => {
    const data = d();
    return data && 'weekly_goals' in data ? data : undefined;
  };
  const horizonDays = () => Math.max(1, prefs()?.concept_horizon_days ?? 30);
  const reviewSomedayTasks = createMemo(() => {
    const end = addDays(localISODate(), horizonDays());
    return [...(concepts() ?? [])]
      .filter((item) => !item.goal_start_date || item.goal_start_date <= end)
      .sort((a, b) => (a.goal_start_date ?? '9999-12-31').localeCompare(b.goal_start_date ?? '9999-12-31') || a.title.localeCompare(b.title));
  });

  async function promoteSomedayTask(item: Block) {
    if (promotingId()) return;
    setPromotingId(item.id);
    try {
      const { primary, secondary } = splitBlockTag(item.tag);
      const taskTags = mergeTagNames(primary ? [primary] : []);
      const secondaryTags = mergeTagNames(secondary, item.secondary_tags ?? []).filter((name) => name.toLowerCase() !== primary.toLowerCase());
      await api.tasks.create({
        title: item.title,
        notes: item.note ?? undefined,
        estimated_minutes: item.duration_minutes ?? prefs()?.concept_default_minutes ?? 60,
        priority: 3,
        tags: taskTags,
        secondary_tags: secondaryTags,
        categories: item.categories ?? [],
        texture_enabled: item.texture_enabled,
        texture_color_token: item.texture_color_token,
        responsible_ids: item.responsible?.map((person) => person.id),
        beneficiary_ids: item.beneficiaries?.map((person) => person.id),
        auto_place: false,
      });
      try {
        await api.blocks.delete(item.id);
      } catch {
        refetchTasks();
        showToast(`Created “${item.title}” as an open task, but the Someday Task remains in the list.`, 'error');
        return;
      }
      refetchConcepts(); refetchBlocks(); refetchTasks();
      showToast(`“${item.title}” promoted to an open task.`, 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setPromotingId(null);
    }
  }

  const periodDateLabel = () => {
    const data = d();
    if (!data) return '';
    const firstDate = props.period === 'week'
      ? (data as WeekReview).days[0]
      : (data as MonthReview).range_start;
    const lastDate = props.period === 'week'
      ? (data as WeekReview).days[6]
      : (data as MonthReview).range_end;
    const first = new Date(firstDate + 'T12:00:00Z');
    const last = new Date(lastDate + 'T12:00:00Z');
    const crossYear = first.getUTCFullYear() !== last.getUTCFullYear();
    const a = first.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', ...(crossYear ? { year: 'numeric' as const } : {}),
    });
    const b = last.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${a} – ${b}`;
  };

  const completionRate = () => {
    const data = d();
    if (!data) return null;
    const total = data.tasks_completed + data.tasks_overdue;
    if (total === 0) return null;
    return Math.round((data.tasks_completed / total) * 100);
  };

  const goalsCompleted = () => weeklyData()?.weekly_goals.filter((g) => g.done_at != null).length ?? 0;
  const goalsTotal = () => weeklyData()?.weekly_goals.length ?? 0;
  const openDueTasks = () => d()?.open_due_tasks ?? [];
  const objectivesNeedAttention = () => d()?.objectives_need_attention ?? [];

  return (
    <Show when={d()}>
      {(data) => (
        <div class="rounded-xl border border-border bg-card p-4 mb-4">
          {/* Header */}
          <div class="flex items-center justify-between mb-4">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-[0.15em] text-primary mb-0.5">
                {props.period === 'week' ? 'Weekly Review' : 'Monthly Recap'}
              </div>
              <span class="text-xs text-muted-foreground">
                {props.period === 'month' ? 'Last 30 days · ' : ''}{periodDateLabel()}
              </span>
            </div>
            <span class="text-xs text-muted-foreground font-mono">
              {props.period === 'week' ? (data() as WeekReview).week_key : '30 days'}
            </span>
          </div>

          {/* Stats row */}
          <div class="grid grid-cols-3 gap-3 mb-4">
            {/* Completed tasks */}
            <div class="rounded-lg border border-border bg-background/40 p-3 text-center">
              <div class="flex items-center justify-center gap-1 mb-1">
                <CheckCircle2 size={14} class="text-primary" />
                <span class="text-xs text-muted-foreground">Done</span>
              </div>
              <div class="text-xl font-semibold text-foreground">{data().tasks_completed}</div>
              <Show when={completionRate() != null}>
                <div class="text-[10px] text-muted-foreground mt-0.5">{completionRate()}% rate</div>
              </Show>
            </div>

            {/* Overdue */}
            <button
              type="button"
              class="rounded-lg border border-border bg-background/40 p-3 text-center transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:border-border"
              classList={{ 'calendar-review-warning-card': data().tasks_overdue > 0 }}
              disabled={openDueTasks().length === 0}
              aria-expanded={openTasksExpanded()}
              aria-controls="calendar-review-open-tasks"
              aria-label={`Show ${data().tasks_overdue} open task${data().tasks_overdue === 1 ? '' : 's'} due in this period`}
              onClick={() => setOpenTasksExpanded((open) => !open)}
            >
              <div class="flex items-center justify-center gap-1 mb-1">
                <AlertTriangle size={14} classList={{ 'calendar-review-warning': data().tasks_overdue > 0, 'text-muted-foreground': data().tasks_overdue === 0 }} />
                <span class="text-xs text-muted-foreground">Still open</span>
              </div>
              <div class="text-xl font-semibold"
                   classList={{ 'calendar-review-warning': data().tasks_overdue > 0, 'text-foreground': data().tasks_overdue === 0 }}>
                {data().tasks_overdue}
              </div>
              <div class="text-[11px] text-muted-foreground mt-0.5">
                {props.period === 'week' ? 'due this week' : 'due in last 30 days'}
              </div>
            </button>

            {/* Time blocks */}
            <div class="rounded-lg border border-border bg-background/40 p-3 text-center">
              <div class="flex items-center justify-center gap-1 mb-1">
                <CalendarRange size={14} class="text-muted-foreground" />
                <span class="text-xs text-muted-foreground">Blocks</span>
              </div>
              <div class="text-xl font-semibold text-foreground">{data().blocks_count}</div>
              <div class="text-[11px] text-muted-foreground mt-0.5">scheduled</div>
            </div>
          </div>

          <Show when={openTasksExpanded() && openDueTasks().length > 0}>
            <section id="calendar-review-open-tasks" aria-label="Open tasks due in this period" class="border-t border-border/50 pt-3 mb-3">
              <div class="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Tasks that need attention</div>
              <ul class="flex flex-col gap-1.5">
                <For each={openDueTasks()}>
                  {(task) => (
                    <li>
                      <A href={`/tasks?task=${encodeURIComponent(task.id)}`} class="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2 text-sm text-foreground transition-colors hover:border-primary/60 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span class="min-w-0 flex-1 break-words">{task.title}</span>
                        <span class="flex-shrink-0 text-xs text-muted-foreground">Due {shortDate(task.due_at)}</span>
                        <ArrowUpRight size={13} class="flex-shrink-0 text-muted-foreground" />
                      </A>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          {/* Weekly goals */}
          <Show when={props.period === 'week' && goalsTotal() > 0}>
            <div class="border-t border-border/50 pt-3 mb-3">
              <div class="flex items-center justify-between mb-2">
                <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Weekly Intentions</span>
                <span class="text-[10px] text-muted-foreground">{goalsCompleted()}/{goalsTotal()} done</span>
              </div>
              <ul class="flex flex-col gap-1.5">
                <For each={weeklyData()?.weekly_goals ?? []}>
                  {(g) => (
                    <li class="flex items-start gap-2 text-sm">
                      <Show
                        when={g.done_at}
                        fallback={<span class="w-4 h-4 rounded-sm border border-border flex-shrink-0 mt-0.5" />}
                      >
                        <span class="w-4 h-4 rounded-sm bg-primary flex-shrink-0 mt-0.5 flex items-center justify-center">
                          <Check size={9} class="text-primary-foreground" />
                        </span>
                      </Show>
                      <span class="text-foreground" classList={{ 'line-through text-muted-foreground': !!g.done_at }}>
                        {g.body}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          {/* Someday Tasks stay outside the Flight Plan. The only action here converts
              one into a normal open task, with no schedule or auto-place request. */}
          <section class="border-t border-border/50 pt-3 mb-3">
            <div class="flex items-start justify-between gap-3 mb-2">
              <div>
                <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Someday Tasks</div>
                <p class="text-[11px] text-muted-foreground mt-0.5">Goal dates within {horizonDays()} days, plus undated tasks.</p>
              </div>
              <span class="text-[11px] text-muted-foreground tabular-nums">{reviewSomedayTasks().length}</span>
            </div>
            <Show when={reviewSomedayTasks().length > 0} fallback={<div class="text-xs text-muted-foreground py-1">No Someday Tasks to review in this horizon.</div>}>
              <ul class="flex flex-col gap-1.5">
                <For each={reviewSomedayTasks()}>
                  {(item) => (
                    <li class="flex items-center gap-2 border border-border bg-background/40 px-2.5 py-2">
                      <Pentagon size={13} class="text-muted-foreground flex-shrink-0" />
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm text-foreground">{item.title}</div>
                        <div class="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                          <span>{item.goal_start_date ? `Goal · ${shortDate(item.goal_start_date)}` : 'No goal date'}</span>
                          <span>{durationLabel(item.duration_minutes ?? prefs()?.concept_default_minutes ?? 60)}</span>
                        </div>
                      </div>
                      <button type="button" class="btn-secondary text-[11px] px-2 py-1 flex-shrink-0" disabled={!!promotingId()} onClick={() => void promoteSomedayTask(item)}>
                        <ArrowUpRight size={12} /> {promotingId() === item.id ? 'Promoting…' : 'Promote'}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          {/* Objectives health */}
          <Show when={data().objectives_rotting > 0}>
            <section class="border-t border-border/50 pt-3">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-sm py-1 text-left text-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={objectivesExpanded()}
                aria-controls="calendar-review-objectives"
                onClick={() => setObjectivesExpanded((open) => !open)}
              >
                <Target size={14} class="calendar-review-warning flex-shrink-0" />
                <span class="calendar-review-warning">
                  {data().objectives_rotting} objective{data().objectives_rotting === 1 ? '' : 's'} need{data().objectives_rotting === 1 ? 's' : ''} a next action
                </span>
                <ChevronDown size={14} class="calendar-review-warning ml-auto transition-transform" classList={{ 'rotate-180': objectivesExpanded() }} />
              </button>
              <Show when={objectivesExpanded() && objectivesNeedAttention().length > 0}>
                <ul id="calendar-review-objectives" aria-label="Objectives that need attention" class="mt-2 flex flex-col gap-1.5">
                  <For each={objectivesNeedAttention()}>
                    {(objective) => (
                      <li>
                        <A href={`/tasks?tab=objectives&focus=${encodeURIComponent(objective.id)}`} class="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2 text-sm text-foreground transition-colors hover:border-primary/60 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <Target size={13} class="calendar-review-warning flex-shrink-0" />
                          <span class="min-w-0 flex-1 break-words">{objective.title}</span>
                          <span class="text-xs text-muted-foreground">View objective</span>
                          <ArrowUpRight size={13} class="flex-shrink-0 text-muted-foreground" />
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </Show>

          <Show when={goalsTotal() === 0 && data().objectives_rotting === 0 && data().tasks_completed === 0 && data().tasks_overdue === 0 && data().blocks_count === 0}>
            <div class="text-center text-sm text-muted-foreground py-2">
              No activity recorded {props.period === 'week' ? 'this week' : 'in the last 30 days'} yet.
            </div>
          </Show>

          {/* N4 — Estimate calibration insight */}
          <Show when={props.calibration?.calibrated}>
            {(_) => {
              const cal = props.calibration as Extract<Calibration, { calibrated: true }>;
              const pct = Math.round(Math.abs(cal.bias_ratio - 1) * 100);
              const over = cal.bias_ratio > 1.1;
              const under = cal.bias_ratio < 0.9;
              return (
                <div class="border-t border-border/50 pt-3 flex items-start gap-2 text-sm"
                     classList={{ 'text-amber-400': over, 'text-primary': under, 'text-muted-foreground': !over && !under }}>
                  <TrendingUp size={14} class="flex-shrink-0 mt-0.5" />
                  <div class="min-w-0">
                    <span class="block">{cal.label}</span>
                    <span class="text-[10px] text-muted-foreground">
                      Based on {cal.sample_count} timed task{cal.sample_count === 1 ? '' : 's'}
                      <Show when={pct > 0}> · spread {Math.round((cal.p75 - cal.p25) * 100)}%</Show>
                    </span>
                  </div>
                </div>
              );
            }}
          </Show>
        </div>
      )}
    </Show>
  );
}
