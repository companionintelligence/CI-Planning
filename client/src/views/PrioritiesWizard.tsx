import { createSignal, createEffect, For, Show } from 'solid-js';
import { Heart, Briefcase, Users, Brain, Smile, DollarSign, ChevronLeft, ChevronRight, Check, Save } from 'lucide-solid';
import { priorities, refetchPriorities, showToast } from '../stores/index.js';
import { api, Priority } from '../lib/api.js';

interface CategoryConfig {
  key: string;
  name: string;
  description: string;
  icon: any;
  colorClass: string;
  bgClass: string;
}

const CATEGORIES: CategoryConfig[] = [
  {
    key: 'health',
    name: 'Health',
    description: 'Sleep, nutrition, exercise, mental well-being, and longevity.',
    icon: Heart,
    colorClass: 'text-red-400',
    bgClass: 'bg-red-500/10 border-red-500/20',
  },
  {
    key: 'career',
    name: 'Career',
    description: 'Work goals, business growth, professional skill-building, and projects.',
    icon: Briefcase,
    colorClass: 'text-blue-400',
    bgClass: 'bg-blue-500/10 border-blue-500/20',
  },
  {
    key: 'relationships',
    name: 'Relationships',
    description: 'Family connection, partnerships, friendship, and social community.',
    icon: Users,
    colorClass: 'text-pink-400',
    bgClass: 'bg-pink-500/10 border-pink-500/20',
  },
  {
    key: 'growth',
    name: 'Personal Growth',
    description: 'Learning new skills, reading, curiosity, hobbies, and mindset.',
    icon: Brain,
    colorClass: 'text-purple-400',
    bgClass: 'bg-purple-500/10 border-purple-500/20',
  },
  {
    key: 'leisure',
    name: 'Leisure',
    description: 'Relaxation, pure play, unstructured free time, and rest.',
    icon: Smile,
    colorClass: 'text-amber-400',
    bgClass: 'bg-amber-500/10 border-amber-500/20',
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Wealth accumulation, budgeting, investment strategy, and safety.',
    icon: DollarSign,
    colorClass: 'text-emerald-400',
    bgClass: 'bg-emerald-500/10 border-emerald-500/20',
  },
];

export function PrioritiesWizard() {
  const [step, setStep] = createSignal(1);

  // Form state
  const [satisfactions, setSatisfactions] = createSignal<Record<string, number>>({
    health: 5, career: 5, relationships: 5, growth: 5, leisure: 5, finance: 5
  });

  const [importances, setImportances] = createSignal<Record<string, number>>({
    health: 5, career: 5, relationships: 5, growth: 5, leisure: 5, finance: 5
  });

  const [targetHours, setTargetHours] = createSignal<Record<string, number>>({
    health: 10, career: 40, relationships: 15, growth: 10, leisure: 15, finance: 5
  });

  // Pre-load from store
  createEffect(() => {
    const data = priorities();
    if (data && data.length > 0) {
      const newS: Record<string, number> = {};
      const newI: Record<string, number> = {};
      const newH: Record<string, number> = {};

      for (const item of data) {
        newS[item.category] = item.satisfaction ?? 5;
        newI[item.category] = item.importance ?? 5;
        newH[item.category] = item.target_hours_per_week ?? 10;
      }

      setSatisfactions(prev => ({ ...prev, ...newS }));
      setImportances(prev => ({ ...prev, ...newI }));
      setTargetHours(prev => ({ ...prev, ...newH }));
    }
  });

  // Calculate allocated hours out of 168 hours/week
  const totalAllocatedHours = () => {
    return Object.values(targetHours()).reduce((sum, h) => sum + h, 0);
  };

  const remainingHours = () => {
    return 168 - totalAllocatedHours();
  };

  function updateSatisfaction(category: string, value: number) {
    setSatisfactions(prev => ({ ...prev, [category]: value }));
  }

  function updateImportance(category: string, value: number) {
    setImportances(prev => ({ ...prev, [category]: value }));
  }

  function updateTargetHours(category: string, value: number) {
    setTargetHours(prev => ({ ...prev, [category]: value }));
  }

  async function handleSave() {
    try {
      const payload: Priority[] = CATEGORIES.map((c) => ({
        category: c.key,
        satisfaction: satisfactions()[c.key] ?? 5,
        importance: importances()[c.key] ?? 5,
        target_hours_per_week: targetHours()[c.key] ?? 0,
      }));

      await api.priorities.save(payload);
      refetchPriorities();
      showToast('Life priorities updated!', 'success');
      // Redirect or show success
      setStep(4);
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  }

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      {/* Header */}
      <div class="mb-8 text-center">
        <h1 class="text-3xl font-heading font-extrabold text-ci-1 tracking-wide mb-2">
          Life Balance Wizard
        </h1>
        <p class="text-sm text-ci-1/70 max-w-lg mx-auto">
          Audit your current life setup, clarify what matters most, and align your target weekly focus.
        </p>
      </div>

      {/* Step Indicators */}
      <div class="flex items-center justify-between mb-8 max-w-xl mx-auto relative px-2">
        <div class="absolute top-1/2 left-0 right-0 h-0.5 bg-surface-700 -translate-y-1/2 z-0" />
        <div
          class="absolute top-1/2 left-0 h-0.5 bg-accent -translate-y-1/2 z-0 transition-all duration-300"
          style={{ width: `${((step() - 1) / 3) * 100}%` }}
        />

        <For each={[1, 2, 3, 4]}>
          {(num) => (
            <button
              onClick={() => num < 4 && setStep(num)}
              disabled={num === 4 && step() < 3}
              class={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs border transition-all duration-200
                ${step() === num
                  ? 'bg-accent border-accent text-surface-950 shadow-glow-accent scale-110'
                  : step() > num
                    ? 'bg-accent/20 border-accent text-accent'
                    : 'bg-surface-800 border-surface-700 text-ci-1/40'}`}
            >
              {step() > num ? <Check class="w-4 h-4 stroke-[3]" /> : num}
            </button>
          )}
        </For>
      </div>

      {/* Step Contents */}
      <div class="card p-6 shadow-xl border-surface-700 bg-surface-800/60 backdrop-blur-md">
        {/* Step 1: Satisfaction Audit */}
        <Show when={step() === 1}>
          <div>
            <h2 class="text-xl font-bold text-ci-1 mb-2">Step 1: Current Satisfaction</h2>
            <p class="text-xs text-ci-1/60 mb-6">
              Rate your current level of satisfaction in each area of life (1 = Not fulfilled at all, 10 = Fully thriving).
            </p>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <For each={CATEGORIES}>
                {(cat) => {
                  const Icon = cat.icon;
                  const currentVal = () => satisfactions()[cat.key] ?? 5;
                  return (
                    <div class={`p-4 rounded-2xl border ${cat.bgClass} flex flex-col gap-3 transition-all hover:scale-[1.01]`}>
                      <div class="flex items-start gap-3">
                        <div class={`p-2 rounded-xl bg-surface-900 ${cat.colorClass}`}>
                          <Icon class="w-5 h-5" />
                        </div>
                        <div>
                          <h3 class="text-sm font-bold text-ci-1 leading-none mb-1">{cat.name}</h3>
                          <p class="text-[11px] text-ci-1/60 leading-snug">{cat.description}</p>
                        </div>
                      </div>

                      <div class="flex items-center gap-4 mt-1">
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={currentVal()}
                          onInput={(e) => updateSatisfaction(cat.key, Number(e.currentTarget.value))}
                          class="flex-1 accent-accent"
                        />
                        <span class="text-sm font-mono font-bold text-accent min-w-[20px] text-right">
                          {currentVal()}
                        </span>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>

            <div class="flex justify-end gap-3 mt-8">
              <button onClick={() => setStep(2)} class="btn-primary">
                Next: Focus Priority <ChevronRight class="w-4 h-4 ml-1" />
              </button>
            </div>
          </div>
        </Show>

        {/* Step 2: Importance Audit */}
        <Show when={step() === 2}>
          <div>
            <h2 class="text-xl font-bold text-ci-1 mb-2">Step 2: Desired Focus</h2>
            <p class="text-xs text-ci-1/60 mb-6">
              Rate the overall importance of each priority area to your vision of a balanced, successful life (1 = Low priority, 10 = Essential).
            </p>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <For each={CATEGORIES}>
                {(cat) => {
                  const Icon = cat.icon;
                  const currentVal = () => importances()[cat.key] ?? 5;
                  return (
                    <div class={`p-4 rounded-2xl border ${cat.bgClass} flex flex-col gap-3 transition-all hover:scale-[1.01]`}>
                      <div class="flex items-start gap-3">
                        <div class={`p-2 rounded-xl bg-surface-900 ${cat.colorClass}`}>
                          <Icon class="w-5 h-5" />
                        </div>
                        <div>
                          <h3 class="text-sm font-bold text-ci-1 leading-none mb-1">{cat.name}</h3>
                          <p class="text-[11px] text-ci-1/60 leading-snug">{cat.description}</p>
                        </div>
                      </div>

                      <div class="flex items-center gap-4 mt-1">
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={currentVal()}
                          onInput={(e) => updateImportance(cat.key, Number(e.currentTarget.value))}
                          class="flex-1 accent-accent"
                        />
                        <span class="text-sm font-mono font-bold text-accent min-w-[20px] text-right">
                          {currentVal()}
                        </span>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>

            <div class="flex justify-between gap-3 mt-8">
              <button onClick={() => setStep(1)} class="btn-secondary">
                <ChevronLeft class="w-4 h-4 mr-1" /> Back
              </button>
              <button onClick={() => setStep(3)} class="btn-primary">
                Next: Weekly Allocation <ChevronRight class="w-4 h-4 ml-1" />
              </button>
            </div>
          </div>
        </Show>

        {/* Step 3: Hours target splits */}
        <Show when={step() === 3}>
          <div>
            <h2 class="text-xl font-bold text-ci-1 mb-2">Step 3: Hours Target Allocation</h2>
            <p class="text-xs text-ci-1/60 mb-4">
              Allocate your target hours per week for each category. There are 168 hours total in a week.
            </p>

            {/* Total progress visual indicator */}
            <div class="bg-surface-900/50 p-4 rounded-2xl border border-surface-700 mb-6 flex flex-col gap-2">
              <div class="flex justify-between items-center text-xs font-mono">
                <span class="text-ci-1/60">Allocated: <b class="text-accent">{totalAllocatedHours()}h</b></span>
                <span class={`${remainingHours() < 0 ? 'text-red-400' : 'text-ci-3'}`}>
                  {remainingHours() >= 0 ? `${remainingHours()}h remaining` : `${Math.abs(remainingHours())}h over allocated!`}
                </span>
              </div>
              <div class="h-2 w-full bg-surface-800 rounded-full overflow-hidden relative">
                <div
                  class={`h-full rounded-full transition-all duration-300 ${remainingHours() < 0 ? 'bg-red-500' : 'bg-gradient-to-r from-accent to-ci-3'}`}
                  style={{ width: `${Math.min(100, (totalAllocatedHours() / 168) * 100)}%` }}
                />
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <For each={CATEGORIES}>
                {(cat) => {
                  const Icon = cat.icon;
                  const currentVal = () => targetHours()[cat.key] ?? 0;
                  return (
                    <div class={`p-4 rounded-2xl border ${cat.bgClass} flex flex-col gap-2 transition-all hover:scale-[1.01]`}>
                      <div class="flex justify-between items-start gap-3">
                        <div class="flex gap-3 items-center">
                          <div class={`p-1.5 rounded-lg bg-surface-900 ${cat.colorClass}`}>
                            <Icon class="w-4 h-4" />
                          </div>
                          <h3 class="text-sm font-bold text-ci-1 leading-none">{cat.name}</h3>
                        </div>
                        <span class="text-xs text-ci-1/50 font-mono">Desired Focus: {importances()[cat.key] ?? 5}/10</span>
                      </div>

                      <div class="flex items-center gap-4 mt-2">
                        <input
                          type="range"
                          min="0"
                          max="80"
                          step="1"
                          value={currentVal()}
                          onInput={(e) => updateTargetHours(cat.key, Number(e.currentTarget.value))}
                          class="flex-1 accent-accent"
                        />
                        <div class="flex items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            max="168"
                            value={currentVal()}
                            onChange={(e) => updateTargetHours(cat.key, Math.max(0, Math.min(168, Number(e.target.value))))}
                            class="bg-surface-900 border border-surface-700 rounded px-1.5 py-0.5 text-xs text-center text-ci-1 font-mono w-12"
                          />
                          <span class="text-xs text-ci-1/60 font-mono">h/wk</span>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>

            <div class="flex justify-between gap-3 mt-8">
              <button onClick={() => setStep(2)} class="btn-secondary">
                <ChevronLeft class="w-4 h-4 mr-1" /> Back
              </button>
              <button
                onClick={handleSave}
                class="btn-primary"
                disabled={remainingHours() < 0}
              >
                <Save class="w-4 h-4 mr-1.5" /> Save & Build Balance Plan
              </button>
            </div>
          </div>
        </Show>

        {/* Step 4: Completion / Success state */}
        <Show when={step() === 4}>
          <div class="text-center py-8">
            <div class="w-16 h-16 bg-ci-3/20 border border-ci-3/40 rounded-full flex items-center justify-center mx-auto mb-5 text-ci-3">
              <Check class="w-8 h-8 stroke-[3]" />
            </div>

            <h2 class="text-2xl font-bold text-ci-1 mb-2">Life Priorities Set!</h2>
            <p class="text-sm text-ci-1/70 max-w-md mx-auto mb-8">
              Your satisfaction scores, importance metrics, and desired weekly hours targets have been recorded.
              The scheduling engine will now automatically prioritize tasks in areas that are lagging behind.
            </p>

            <div class="flex justify-center gap-4">
              <button onClick={() => setStep(1)} class="btn-secondary">
                Edit Audits
              </button>
              <a href="/balance" class="btn-primary">
                View Life Balance Dashboard
              </a>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
