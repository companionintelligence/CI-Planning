import { createSignal, createEffect, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Heart, Briefcase, Users, Brain, Smile, DollarSign, ChevronLeft, ChevronRight, Check, Save, Moon } from 'lucide-solid';
import { priorities, refetchPriorities, prefs, refetchPrefs, showToast } from '../stores/index.js';
import { api, type Priority } from '../lib/api.js';

interface CategoryConfig {
  key: string;
  name: string;
  description: string;
  icon: typeof Heart;
  colorClass: string;
  bgClass: string;
}

// The fixed life-priority categories (match the `category` keys stored server-side).
const CATEGORIES: CategoryConfig[] = [
  { key: 'health',        name: 'Health',          description: 'Sleep, nutrition, exercise, mental well-being, and longevity.',      icon: Heart,      colorClass: 'text-red-500',     bgClass: 'bg-red-500/10 border-red-500/20' },
  { key: 'career',        name: 'Career',          description: 'Work goals, business growth, professional skill-building, projects.', icon: Briefcase,  colorClass: 'text-blue-500',    bgClass: 'bg-blue-500/10 border-blue-500/20' },
  { key: 'relationships', name: 'Relationships',   description: 'Family connection, partnerships, friendship, and social community.', icon: Users,      colorClass: 'text-pink-500',    bgClass: 'bg-pink-500/10 border-pink-500/20' },
  { key: 'growth',        name: 'Personal Growth', description: 'Learning new skills, reading, curiosity, hobbies, and mindset.',     icon: Brain,      colorClass: 'text-purple-500',  bgClass: 'bg-purple-500/10 border-purple-500/20' },
  { key: 'leisure',       name: 'Leisure',         description: 'Relaxation, pure play, unstructured free time, and rest.',            icon: Smile,      colorClass: 'text-amber-500',   bgClass: 'bg-amber-500/10 border-amber-500/20' },
  { key: 'finance',       name: 'Finance',         description: 'Wealth accumulation, budgeting, investment strategy, and safety.',   icon: DollarSign, colorClass: 'text-emerald-500', bgClass: 'bg-emerald-500/10 border-emerald-500/20' },
];

const DEFAULT_HOURS: Record<string, number> = { health: 10, career: 40, relationships: 15, growth: 10, leisure: 15, finance: 5 };

export function PrioritiesWizard() {
  const [step, setStep] = createSignal(1);

  const seed = (val: number) => Object.fromEntries(CATEGORIES.map((c) => [c.key, val]));
  const [satisfactions, setSatisfactions] = createSignal<Record<string, number>>(seed(5));
  const [importances, setImportances] = createSignal<Record<string, number>>(seed(5));
  const [targetHours, setTargetHours] = createSignal<Record<string, number>>({ ...DEFAULT_HOURS });
  // Sleep is reserved, unschedulable time attributed to Health. Default 9h/night (63h/wk),
  // leaving 105h of the 168-hour week to schedule.
  const [sleepPerNight, setSleepPerNight] = createSignal(9);
  const sleepWeek = () => Math.round(sleepPerNight() * 7);
  const schedulablePool = () => 168 - sleepWeek();

  // Pre-load from the store once priorities resolve (edit-in-place for a returning user).
  createEffect(() => {
    const data = priorities();
    if (data && data.length > 0) {
      const s: Record<string, number> = {}, i: Record<string, number> = {}, h: Record<string, number> = {};
      for (const item of data) {
        s[item.category] = item.satisfaction ?? 5;
        i[item.category] = item.importance ?? 5;
        h[item.category] = item.target_hours_per_week ?? DEFAULT_HOURS[item.category] ?? 10;
      }
      setSatisfactions((p) => ({ ...p, ...s }));
      setImportances((p) => ({ ...p, ...i }));
      setTargetHours((p) => ({ ...p, ...h }));
    }
  });

  // Hydrate the sleep reservation from prefs (rounded to the nearest half-hour/night).
  createEffect(() => {
    const wk = prefs()?.sleep_hours_per_week;
    if (wk != null) setSleepPerNight(Math.round((wk / 7) * 2) / 2);
  });

  const totalAllocatedHours = () => Object.values(targetHours()).reduce((sum, h) => sum + h, 0);
  const remainingHours = () => schedulablePool() - totalAllocatedHours();

  const setSat = (k: string, v: number) => setSatisfactions((p) => ({ ...p, [k]: v }));
  const setImp = (k: string, v: number) => setImportances((p) => ({ ...p, [k]: v }));
  const setHrs = (k: string, v: number) => setTargetHours((p) => ({ ...p, [k]: v }));

  async function handleSave() {
    try {
      const payload: Priority[] = CATEGORIES.map((c) => ({
        category: c.key,
        satisfaction: satisfactions()[c.key] ?? 5,
        importance: importances()[c.key] ?? 5,
        target_hours_per_week: targetHours()[c.key] ?? 0,
      }));
      await api.priorities.save(payload);
      await api.prefs.update({ sleep_hours_per_week: sleepWeek() });
      refetchPriorities();
      refetchPrefs();
      showToast('Life priorities saved', 'success');
      setStep(4);
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  }

  const Slider = (props: { cat: CategoryConfig; label: string; value: () => number; onInput: (v: number) => void }) => {
    const Icon = props.cat.icon;
    return (
      <div class={`p-4 rounded-2xl border ${props.cat.bgClass} flex flex-col gap-3`}>
        <div class="flex items-start gap-3">
          <div class={`p-2 rounded-xl bg-muted ${props.cat.colorClass}`}><Icon class="w-5 h-5" /></div>
          <div>
            <h3 class="text-sm font-bold text-foreground leading-none mb-1">{props.cat.name}</h3>
            <p class="text-[11px] text-muted-foreground leading-snug">{props.cat.description}</p>
          </div>
        </div>
        <div class="flex items-center gap-4 mt-1">
          <input type="range" min="1" max="10" value={props.value()}
            aria-label={`${props.cat.name} ${props.label} (1 to 10)`}
            onInput={(e) => props.onInput(Number(e.currentTarget.value))}
            class="flex-1 accent-accent" />
          <span class="text-sm font-mono font-bold text-accent min-w-[20px] text-right">{props.value()}</span>
        </div>
      </div>
    );
  };

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      <div class="mb-8 text-center">
        <h1 class="text-3xl font-extrabold text-foreground tracking-wide mb-2">Life Balance Wizard</h1>
        <p class="text-sm text-muted-foreground max-w-lg mx-auto">
          Audit your current life setup, clarify what matters most, and align your target weekly focus.
        </p>
      </div>

      {/* Step indicators */}
      <div class="flex items-center justify-between mb-8 max-w-xl mx-auto relative px-2">
        <div class="absolute top-1/2 left-0 right-0 h-0.5 bg-border -translate-y-1/2 z-0" />
        <div class="absolute top-1/2 left-0 h-0.5 bg-accent -translate-y-1/2 z-0 transition-all duration-300"
          style={{ width: `${((step() - 1) / 3) * 100}%` }} />
        <For each={[1, 2, 3, 4]}>
          {(num) => (
            <button
              onClick={() => num < 4 && setStep(num)}
              disabled={num === 4 && step() < 3}
              class="relative z-10 w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs border transition-all duration-200"
              classList={{
                'bg-accent border-accent text-background scale-110': step() === num,
                'bg-accent/20 border-accent text-accent': step() > num,
                'bg-muted border-border text-muted-foreground': step() < num,
              }}
            >
              {step() > num ? <Check class="w-4 h-4 stroke-[3]" /> : num}
            </button>
          )}
        </For>
      </div>

      <div class="card p-6 shadow-lg">
        {/* Step 1 — satisfaction */}
        <Show when={step() === 1}>
          <h2 class="text-xl font-bold text-foreground mb-2">Step 1: Current Satisfaction</h2>
          <p class="text-xs text-muted-foreground mb-6">
            Rate your current satisfaction in each area (1 = not fulfilled, 10 = fully thriving).
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <For each={CATEGORIES}>{(cat) => <Slider cat={cat} label="satisfaction" value={() => satisfactions()[cat.key] ?? 5} onInput={(v) => setSat(cat.key, v)} />}</For>
          </div>
          <div class="flex justify-end gap-3 mt-8">
            <button onClick={() => setStep(2)} class="btn-primary">Next: Desired Focus <ChevronRight class="w-4 h-4 ml-1" /></button>
          </div>
        </Show>

        {/* Step 2 — importance */}
        <Show when={step() === 2}>
          <h2 class="text-xl font-bold text-foreground mb-2">Step 2: Desired Focus</h2>
          <p class="text-xs text-muted-foreground mb-6">
            Rate how important each area is to your vision of a balanced life (1 = low, 10 = essential).
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <For each={CATEGORIES}>{(cat) => <Slider cat={cat} label="importance" value={() => importances()[cat.key] ?? 5} onInput={(v) => setImp(cat.key, v)} />}</For>
          </div>
          <div class="flex justify-between gap-3 mt-8">
            <button onClick={() => setStep(1)} class="btn-secondary"><ChevronLeft class="w-4 h-4 mr-1" /> Back</button>
            <button onClick={() => setStep(3)} class="btn-primary">Next: Weekly Hours <ChevronRight class="w-4 h-4 ml-1" /></button>
          </div>
        </Show>

        {/* Step 3 — target hours */}
        <Show when={step() === 3}>
          <h2 class="text-xl font-bold text-foreground mb-2">Step 3: Weekly Hours Target</h2>
          <p class="text-xs text-muted-foreground mb-4">First reserve sleep, then allocate the rest of the week across categories.</p>

          {/* Sleep — reserved, unschedulable time attributed to Health. */}
          <div class="bg-muted/50 p-4 rounded-2xl border border-border mb-4 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 flex-wrap">
                <Moon class="w-4 h-4 text-accent flex-shrink-0" />
                <span class="text-sm font-bold text-foreground">Sleep</span>
                <span class="text-[11px] text-muted-foreground">reserved for Health · unschedulable</span>
              </div>
              <button type="button" onClick={() => setSleepPerNight(9)} class="text-[11px] text-muted-foreground hover:text-foreground flex-shrink-0">Reset to 9h</button>
            </div>
            <div class="flex items-center gap-4">
              <input type="range" min="4" max="12" step="0.5" value={sleepPerNight()}
                aria-label="Sleep hours per night"
                onInput={(e) => setSleepPerNight(Number(e.currentTarget.value))} class="flex-1 accent-accent" />
              <span class="text-sm font-mono font-bold text-accent whitespace-nowrap min-w-[128px] text-right">
                {sleepPerNight()}h/night · {sleepWeek()}h/wk
              </span>
            </div>
            <div class="text-[11px] text-muted-foreground font-mono">
              {sleepWeek()}h reserved → <b class="text-foreground">{schedulablePool()}h</b> left to schedule this week
            </div>
          </div>

          {/* Schedulable budget = 168 − sleep. */}
          <div class="bg-muted/50 p-4 rounded-2xl border border-border mb-6 flex flex-col gap-2">
            <div class="flex justify-between items-center text-xs font-mono">
              <span class="text-muted-foreground">Allocated: <b class="text-accent">{totalAllocatedHours()}h</b> / {schedulablePool()}h</span>
              <span classList={{ 'text-destructive': remainingHours() < 0, 'text-muted-foreground': remainingHours() >= 0 }}>
                {remainingHours() >= 0 ? `${remainingHours()}h remaining` : `${Math.abs(remainingHours())}h over!`}
              </span>
            </div>
            <div class="h-2 w-full bg-muted rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all duration-300"
                classList={{ 'bg-destructive': remainingHours() < 0, 'bg-accent': remainingHours() >= 0 }}
                style={{ width: `${Math.min(100, schedulablePool() > 0 ? (totalAllocatedHours() / schedulablePool()) * 100 : 0)}%` }} />
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <For each={CATEGORIES}>
              {(cat) => {
                const Icon = cat.icon;
                const val = () => targetHours()[cat.key] ?? 0;
                return (
                  <div class={`p-4 rounded-2xl border ${cat.bgClass} flex flex-col gap-2`}>
                    <div class="flex justify-between items-start gap-3">
                      <div class="flex gap-3 items-center">
                        <div class={`p-1.5 rounded-lg bg-muted ${cat.colorClass}`}><Icon class="w-4 h-4" /></div>
                        <div>
                          <h3 class="text-sm font-bold text-foreground leading-none">{cat.name}</h3>
                          <Show when={cat.key === 'health'}>
                            <span class="text-[10px] text-accent font-mono">+ {sleepWeek()}h sleep reserved</span>
                          </Show>
                        </div>
                      </div>
                      <span class="text-xs text-muted-foreground font-mono">Focus: {importances()[cat.key] ?? 5}/10</span>
                    </div>
                    <div class="flex items-center gap-4 mt-2">
                      <input type="range" min="0" max="80" step="1" value={val()}
                        aria-label={`${cat.name} target hours per week`}
                        onInput={(e) => setHrs(cat.key, Number(e.currentTarget.value))} class="flex-1 accent-accent" />
                      <div class="flex items-center gap-1">
                        <input type="number" min="0" max="168" value={val()}
                          aria-label={`${cat.name} target hours per week (exact)`}
                          onChange={(e) => setHrs(cat.key, Math.max(0, Math.min(168, Number(e.currentTarget.value))))}
                          class="bg-muted border border-border rounded px-1.5 py-0.5 text-xs text-center text-foreground font-mono w-12" />
                        <span class="text-xs text-muted-foreground font-mono">h/wk</span>
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="flex justify-between gap-3 mt-8">
            <button onClick={() => setStep(2)} class="btn-secondary"><ChevronLeft class="w-4 h-4 mr-1" /> Back</button>
            <button onClick={handleSave} class="btn-primary" disabled={remainingHours() < 0}>
              <Save class="w-4 h-4 mr-1.5" /> Save priorities
            </button>
          </div>
        </Show>

        {/* Step 4 — done */}
        <Show when={step() === 4}>
          <div class="text-center py-8">
            <div class="w-16 h-16 bg-accent/20 border border-accent/40 rounded-full flex items-center justify-center mx-auto mb-5 text-accent">
              <Check class="w-8 h-8 stroke-[3]" />
            </div>
            <h2 class="text-2xl font-bold text-foreground mb-2">Life priorities saved</h2>
            <p class="text-sm text-muted-foreground max-w-md mx-auto mb-8">
              Your satisfaction, importance, and weekly-hours targets are recorded. Review how they compare
              in the Balance dashboard — you can edit this audit anytime.
            </p>
            <div class="flex justify-center gap-4">
              <button onClick={() => setStep(1)} class="btn-secondary">Edit audit</button>
              <A href="/balance" class="btn-primary">View Balance dashboard</A>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
