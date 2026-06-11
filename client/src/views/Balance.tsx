import { createSignal, createEffect, For, Show, createResource } from 'solid-js';
import { Heart, Briefcase, Users, Brain, Smile, DollarSign, Edit, Sparkles, Plus, AlertCircle } from 'lucide-solid';
import { priorities, tasks, showToast, setTaskModal } from '../stores/index.js';
import { api, Priority, Task } from '../lib/api.js';

interface CategoryConfig {
  key: string;
  name: string;
  icon: any;
  colorClass: string;
  bgClass: string;
  gradientClass: string;
  themeColor: string;
}

const CATEGORIES: CategoryConfig[] = [
  {
    key: 'health',
    name: 'Health',
    icon: Heart,
    colorClass: 'text-red-400',
    bgClass: 'bg-red-500/10 border-red-500/20',
    gradientClass: 'from-red-500/40 to-red-600/10',
    themeColor: '#ef4444',
  },
  {
    key: 'career',
    name: 'Career',
    icon: Briefcase,
    colorClass: 'text-blue-400',
    bgClass: 'bg-blue-500/10 border-blue-500/20',
    gradientClass: 'from-blue-500/40 to-blue-600/10',
    themeColor: '#3b82f6',
  },
  {
    key: 'relationships',
    name: 'Relationships',
    icon: Users,
    colorClass: 'text-pink-400',
    bgClass: 'bg-pink-500/10 border-pink-500/20',
    gradientClass: 'from-pink-500/40 to-pink-600/10',
    themeColor: '#ec4899',
  },
  {
    key: 'growth',
    name: 'Personal Growth',
    icon: Brain,
    colorClass: 'text-purple-400',
    bgClass: 'bg-purple-500/10 border-purple-500/20',
    gradientClass: 'from-purple-500/40 to-purple-600/10',
    themeColor: '#a855f7',
  },
  {
    key: 'leisure',
    name: 'Leisure',
    icon: Smile,
    colorClass: 'text-amber-400',
    bgClass: 'bg-amber-500/10 border-amber-500/20',
    gradientClass: 'from-amber-500/40 to-amber-600/10',
    themeColor: '#f59e0b',
  },
  {
    key: 'finance',
    name: 'Finance',
    icon: DollarSign,
    colorClass: 'text-emerald-400',
    bgClass: 'bg-emerald-500/10 border-emerald-500/20',
    gradientClass: 'from-emerald-500/40 to-emerald-600/10',
    themeColor: '#10b981',
  },
];

function getWeekRange() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return {
    from: monday.toISOString(),
    to: sunday.toISOString(),
  };
}

export function Balance() {
  const range = getWeekRange();

  // Load weekly blocks
  const [weeklyBlocks] = createResource(() =>
    api.blocks.list(range.from, range.to).then((res) => res.blocks)
  );

  // Group tasks by category for lookup
  const taskCategoryMap = () => {
    const map = new Map<number, string>();
    const list = tasks() || [];
    for (const t of list) {
      if (t.id && t.category) {
        map.set(t.id, t.category);
      }
    }
    return map;
  };

  // Calculate actual hours for the week per category
  const actualCategoryHours = () => {
    const catHours: Record<string, number> = {};
    const blocksList = weeklyBlocks() || [];
    const catMap = taskCategoryMap();

    for (const b of blocksList) {
      if (b.task_id) {
        const cat = catMap.get(b.task_id);
        if (cat) {
          const durationMs = new Date(b.end_at).getTime() - new Date(b.start_at).getTime();
          const durationHours = durationMs / 3600_000;
          catHours[cat] = (catHours[cat] || 0) + durationHours;
        }
      }
    }
    return catHours;
  };

  // Overall statistics
  const balanceMetrics = () => {
    const list = priorities() || [];
    const actuals = actualCategoryHours();

    if (list.length === 0) {
      return { satisfactionAvg: 0, balanceScore: 0, scheduledTotal: 0, targetTotal: 0 };
    }

    let satSum = 0;
    let devSum = 0;
    let scheduledTotal = 0;
    let targetTotal = 0;

    for (const p of list) {
      satSum += p.satisfaction;
      targetTotal += p.target_hours_per_week;
      const act = actuals[p.category] || 0;
      scheduledTotal += act;
      
      // Calculate deviation ratio from desired target split
      if (p.target_hours_per_week > 0) {
        const diff = Math.abs(p.target_hours_per_week - act);
        devSum += diff / p.target_hours_per_week;
      }
    }

    const satisfactionAvg = satSum / list.length;
    // Balance score is 100 minus average deviation, bounded at 0-100
    const devAvg = devSum / list.length;
    const balanceScore = Math.max(0, Math.min(100, Math.round((1 - devAvg * 0.5) * 100)));

    return {
      satisfactionAvg: Math.round(satisfactionAvg * 10) / 10,
      balanceScore,
      scheduledTotal: Math.round(scheduledTotal * 10) / 10,
      targetTotal,
    };
  };

  function handleCreateTask(category: string) {
    setTaskModal({
      open: true,
      editTask: undefined,
      parentId: undefined,
      defaultDueAt: new Date().toISOString().slice(0, 10),
    });
    // Set field values after modal is triggered (or we can inject it as standard defaults)
    // Here we'll configure standard task form categories mapping
    // We'll pass the category pre-selection through storage or global modal values.
    sessionStorage.setItem('prefilled_category', category);
  }

  // Suggestions engine
  const optimizationTips = () => {
    const list = priorities() || [];
    const actuals = actualCategoryHours();
    const tips: { category: string; icon: any; title: string; text: string; actionable: boolean }[] = [];

    for (const p of list) {
      const act = actuals[p.category] || 0;
      if (p.target_hours_per_week > 0 && act < p.target_hours_per_week * 0.5) {
        const catConfig = CATEGORIES.find(c => c.key === p.category);
        const hoursShort = Math.round((p.target_hours_per_week - act) * 10) / 10;
        tips.push({
          category: p.category,
          icon: catConfig?.icon,
          title: `Under-scheduled in ${catConfig?.name}`,
          text: `You are currently ${hoursShort}h short of your weekly target. Schedule a priority task to restore balance.`,
          actionable: true,
        });
      }
    }

    if (tips.length === 0) {
      tips.push({
        category: 'general',
        icon: Sparkles,
        title: 'Perfect Alignment!',
        text: 'Your current weekly schedule aligns beautifully with your set life priority splits. Keep it up!',
        actionable: false,
      });
    }

    return tips;
  };

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-5xl mx-auto w-full">
      {/* Top Banner */}
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 class="text-3xl font-heading font-extrabold text-ci-1 tracking-wide mb-1">
            Life Balance Cockpit
          </h1>
          <p class="text-xs text-ci-1/60">
            Compare target splits with actual scheduled weekly hours to maintain health, focus, and connection.
          </p>
        </div>

        <div class="flex gap-3">
          <a href="/priorities-wizard" class="btn-secondary">
            <Edit class="w-4 h-4 mr-1.5" /> Priorities Wizard
          </a>
        </div>
      </div>

      {/* Summary KPI Grid */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        <div class="card p-5 bg-gradient-to-br from-accent/10 to-transparent border-accent/20 flex flex-col justify-between">
          <div class="text-xs text-accent font-semibold tracking-wider uppercase mb-1">Life Balance Index</div>
          <div class="flex items-baseline gap-2">
            <div class="text-4xl font-mono font-extrabold text-ci-1">{balanceMetrics().balanceScore}%</div>
            <div class="text-xs text-ci-3 font-semibold">Alignment</div>
          </div>
          <div class="text-[10px] text-ci-1/50 mt-3 leading-snug">
            Measures proximity of actual scheduled time to target priority splits.
          </div>
        </div>

        <div class="card p-5 bg-surface-800 flex flex-col justify-between">
          <div class="text-xs text-ci-1/60 font-semibold tracking-wider uppercase mb-1">Weekly Target Split</div>
          <div class="flex items-baseline gap-2">
            <div class="text-4xl font-mono font-extrabold text-ci-1">{balanceMetrics().targetTotal}h</div>
            <div class="text-xs text-ci-1/50">total focus</div>
          </div>
          <div class="text-[10px] text-ci-1/50 mt-3 leading-snug">
            Ideal breakdown of waking hours mapped to satisfaction & value metrics.
          </div>
        </div>

        <div class="card p-5 bg-surface-800 flex flex-col justify-between">
          <div class="text-xs text-ci-1/60 font-semibold tracking-wider uppercase mb-1">Actually Scheduled</div>
          <div class="flex items-baseline gap-2">
            <div class="text-4xl font-mono font-extrabold text-ci-1">{balanceMetrics().scheduledTotal}h</div>
            <div class="text-xs text-ci-1/50">this week</div>
          </div>
          <div class="text-[10px] text-ci-1/50 mt-3 leading-snug font-mono">
            Range: {range.from.slice(5, 10)} to {range.to.slice(5, 10)}
          </div>
        </div>
      </div>

      {/* Wheel of Life Audits and Hours Split */}
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Main Priorities List */}
        <div class="lg:col-span-2 flex flex-col gap-4">
          <h2 class="text-lg font-bold text-ci-1 flex items-center gap-2">
            📊 Core Dimensions
          </h2>

          <div class="flex flex-col gap-4">
            <For each={CATEGORIES}>
              {(cat) => {
                const item = () => priorities()?.find(p => p.category === cat.key) || {
                  satisfaction: 5,
                  importance: 5,
                  target_hours_per_week: 0
                };
                const actHours = () => actualCategoryHours()[cat.key] || 0;
                const targetHoursVal = () => item().target_hours_per_week;
                
                const percentScheduled = () => {
                  if (targetHoursVal() === 0) return 0;
                  return Math.min(100, Math.round((actHours() / targetHoursVal()) * 100));
                };

                const Icon = cat.icon;

                return (
                  <div class={`card p-5 border border-surface-700 bg-surface-800/80 hover:bg-surface-800 transition-all duration-200`}>
                    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
                      
                      {/* Name & Icon */}
                      <div class="flex items-center gap-3">
                        <div class={`p-2 rounded-xl bg-surface-900 ${cat.colorClass}`}>
                          <Icon class="w-5 h-5" />
                        </div>
                        <div>
                          <h3 class="font-bold text-ci-1 text-base leading-none">{cat.name}</h3>
                          <span class="text-[10px] text-ci-1/50 tracking-wide font-mono uppercase mt-1 inline-block">
                            Deficit Boost Algorithm active
                          </span>
                        </div>
                      </div>

                      {/* Satisfaction & Importance */}
                      <div class="flex gap-4 items-center">
                        <div class="flex flex-col items-center bg-surface-900/50 px-2.5 py-1 rounded-xl border border-surface-700">
                          <span class="text-[9px] text-ci-1/50 uppercase font-mono">Satisfy</span>
                          <span class="text-sm font-mono font-bold text-accent">{item().satisfaction}/10</span>
                        </div>
                        <div class="flex flex-col items-center bg-surface-900/50 px-2.5 py-1 rounded-xl border border-surface-700">
                          <span class="text-[9px] text-ci-1/50 uppercase font-mono">Desired</span>
                          <span class="text-sm font-mono font-bold text-ci-3">{item().importance}/10</span>
                        </div>
                      </div>

                    </div>

                    {/* Progress bars (Target vs Actual) */}
                    <div class="space-y-2.5">
                      <div class="flex justify-between items-center text-xs font-mono">
                        <span class="text-ci-1/70">Weekly allocation split:</span>
                        <span class="text-ci-1 font-semibold">
                          <b class="text-accent">{Math.round(actHours() * 10) / 10}h</b> / {targetHoursVal()}h
                        </span>
                      </div>

                      <div class="h-2.5 w-full bg-surface-900 rounded-full overflow-hidden relative border border-surface-700">
                        <div
                          class={`h-full rounded-full transition-all duration-300 bg-gradient-to-r ${
                            percentScheduled() >= 90 ? 'from-ci-3 to-ci-8' : 'from-accent to-accent-hi'
                          }`}
                          style={{ width: `${percentScheduled()}%` }}
                        />
                      </div>

                      <div class="flex justify-between items-center">
                        <span class="text-[10px] text-ci-1/40 font-mono">
                          {percentScheduled()}% of weekly target met
                        </span>
                        
                        <button
                          onClick={() => handleCreateTask(cat.key)}
                          class="inline-flex items-center gap-1 text-[10px] font-bold text-ci-3 hover:text-ci-9 transition-colors cursor-pointer"
                        >
                          <Plus class="w-3.5 h-3.5" /> Add Category Task
                        </button>
                      </div>
                    </div>

                  </div>
                );
              }}
            </For>
          </div>
        </div>

        {/* Sidebar: Optimizations / Balancing Recommendations */}
        <div class="flex flex-col gap-5">
          <h2 class="text-lg font-bold text-ci-1 flex items-center gap-2">
            💡 Optimization Tips
          </h2>

          <div class="flex flex-col gap-4">
            <For each={optimizationTips()}>
              {(tip) => {
                const Icon = tip.icon;
                return (
                  <div class={`card p-4 flex gap-3.5 items-start bg-surface-900/40 border border-surface-700 hover:border-surface-600 transition-colors`}>
                    <div class="p-2 rounded-xl bg-surface-900 border border-surface-700 text-accent flex-shrink-0 mt-0.5">
                      <Icon class="w-4 h-4" />
                    </div>

                    <div class="space-y-1">
                      <h4 class="text-xs font-bold text-ci-1">{tip.title}</h4>
                      <p class="text-[11px] text-ci-1/60 leading-snug">{tip.text}</p>
                      
                      <Show when={tip.actionable}>
                        <button
                          onClick={() => handleCreateTask(tip.category)}
                          class="inline-flex items-center gap-1 text-[10px] font-bold text-accent hover:text-accent-hi mt-2 transition-colors cursor-pointer"
                        >
                          <Plus class="w-3 h-3" /> Create balancing task
                        </button>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>

          {/* Quick Explanation */}
          <div class="card p-4 bg-surface-800 border-surface-700 flex flex-col gap-2">
            <h3 class="text-xs font-bold text-ci-1 flex items-center gap-1.5">
              <AlertCircle class="w-3.5 h-3.5 text-accent" /> How balancing works
            </h3>
            <p class="text-[10px] text-ci-1/60 leading-relaxed">
              Our <b>Deficit Boost Algorithm</b> checks which category has the highest deviation from your desired hours target. 
              Tasks in starved categories automatically receive a priority rank boost during scheduled generation, keeping your week in natural balance without strict calendar rules.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}
