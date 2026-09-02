import { createResource, createSignal, For, Show } from 'solid-js';
import { TrendingUp, TrendingDown, Minus } from 'lucide-solid';
import { api, type AxisMetrics, type MetricsGroup, type ScoreDistribution } from '../lib/api.js';
import { TrialityMetricsTiles } from './TrialityMetricsTiles.js';

/**
 * Balance → Metrics: how the user's tasks actually land across the two axes they think
 * in — DIRECTION (Work / Home / Community) and CATEGORY (the six life priorities).
 *
 * Everything here is measured, never inferred: counts and timed minutes come from real
 * rows, ratings come only from tasks closed with the ritual, and estimate bias is the
 * median actual/estimated with a 3-sample floor. Where there is no data the tile says so
 * rather than rendering a confident zero — an empty axis and a genuinely balanced one
 * must not look the same.
 *
 * TASKS and HABITS are reported as two separate sections over disjoint populations
 * (0161). Blending them would let a daily habit's twenty ratings drown out five one-off
 * tasks and make the mean read as "how my habits feel" while labelled "how my work feels".
 */

const WINDOWS = [7, 30, 90] as const;

/** 1-5, worst → best. The ramp is the scale, so the colours are ordered, not categorical. */
const SCORE_META: { key: 1 | 2 | 3 | 4 | 5; color: string; label: string }[] = [
  { key: 1, color: '#ef4444', label: '1 — bad' },
  { key: 2, color: '#f97316', label: '2' },
  { key: 3, color: '#94a3b8', label: '3 — fine' },
  { key: 4, color: '#5eead4', label: '4' },
  { key: 5, color: '#58ebbf', label: '5 — good' },
];

const fmtHours = (min: number) => (min >= 60 ? `${(min / 60).toFixed(1)}h` : `${min}m`);

/** Stacked 1-5 bar — proportions of the rated completions for one axis value. */
function ScoreBar(props: { score: ScoreDistribution }) {
  const d = () => props.score;
  return (
    <Show
      when={d().samples > 0}
      fallback={
        <div class="text-[10px] text-muted-foreground italic">
          {/* Declines are worth surfacing: "asked 8 times, answered none" is a finding
              about the prompt, and it must not look identical to "never asked". */}
          <Show when={d().declined > 0} fallback="no ratings yet">
            no ratings yet — {d().declined} skipped
          </Show>
        </div>
      }
    >
      <div class="flex items-center gap-2">
        <div class="flex h-2 rounded-full overflow-hidden bg-muted flex-1">
          <For each={SCORE_META}>
            {(m) => (
              <Show when={d().counts[m.key] > 0}>
                <div
                  style={{ width: `${(d().counts[m.key] / d().samples) * 100}%`, background: m.color }}
                  title={`${m.label}: ${d().counts[m.key]}`}
                />
              </Show>
            )}
          </For>
        </div>
        <Show when={d().mean !== null}>
          <span class="text-[10px] font-mono text-foreground flex-shrink-0" title={`Mean of ${d().samples} ratings`}>
            {d().mean!.toFixed(1)}
          </span>
        </Show>
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
          <Show when={props.m.cancelled > 0}>{' '}· {props.m.cancelled} cancelled</Show>
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

      <ScoreBar score={props.m.score} />
    </div>
  );
}

/**
 * One population's numbers: totals, then the two axes. Rendered once for tasks and once
 * for habits — identical shape so the two are directly comparable at a glance.
 */
function GroupSection(props: { group: MetricsGroup; label: string }) {
  const g = () => props.group;
  return (
    <>
      <div>
        <h3 class="text-sm font-bold text-foreground mb-3">{props.label}</h3>
        {/* Totals — computed server-side from the unjoined task set, NOT by summing
            the axes below (a task can carry 0 or 3 categories). */}
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <div class="card p-4">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Completed</div>
            <div class="text-2xl font-mono font-extrabold text-foreground">{g().totals.completed}</div>
          </div>
          <div class="card p-4">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Still open</div>
            <div class="text-2xl font-mono font-extrabold text-foreground">{g().totals.open}</div>
          </div>
          {/* Scheduled, then given up on. Kept out of both Completed and Still open —
              it is neither, and folding it into either would overstate that number. */}
          <div class="card p-4">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Cancelled</div>
            <div class="text-2xl font-mono font-extrabold text-foreground">{g().totals.cancelled}</div>
            <div class="text-[10px] text-muted-foreground mt-1">scheduled, not done</div>
          </div>
          <div class="card p-4">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Time tracked</div>
            <div class="text-2xl font-mono font-extrabold text-foreground">{fmtHours(g().totals.actualMinutes)}</div>
          </div>
          <div class="card p-4">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Rated</div>
            <div class="text-2xl font-mono font-extrabold text-foreground">{g().totals.score.samples}</div>
            <div class="mt-1.5"><ScoreBar score={g().totals.score} /></div>
          </div>
        </div>
      </div>

      <div>
        <h4 class="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Work · Home · Community</h4>
        <Show
          when={g().directions.length > 0}
          fallback={<div class="card p-5 text-xs text-muted-foreground">Nothing carries a direction yet — the Auto-tag button on Tasks fills these in.</div>}
        >
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <For each={g().directions}>{(d) => <AxisCard m={d} />}</For>
          </div>
        </Show>
      </div>

      <div>
        <h4 class="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Life priorities</h4>
        <Show
          when={g().categories.length > 0}
          fallback={<div class="card p-5 text-xs text-muted-foreground">Nothing carries a category yet — set them in the Add/Edit wizard.</div>}
        >
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <For each={g().categories}>{(c) => <AxisCard m={c} />}</For>
          </div>
        </Show>
      </div>
    </>
  );
}

export function BalanceMetrics() {
  const [days, setDays] = createSignal<number>(30);
  const [metrics] = createResource(days, (d) => api.metrics.tasks(d));
  // Triality tiles (design §9.2) ride the same window control; the component
  // self-gates on the flag and renders nothing when off.
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
          {/* The windowing is genuinely mixed, so say so rather than let one clause imply
              it covers all four tiles. Cancelled is windowed on the slot the work held,
              which is what puts it in the same period as the completions beside it. */}
          Completions, cancellations and tracked time over the last {days()} days. Open counts are current, not windowed.
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
            <GroupSection group={m()} label="Tasks" />
            {/* Habits: same rollup, disjoint population. Hidden entirely when the owner
                keeps no habits — an empty section would read as "your habits are going
                badly" rather than "you have none". */}
            <Show when={m().habits.totals.completed > 0 || m().habits.totals.open > 0}>
              <div class="border-t border-border pt-6">
                <GroupSection group={m().habits} label="Habits" />
              </div>
            </Show>
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

      {/* Triality measurement tiles (design §9.2) — flag-gated inside; the window
          buttons above drive them through the same `days` signal. */}
      <TrialityMetricsTiles days={days()} />
    </div>
  );
}
