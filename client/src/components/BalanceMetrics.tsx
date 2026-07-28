import { createResource, createSignal, For, Show } from 'solid-js';
import { Laugh, Meh, Frown, Zap, TrendingUp, TrendingDown, Minus } from 'lucide-solid';
import { api, type AxisMetrics, type MoodBreakdown } from '../lib/api.js';

/**
 * Balance → Metrics: how the user's tasks actually land across the two axes they think
 * in — DIRECTION (Work / Home / Community) and CATEGORY (the six life priorities).
 *
 * Everything here is measured, never inferred: counts and timed minutes come from real
 * rows, mood comes only from tasks closed with the ritual, and estimate bias is the
 * median actual/estimated with a 3-sample floor. Where there is no data the tile says so
 * rather than rendering a confident zero — an empty axis and a genuinely balanced one
 * must not look the same.
 */

const WINDOWS = [7, 30, 90] as const;

const MOOD_META: { key: keyof MoodBreakdown; icon: typeof Laugh; color: string; label: string }[] = [
  { key: 'happy',      icon: Laugh, color: '#58ebbf', label: 'Good' },
  { key: 'flat',       icon: Meh,   color: '#94a3b8', label: 'Fine' },
  { key: 'frustrated', icon: Frown, color: '#f97316', label: 'Frustrated' },
  { key: 'stressed',   icon: Zap,   color: '#ef4444', label: 'Stressed' },
];

const fmtHours = (min: number) => (min >= 60 ? `${(min / 60).toFixed(1)}h` : `${min}m`);

/** Stacked mood bar — proportions of the reflected completions for one axis value. */
function MoodBar(props: { mood: MoodBreakdown; samples: number }) {
  return (
    <Show
      when={props.samples > 0}
      fallback={<div class="text-[10px] text-muted-foreground italic">no reflections yet</div>}
    >
      <div class="flex h-2 rounded-full overflow-hidden bg-muted">
        <For each={MOOD_META}>
          {(m) => (
            <Show when={props.mood[m.key] > 0}>
              <div
                style={{ width: `${(props.mood[m.key] / props.samples) * 100}%`, background: m.color }}
                title={`${m.label}: ${props.mood[m.key]}`}
              />
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}

function AxisCard(props: { m: AxisMetrics }) {
  const total = () => props.m.open + props.m.completed;
  const pct = () => (total() ? Math.round((props.m.completed / total()) * 100) : 0);
  // >1 means work runs longer than estimated. Under 3 samples the service sends null and
  // we show nothing rather than a number the user would over-read.
  const bias = () => props.m.estimateBias;
  return (
    <div class="card p-4 flex flex-col gap-3">
      <div class="flex items-baseline justify-between gap-2">
        <h4 class="text-sm font-bold text-foreground capitalize truncate">{props.m.name}</h4>
        <span class="text-[10px] text-muted-foreground font-mono flex-shrink-0">
          {props.m.completed} done · {props.m.open} open
        </span>
      </div>

      <div>
        <div class="h-1.5 rounded-full bg-muted overflow-hidden">
          <div class="h-full rounded-full bg-accent transition-all" style={{ width: `${pct()}%` }} />
        </div>
        <div class="text-[10px] text-muted-foreground mt-1">{pct()}% of this area's tasks are finished</div>
      </div>

      <div class="flex items-center gap-3 text-[11px]">
        <span class="text-muted-foreground">
          <span class="font-mono text-foreground">{fmtHours(props.m.actualMinutes)}</span> tracked
        </span>
        <Show when={bias() !== null}>
          <span
            class="inline-flex items-center gap-1"
            title="Median actual ÷ estimated. Above 1 means these take longer than you plan for."
          >
            <Show when={bias()! > 1.15} fallback={
              <Show when={bias()! < 0.85} fallback={<Minus size={11} class="text-muted-foreground" />}>
                <TrendingDown size={11} class="text-emerald-400" />
              </Show>
            }>
              <TrendingUp size={11} class="text-amber-400" />
            </Show>
            <span class="font-mono text-foreground">{bias()!.toFixed(2)}×</span>
            <span class="text-muted-foreground">est</span>
          </span>
        </Show>
      </div>

      <MoodBar mood={props.m.mood} samples={props.m.moodSamples} />
    </div>
  );
}

export function BalanceMetrics() {
  const [days, setDays] = createSignal<number>(30);
  const [metrics] = createResource(days, (d) => api.metrics.tasks(d));
  const [trend] = createResource(() => api.metrics.calibration(90));

  // Readings with a real bias number — a zero-sample day is recorded (so a trend starts
  // where the data does) but has nothing to plot.
  const points = () => (trend()?.readings ?? []).filter((r) => r.bias_ratio != null);
  const first = () => points()[0]?.bias_ratio ?? null;
  const last = () => points()[points().length - 1]?.bias_ratio ?? null;
  /** Improvement = movement TOWARD 1.0 (perfect estimation), in either direction. */
  const improved = () => {
    const a = first(), b = last();
    return a != null && b != null && Math.abs(b - 1) < Math.abs(a - 1);
  };

  return (
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-muted-foreground">
          Completions and tracked time over the last {days()} days. Open counts are current, not windowed.
        </p>
        <div class="inline-flex rounded-lg border border-border overflow-hidden text-[11px] flex-shrink-0">
          <For each={WINDOWS}>
            {(w) => (
              <button
                type="button"
                onClick={() => setDays(w)}
                class="px-2.5 py-1 transition-colors"
                classList={{
                  'bg-accent text-background font-semibold': days() === w,
                  'text-muted-foreground hover:text-foreground': days() !== w,
                }}
              >{w}d</button>
            )}
          </For>
        </div>
      </div>

      <Show when={metrics()} fallback={<div class="card p-6 text-center text-xs text-muted-foreground">Loading metrics…</div>}>
        {(m) => (
          <>
            {/* Totals — computed server-side from the unjoined task set, NOT by summing
                the axes below (a task can carry 0 or 3 categories). */}
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div class="card p-4">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Completed</div>
                <div class="text-2xl font-mono font-extrabold text-foreground">{m().totals.completed}</div>
              </div>
              <div class="card p-4">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Still open</div>
                <div class="text-2xl font-mono font-extrabold text-foreground">{m().totals.open}</div>
              </div>
              <div class="card p-4">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Time tracked</div>
                <div class="text-2xl font-mono font-extrabold text-foreground">{fmtHours(m().totals.actualMinutes)}</div>
              </div>
              <div class="card p-4">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reflections</div>
                <div class="text-2xl font-mono font-extrabold text-foreground">{m().totals.moodSamples}</div>
                <div class="mt-1.5"><MoodBar mood={m().totals.mood} samples={m().totals.moodSamples} /></div>
              </div>
            </div>

            <div>
              <h3 class="text-sm font-bold text-foreground mb-3">Work · Home · Community</h3>
              <Show
                when={m().directions.length > 0}
                fallback={<div class="card p-5 text-xs text-muted-foreground">No tasks carry a direction yet — the Auto-tag button on Tasks fills these in.</div>}
              >
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <For each={m().directions}>{(d) => <AxisCard m={d} />}</For>
                </div>
              </Show>
            </div>

            <div>
              <h3 class="text-sm font-bold text-foreground mb-3">Life priorities</h3>
              <Show
                when={m().categories.length > 0}
                fallback={<div class="card p-5 text-xs text-muted-foreground">No tasks carry a category yet — set them in the Add/Edit wizard.</div>}
              >
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <For each={m().categories}>{(c) => <AxisCard m={c} />}</For>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>

      {/* Estimation trend — the one true "am I improving" line, and the reason
          calibration_history exists (the rollup table only holds today's reading). */}
      <div>
        <h3 class="text-sm font-bold text-foreground mb-3">Estimation over time</h3>
        <Show
          when={points().length >= 2}
          fallback={
            <div class="card p-5 text-xs text-muted-foreground">
              Not enough history yet. Each nightly calibration adds a reading; the trend appears once there are two.
            </div>
          }
        >
          <div class="card p-5 flex flex-col gap-3">
            <div class="flex items-baseline gap-3">
              <span class="text-2xl font-mono font-extrabold text-foreground">{last()!.toFixed(2)}×</span>
              <span class="text-xs text-muted-foreground">
                vs {first()!.toFixed(2)}× {points().length} readings ago
              </span>
              <span
                class="ml-auto text-[11px] font-medium"
                classList={{ 'text-emerald-400': improved(), 'text-amber-400': !improved() }}
              >
                {improved() ? 'closer to accurate' : 'drifting from accurate'}
              </span>
            </div>
            {/* Sparkline: bias ratios normalised around 1.0. Pure SVG — no chart lib. */}
            {(() => {
              const ps = points();
              const vals = ps.map((r) => r.bias_ratio!);
              const lo = Math.min(...vals, 1), hi = Math.max(...vals, 1);
              const span = hi - lo || 1;
              const x = (i: number) => (i / Math.max(1, ps.length - 1)) * 100;
              const y = (v: number) => 100 - ((v - lo) / span) * 100;
              const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
              return (
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-16" role="img" aria-label="Estimate bias over time">
                  {/* the 1.0 "perfect estimate" reference line */}
                  <line x1="0" y1={y(1)} x2="100" y2={y(1)} stroke="currentColor" class="text-muted-foreground" stroke-width="0.5" stroke-dasharray="2 2" />
                  <path d={d} fill="none" stroke="currentColor" class="text-accent" stroke-width="1.5" vector-effect="non-scaling-stroke" />
                </svg>
              );
            })()}
            <div class="text-[10px] text-muted-foreground">
              Median actual ÷ estimated per nightly reading. The dashed line is a perfect estimate; above it you run long.
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
