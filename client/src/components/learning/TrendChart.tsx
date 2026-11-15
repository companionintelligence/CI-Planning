import { createMemo, For, Show } from 'solid-js';
import { shortDate } from '../../lib/dates.js';
import { layoutTrend, type ChartPoint } from '../../lib/learning-chart.js';

/**
 * Settings → Learning: the trend chart. A small SVG, no chart library.
 *
 * All geometry comes from layoutTrend (lib/learning-chart.ts), which is where the honesty
 * rules live and are tested: a fixed 0 to 100 percent scale, x placed by calendar date, a
 * hollow dot for thin evidence, a dashed tick for a reading that measured nothing, and a
 * break in the line for a week with no reading. This file only draws what it is given.
 *
 * Paint is currentColor plus the existing text classes, so the chart follows the theme in
 * light and dark: no hex, no rgb(), and no red or green, because nothing here is good or
 * bad. A hollow dot is filled with the card colour so the line does not show through it.
 *
 * Size: the viewBox is the size the chart is drawn at (DEFAULT_WIDTH in learning-chart.ts) and
 * the rendered width is capped at it, so one user unit is about one pixel on a desktop and a
 * phone scales it down by only a fifth. Labels are 11 units, so they stay readable; a box
 * 320 or 448 wide, scaled to a phone, would have printed them at 6 or 7 px.
 *
 * Accessibility: the SVG is role="img" with a label that says how many readings there are,
 * over what dates, and what the latest one was. The chart is not the only way to read the
 * numbers: the "Show the readings" table next to it has every value, and the label says so.
 */

export interface TrendChartProps {
  /** What is plotted, for the accessible name: 'Motivation (me, us, them)'. */
  title: string;
  points: ChartPoint[];
  cadenceDays: number;
  marker?: { date: string; text: string } | null;
  /** Goes on the wrapper, so a test (or a caller) can find the chart. */
  testId: string;
}

/** The accessible name. Exported for the tests. */
export function chartLabel(title: string, points: ChartPoint[]): string {
  const dated = points
    .filter((p) => shortDate(p.date) !== '')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (dated.length === 0) return `${title}: no readings to plot.`;
  const first = shortDate(dated[0].date);
  const last = dated[dated.length - 1];
  const count = `${dated.length} ${dated.length === 1 ? 'reading' : 'readings'}`;
  const span = dated.length === 1 ? `on ${first}` : `from ${first} to ${shortDate(last.date)}`;
  const latest = last.value === null ? 'Latest reading not measured.' : `Latest reading ${last.label}.`;
  return `${title}: ${count} ${span}, on a scale of 0 to 100 percent. ${latest} The table of readings below has every value.`;
}

const LABEL_SIZE = 11;
/** How much of the plot height a not-measured tick covers. */
const TICK_FRACTION = 0.4;
const LABEL_SIZE_ATTR = String(LABEL_SIZE);

export function TrendChart(props: TrendChartProps) {
  const layout = createMemo(() =>
    layoutTrend(props.points, { cadenceDays: props.cadenceDays, marker: props.marker ?? null }),
  );
  const label = createMemo(() => chartLabel(props.title, props.points));

  return (
    <div data-testid={props.testId} class="text-primary">
      <svg
        role="img"
        aria-label={label()}
        viewBox={`0 0 ${layout().width} ${layout().height}`}
        class="w-full h-auto max-w-[260px]"
      >
        {/* The fixed scale: 0 and 100 percent, drawn whatever the data does. */}
        <g class="text-muted-foreground" stroke="currentColor" stroke-opacity="0.35" stroke-width="1">
          <For each={layout().yLabels}>
            {(y) => <line x1={layout().plot.left} x2={layout().plot.right} y1={y.y} y2={y.y} />}
          </For>
        </g>
        <g class="text-muted-foreground" fill="currentColor" font-size={LABEL_SIZE_ATTR}>
          <For each={layout().yLabels}>
            {(y) => (
              <text x={layout().plot.left - 5} y={y.y + 4} text-anchor="end">
                {y.text}
              </text>
            )}
          </For>
          <For each={layout().xLabels}>
            {(x, i) => (
              <text
                x={x.x}
                y={layout().height - 4}
                text-anchor={layout().xLabels.length === 1 ? 'middle' : i() === 0 ? 'start' : 'end'}
              >
                {x.text}
              </text>
            )}
          </For>
        </g>

        {/* A marker line is a dated fact about the data, never a claim about cause. Its words
            sit in the legend under the chart, not in the plot: a label drawn in the plot lands
            on the line or the dots whatever side it is put on. */}
        <Show when={layout().marker}>
          {(m) => (
            <line
              class="text-muted-foreground"
              x1={m().x}
              x2={m().x}
              y1={layout().plot.top}
              y2={layout().plot.bottom}
              stroke="currentColor"
              stroke-dasharray="2 3"
              stroke-width="1"
              data-marker=""
            />
          )}
        </Show>

        {/* A reading that exists but measured nothing: a short dashed tick standing on the
            baseline, never a dot at 0. It is short on purpose: a marker line runs the full
            height, and the two must not be mistaken for each other. */}
        <For each={layout().ticks}>
          {(t) => (
            <g class="text-muted-foreground" data-tick="">
              <line
                x1={t.x}
                x2={t.x}
                y1={layout().plot.bottom - TICK_FRACTION * (layout().plot.bottom - layout().plot.top)}
                y2={layout().plot.bottom}
                stroke="currentColor"
                stroke-width="1"
                stroke-dasharray="3 3"
              />
              <title>{t.label}</title>
            </g>
          )}
        </For>

        <For each={layout().segments}>
          {(s) => (
            <path
              d={s.d}
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-dasharray={s.dashed ? '4 3' : undefined}
              data-dashed={s.dashed ? '' : undefined}
            />
          )}
        </For>

        <For each={layout().dots}>
          {(d) => (
            <circle
              cx={d.x}
              cy={d.y}
              r="3.5"
              stroke="currentColor"
              stroke-width="1.5"
              style={d.hollow ? { fill: 'var(--card)' } : undefined}
              fill={d.hollow ? undefined : 'currentColor'}
              data-hollow={d.hollow ? '' : undefined}
            >
              <title>{d.label}</title>
            </circle>
          )}
        </For>
      </svg>
      <Show when={layout().marker}>
        {(m) => (
          <p class="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground" data-marker-legend="">
            <svg aria-hidden="true" width="8" height="12" viewBox="0 0 8 12" class="shrink-0">
              <line x1="4" x2="4" y1="0" y2="12" stroke="currentColor" stroke-dasharray="2 3" stroke-width="1" />
            </svg>
            {m().text}
          </p>
        )}
      </Show>
    </div>
  );
}
