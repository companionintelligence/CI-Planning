import { For, Show, createSignal } from 'solid-js';
import { ViewHeader } from '../components/ViewHeader.js';
import { setActiveEntity } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';
import { A } from '@solidjs/router';
import { Heart, Briefcase, Users, Brain, Smile, DollarSign, Edit, AlertCircle, Target, ListTodo, X, BarChart3 } from 'lucide-solid';
import { priorities, prefs, tasks, setElementModal, refetchPrefs, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';
import type { Priority, Task } from '../lib/api.js';
import { BalanceMetrics } from '../components/BalanceMetrics.js';

interface CategoryConfig { key: string; name: string; icon: typeof Heart; colorClass: string; }

// Swatches align with the seeded category colour tokens (0134: health→tag-1 red,
// career→tag-7 blue, relationships→tag-11 pink, growth→tag-9 purple, leisure→tag-5
// green, finance→tag-2 amber). Owner ruling 2026-07-21: the seeded tokens are
// canonical — leisure/finance were swapped here before Phase B.
const CATEGORIES: CategoryConfig[] = [
  { key: 'health',        name: 'Health',          icon: Heart,      colorClass: 'text-red-500' },
  { key: 'career',        name: 'Career',          icon: Briefcase,  colorClass: 'text-blue-500' },
  { key: 'relationships', name: 'Relationships',   icon: Users,      colorClass: 'text-pink-500' },
  { key: 'growth',        name: 'Personal Growth', icon: Brain,      colorClass: 'text-purple-500' },
  { key: 'leisure',       name: 'Leisure',         icon: Smile,      colorClass: 'text-emerald-500' },
  { key: 'finance',       name: 'Finance',         icon: DollarSign, colorClass: 'text-amber-500' },
];

const FALLBACK: Omit<Priority, 'category'> = { satisfaction: 5, importance: 5, target_hours_per_week: 0 };

export function Balance() {
  const [tab, setTab] = createSignal<'balance' | 'metrics'>('balance');
  const byCategory = (key: string): Priority =>
    priorities()?.find((p) => p.category === key) ?? { category: key, ...FALLBACK };
  const hasData = () => (priorities()?.length ?? 0) > 0;
  const sleepWeek = () => prefs()?.sleep_hours_per_week ?? 63;
  // 0156 — replaces workday_start/workday_end as the source for the AI-authoring
  // "capacity today" hint. Shown here alongside targetTotal() so allocated-across-
  // categories can be compared against total available capacity.
  const capacityWeek = () => prefs()?.capacity_hours_per_week ?? 56;
  const saveCapacityWeek = (v: number) => {
    const clamped = Math.max(1, Math.min(168, v || 1));
    void api.prefs.update({ capacity_hours_per_week: clamped }).then(() => refetchPrefs()).catch((err) => showToast((err as Error).message, 'error'));
  };

  // Phase D: related OPEN tasks per dimension — a pure client-side join (every task
  // carries its `categories` names since Phase B), so no new server surface. The
  // live statuses match FocusReminders' candidate set.
  const openTasksFor = (key: string): Task[] =>
    (tasks() ?? []).filter(
      (t) => ['open', 'scheduled', 'in_progress'].includes(t.status ?? '') && (t.categories ?? []).includes(key),
    );
  // The dimension key whose related-tasks modal is open (null = closed).
  const [tasksModal, setTasksModal] = createSignal<string | null>(null);
  const modalCat = () => CATEGORIES.find((c) => c.key === tasksModal());

  // Balance Index: how well current satisfaction tracks stated importance across categories.
  // Per category alignment = 1 − |importance − satisfaction| / 9; averaged, ×100.
  const balanceIndex = () => {
    const list = priorities() ?? [];
    if (list.length === 0) return 0;
    const sum = list.reduce((acc, p) => acc + (1 - Math.abs(p.importance - p.satisfaction) / 9), 0);
    return Math.max(0, Math.min(100, Math.round((sum / list.length) * 100)));
  };
  const targetTotal = () => (priorities() ?? []).reduce((s, p) => s + p.target_hours_per_week, 0);
  const avgSatisfaction = () => {
    const list = priorities() ?? [];
    return list.length ? Math.round((list.reduce((s, p) => s + p.satisfaction, 0) / list.length) * 10) / 10 : 0;
  };


  return (
    <div class="view-container page-enter">
      <ViewHeader
        title="Life Balance"
        sub="How your current satisfaction lines up with what you say matters most, and your target weekly focus."
      >
        <A href="/priorities" class="btn-secondary"><Edit class="w-4 h-4 mr-1.5" /> Priorities Wizard</A>
      </ViewHeader>

      {/* Tabs — Balance is what you SAY matters (satisfaction vs importance); Metrics is
          what actually happened (completions, tracked time, mood, estimation drift). */}
      <div class="view-tabs" role="tablist">
        <For each={[{ k: 'balance' as const, label: 'Balance' }, { k: 'metrics' as const, label: 'Metrics' }]}>
          {(t) => (
            <button type="button" role="tab" class="view-tab" aria-selected={tab() === t.k} onClick={() => setTab(t.k)}>
              {t.label}
            </button>
          )}
        </For>
      </div>

      <Show when={tab() === 'metrics'}>
        <BalanceMetrics />
      </Show>

      {/* Guarded by the tab OUTSIDE the hasData Show — otherwise the "no priorities yet"
          fallback renders under the Metrics tab as well. */}
      <Show when={tab() === 'balance'}>
      <Show
        when={hasData()}
        fallback={
          <div class="card p-8 text-center flex flex-col items-center gap-3">
            <Target class="w-8 h-8 text-accent" />
            <div class="text-sm text-foreground font-medium">No priorities set yet</div>
            <p class="text-xs text-muted-foreground max-w-sm">
              Run the Priorities Wizard to audit your satisfaction, importance, and target weekly hours across the six life areas.
            </p>
            <A href="/priorities" class="btn-primary mt-2">Start the wizard</A>
          </div>
        }
      >
        {/* KPI cards */}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <div class="card p-5 flex flex-col justify-between">
            <div class="text-xs text-accent font-semibold tracking-wider uppercase mb-1">Balance Index</div>
            <div class="flex items-baseline gap-2">
              <div class="text-4xl font-mono font-extrabold text-foreground">{balanceIndex()}%</div>
              <div class="text-xs text-muted-foreground font-semibold">alignment</div>
            </div>
            <div class="text-[10px] text-muted-foreground mt-3 leading-snug">
              How closely current satisfaction tracks stated importance across all areas.
            </div>
          </div>
          <div class="card p-5 flex flex-col justify-between">
            <div class="text-xs text-muted-foreground font-semibold tracking-wider uppercase mb-1">Weekly Target</div>
            <div class="flex items-baseline gap-2">
              <div class="text-4xl font-mono font-extrabold text-foreground">{targetTotal()}h</div>
              <div class="text-xs text-muted-foreground">of{' '}
                <input
                  type="number" min={1} max={168} step={1}
                  class="input inline-block w-14 py-0 px-1 text-xs text-center"
                  value={capacityWeek()}
                  onChange={(e) => saveCapacityWeek(Number(e.currentTarget.value))}
                />h capacity
              </div>
            </div>
            <div class="text-[10px] text-muted-foreground mt-3 leading-snug">Target hours per week you allocated across categories, against the weekly capacity the AI planner assumes (also in Settings).</div>
          </div>
          <div class="card p-5 flex flex-col justify-between">
            <div class="text-xs text-muted-foreground font-semibold tracking-wider uppercase mb-1">Avg Satisfaction</div>
            <div class="flex items-baseline gap-2">
              <div class="text-4xl font-mono font-extrabold text-foreground">{avgSatisfaction()}</div>
              <div class="text-xs text-muted-foreground">/ 10</div>
            </div>
            <div class="text-[10px] text-muted-foreground mt-3 leading-snug">Mean current-satisfaction score across the six areas.</div>
          </div>
        </div>

        <div>
          {/* Per-category. Single column since the Focus Areas rail was removed —
              the per-card "matters more than it satisfies" line already carries that
              signal, in place, without a second list restating it. */}
          <div class="flex flex-col gap-4">
            <h2 class="text-lg font-bold text-foreground flex items-center gap-2"><BarChart3 class="w-4 h-4 text-primary" /> Core Dimensions</h2>
            <div class="flex flex-col gap-4">
              <For each={CATEGORIES}>
                {(cat) => {
                  const p = () => byCategory(cat.key);
                  const gap = () => p().importance - p().satisfaction;
                  const Icon = cat.icon;
                  return (
                    <div
                      class="card p-5 cursor-pointer hover:border-ring/60 transition-colors"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button,a,input')) return;
                        setActiveEntity('dimension', cat.key);
                        revealDetails();
                      }}
                    >
                      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
                        <div class="flex items-center gap-3">
                          <div class={`p-2 rounded-xl bg-muted ${cat.colorClass}`}><Icon class="w-5 h-5" /></div>
                          <div>
                            <h3 class="font-bold text-foreground text-base leading-none">{cat.name}</h3>
                            <span class="text-[10px] text-muted-foreground font-mono uppercase mt-1 inline-block">
                              {p().target_hours_per_week}h/wk target{cat.key === 'health' ? ` · +${sleepWeek()}h sleep` : ''}
                            </span>
                          </div>
                        </div>
                        <div class="flex gap-3 items-center">
                          {/* Phase D: the dimension's related open tasks (categories join). */}
                          <button
                            type="button"
                            onClick={() => setTasksModal(cat.key)}
                            class="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-xl border border-border bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                            title={`Open tasks in ${cat.name}`}
                          >
                            <ListTodo class="w-3.5 h-3.5" />
                            {openTasksFor(cat.key).length} open
                          </button>
                          <div class="flex flex-col items-center bg-muted/50 px-2.5 py-1 rounded-xl border border-border">
                            <span class="text-[9px] text-muted-foreground uppercase font-mono">Satisfy</span>
                            <span class="text-sm font-mono font-bold text-accent">{p().satisfaction}/10</span>
                          </div>
                          <div class="flex flex-col items-center bg-muted/50 px-2.5 py-1 rounded-xl border border-border">
                            <span class="text-[9px] text-muted-foreground uppercase font-mono">Matters</span>
                            <span class="text-sm font-mono font-bold text-foreground">{p().importance}/10</span>
                          </div>
                        </div>
                      </div>

                      {/* satisfaction vs importance bars */}
                      <div class="space-y-2">
                        <div class="flex items-center gap-2">
                          <span class="text-[10px] text-muted-foreground font-mono w-14 flex-shrink-0">satisfy</span>
                          <div class="h-2 flex-1 bg-muted rounded-full overflow-hidden">
                            <div class="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${p().satisfaction * 10}%` }} />
                          </div>
                        </div>
                        <div class="flex items-center gap-2">
                          <span class="text-[10px] text-muted-foreground font-mono w-14 flex-shrink-0">matters</span>
                          <div class="h-2 flex-1 bg-muted rounded-full overflow-hidden">
                            <div class="h-full rounded-full bg-foreground/40 transition-all duration-300" style={{ width: `${p().importance * 10}%` }} />
                          </div>
                        </div>
                      </div>

                      <Show when={gap() >= 3}>
                        <div class="mt-3 inline-flex items-center gap-1.5 text-[11px] text-amber-500 font-medium">
                          <AlertCircle class="w-3.5 h-3.5" /> Matters more than it satisfies — a focus area.
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

        </div>
      </Show>
      </Show>

      {/* Phase D — related open tasks for a dimension. Click-through opens the task's
          edit wizard (the app-global ElementWizard), same affordance as a card edit. */}
      <Show when={modalCat()}>
        {(cat) => (
          <div class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setTasksModal(null)}>
            <div class="card w-full max-w-md max-h-[70vh] flex flex-col p-0 overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div class="flex items-center gap-2.5 px-4 py-3 border-b border-border">
                <div class={`p-1.5 rounded-lg bg-muted ${cat().colorClass}`}>{(() => { const I = cat().icon; return <I class="w-4 h-4" />; })()}</div>
                <h3 class="text-sm font-bold text-foreground flex-1">{cat().name} — open tasks</h3>
                <button type="button" class="btn-icon" onClick={() => setTasksModal(null)}><X size={14} /></button>
              </div>
              <div class="overflow-y-auto p-2 flex flex-col gap-1">
                <For each={openTasksFor(cat().key)}>
                  {(t) => (
                    <button
                      type="button"
                      class="w-full text-left px-2.5 py-2 rounded-lg hover:bg-sidebar-accent flex items-center gap-2.5"
                      onClick={() => { setTasksModal(null); setElementModal({ open: true, mode: 'edit', kind: t.is_habit ? 'habit' : 'task', editTarget: { kind: t.is_habit ? 'habit' : 'task', id: t.id } }); }}
                    >
                      <span class="text-[10px] font-mono text-muted-foreground flex-shrink-0">P{t.priority}</span>
                      <span class="text-sm text-foreground truncate flex-1">{t.title}</span>
                      <Show when={t.scheduled_for}>
                        <span class="text-[10px] text-muted-foreground font-mono flex-shrink-0">{t.scheduled_for}</span>
                      </Show>
                    </button>
                  )}
                </For>
                <Show when={openTasksFor(cat().key).length === 0}>
                  <div class="text-xs text-muted-foreground text-center py-6">
                    No open tasks in this area yet — categorize tasks in the Add/Edit wizard.
                  </div>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
