import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import type { ChartPoint } from '../../lib/learning-chart.js';
import { layoutTrend } from '../../lib/learning-chart.js';
import { TrendChart, chartLabel } from './TrendChart.js';

/**
 * TrendChart draws what layoutTrend (lib/learning-chart.ts, tested on its own) hands it. This
 * file checks the drawing: the right marks for the right readings, a name a screen reader can
 * use, the fixed 0 to 100 percent scale, and no colour literal. jsdom cannot see geometry or
 * paint, so dot size and the hollow fill in dark mode are a job for a real browser.
 */

const point = (date: string, value: number | null, n: number): ChartPoint => ({
  date,
  value,
  n,
  label: value === null ? `${date}: not measured` : `${date}: ${Math.round(value * n)} of ${n}`,
});

function draw(points: ChartPoint[], extra: Partial<Parameters<typeof TrendChart>[0]> = {}) {
  render(() => <TrendChart title="Motivation (me, us, them)" points={points} cadenceDays={7} testId="chart" {...extra} />);
  const wrapper = screen.getByTestId('chart');
  const svg = wrapper.querySelector('svg')!;
  return {
    wrapper,
    svg,
    circles: () => [...svg.querySelectorAll('circle')],
    hollow: () => svg.querySelectorAll('circle[data-hollow]'),
    paths: () => [...svg.querySelectorAll('path')],
    dashedPaths: () => svg.querySelectorAll('path[data-dashed]'),
    ticks: () => svg.querySelectorAll('[data-tick]'),
    marker: () => svg.querySelector('[data-marker]'),
    legend: () => wrapper.querySelector('[data-marker-legend]'),
    texts: () => [...svg.querySelectorAll('text')].map((t) => t.textContent),
  };
}

const WEEKS = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];

describe('TrendChart: the accessible name', () => {
  it('is role="img" with a label that counts the readings, gives the dates and states the latest value', () => {
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[1], 0.75, 12), point(WEEKS[3], 0.6, 20)]);
    expect(c.svg.getAttribute('role')).toBe('img');
    const label = c.svg.getAttribute('aria-label')!;
    expect(label).toContain('Motivation (me, us, them)');
    expect(label).toContain('3 readings from Oct 5 to Oct 26');
    expect(label).toContain('0 to 100 percent');
    expect(label).toContain('Latest reading 2026-10-26: 12 of 20.');
  });

  it('says the latest reading was not measured, and gives no number for it', () => {
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], null, 0)]);
    const label = c.svg.getAttribute('aria-label')!;
    expect(label).toContain('Latest reading not measured.');
    expect(label).not.toMatch(/Latest reading 2026/);
  });

  it('points to the table of readings as the text alternative', () => {
    const c = draw([point(WEEKS[0], 0.5, 12)]);
    expect(c.svg.getAttribute('aria-label')).toContain('The table of readings below has every value.');
  });

  it('reads right for one reading, and for none', () => {
    expect(chartLabel('Rate', [point(WEEKS[0], 0.5, 12)])).toContain('1 reading on Oct 5');
    expect(chartLabel('Rate', [])).toBe('Rate: no readings to plot.');
    expect(chartLabel('Rate', [point('garbled', 0.5, 12)])).toBe('Rate: no readings to plot.');
  });

  it('sorts by date, so the label does not depend on the order it was given', () => {
    const shuffled = [point(WEEKS[3], 0.6, 20), point(WEEKS[0], 0.5, 12), point(WEEKS[1], 0.75, 12)];
    expect(chartLabel('Rate', shuffled)).toContain('3 readings from Oct 5 to Oct 26');
    expect(chartLabel('Rate', shuffled)).toContain('Latest reading 2026-10-26');
  });

  it('puts the test id on the wrapper, so a test or a caller can find the chart', () => {
    expect(draw([point(WEEKS[0], 0.5, 12)]).wrapper.getAttribute('data-testid')).toBe('chart');
  });
});

describe('TrendChart: what is drawn for each kind of reading', () => {
  it('a hollow dot for each measured reading under 10 cases, and a filled one from 10', () => {
    const c = draw([point(WEEKS[0], 0.5, 9), point(WEEKS[1], 0.5, 10), point(WEEKS[2], 0.75, 4), point(WEEKS[3], 0.9, 30)]);
    expect(c.circles()).toHaveLength(4);
    expect(c.hollow()).toHaveLength(2);
    // Hollow is filled with the card colour (so the line does not show through), filled with the stroke.
    for (const el of c.hollow()) expect((el as SVGElement).style.fill).toBe('var(--card)');
    const filled = c.circles().filter((el) => !el.hasAttribute('data-hollow'));
    for (const el of filled) expect(el.getAttribute('fill')).toBe('currentColor');
  });

  it('a reading that measured nothing is a dashed tick and never a circle', () => {
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[1], null, 0), point(WEEKS[2], 0.5, 12)]);
    expect(c.ticks()).toHaveLength(1);
    expect(c.circles()).toHaveLength(2);
    expect(c.ticks()[0].querySelector('line')!.getAttribute('stroke-dasharray')).toBeTruthy();
    // The tick can be read: its hover text says "not measured".
    expect(c.ticks()[0].querySelector('title')!.textContent).toContain('not measured');
  });

  it('a not-measured tick is short and stands on the baseline, so it cannot be taken for the full-height marker line', () => {
    const layout = layoutTrend([point(WEEKS[0], 0.5, 12), point(WEEKS[1], null, 0), point(WEEKS[3], 0.6, 12)], {
      cadenceDays: 7,
      marker: { date: WEEKS[3], text: 'M' },
    });
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[1], null, 0), point(WEEKS[3], 0.6, 12)], {
      marker: { date: WEEKS[3], text: 'M' },
    });
    const tick = c.ticks()[0].querySelector('line')!;
    const markerLine = c.marker()!;
    const plotH = layout.plot.bottom - layout.plot.top;
    expect(Number(tick.getAttribute('y2'))).toBe(layout.plot.bottom);
    expect(Number(tick.getAttribute('y2')) - Number(tick.getAttribute('y1'))).toBeLessThan(plotH / 2);
    expect(Number(markerLine.getAttribute('y2')) - Number(markerLine.getAttribute('y1'))).toBe(plotH);
  });

  it('a real zero is a dot on the bottom line; a null is not a dot at all', () => {
    const layout = layoutTrend([point(WEEKS[0], 0, 12), point(WEEKS[1], null, 0)], { cadenceDays: 7 });
    const c = draw([point(WEEKS[0], 0, 12), point(WEEKS[1], null, 0)]);
    expect(c.circles()).toHaveLength(1);
    expect(Number(c.circles()[0].getAttribute('cy'))).toBe(layout.plot.bottom);
    expect(c.ticks()).toHaveLength(1);
  });

  it('a line only joins neighbouring measured readings, and breaks at a null', () => {
    const joined = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[1], 0.6, 12), point(WEEKS[2], 0.7, 12), point(WEEKS[3], 0.8, 12)]);
    expect(joined.paths()).toHaveLength(1); // four weekly filled points are one solid segment
  });

  it('a dashed segment appears only next to a hollow dot', () => {
    const solid = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[1], 0.6, 12)]);
    expect(solid.paths()).toHaveLength(1);
    expect(solid.dashedPaths()).toHaveLength(0);
  });

  it('a hollow dot makes its segment dashed', () => {
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[1], 0.6, 4)]);
    expect(c.dashedPaths()).toHaveLength(1);
    expect(c.dashedPaths()[0].getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('a missing week (a gap in the dates, no row) is a break in the line, not a tick', () => {
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.6, 12)]); // three weeks apart
    expect(c.paths()).toHaveLength(0);
    expect(c.circles()).toHaveLength(2);
    expect(c.ticks()).toHaveLength(0);
  });

  it('a lone reading is one dot, no line', () => {
    const c = draw([point(WEEKS[2], 0.5, 12)]);
    expect(c.circles()).toHaveLength(1);
    expect(c.paths()).toHaveLength(0);
  });

  it('each dot carries its counts as hover text', () => {
    const c = draw([point(WEEKS[0], 0.5, 12)]);
    expect(c.circles()[0].querySelector('title')!.textContent).toBe('2026-10-05: 6 of 12');
  });

  it('draws nothing but the scale for no readings, and prints no NaN', () => {
    const c = draw([]);
    expect(c.circles()).toHaveLength(0);
    expect(c.paths()).toHaveLength(0);
    expect(c.svg.outerHTML).not.toContain('NaN');
  });

  it('never plots a corrupt value: out of range becomes a tick, not a clamped dot', () => {
    // Labels are fixed text here so a NaN could only come from the geometry.
    const bad = (date: string, value: number): ChartPoint => ({ date, value, n: 12, label: `${date}: unreadable` });
    const c = draw([bad(WEEKS[0], 1.4), bad(WEEKS[1], Number.NaN)]);
    expect(c.circles()).toHaveLength(0);
    expect(c.ticks()).toHaveLength(2);
    expect(c.svg.outerHTML).not.toContain('NaN');
  });
});

describe('TrendChart: the scale', () => {
  it('always prints 0% and 100%, with data, with none, and with only nulls', () => {
    for (const points of [[], [point(WEEKS[0], 0.5, 12)], [point(WEEKS[0], null, 0)]]) {
      const { texts } = draw(points);
      expect(texts()).toContain('0%');
      expect(texts()).toContain('100%');
      document.body.innerHTML = '';
    }
  });

  it('puts a 3-of-4 reading and a 4-of-4 reading at their true heights, not stretched to fill the box', () => {
    const layout = layoutTrend([point(WEEKS[0], 0.75, 4), point(WEEKS[1], 0.75, 4)], { cadenceDays: 7 });
    const c = draw([point(WEEKS[0], 0.75, 4), point(WEEKS[1], 0.75, 4)]);
    const expected = layout.plot.bottom - 0.75 * (layout.plot.bottom - layout.plot.top);
    for (const el of c.circles()) expect(Number(el.getAttribute('cy'))).toBeCloseTo(expected, 1);
  });

  it('labels the first and last date', () => {
    const { texts } = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.5, 12)]);
    expect(texts()).toContain('Oct 5');
    expect(texts()).toContain('Oct 26');
  });

  it('anchors the first date at its start and the last at its end, so neither is clipped at the chart edge', () => {
    const { svg } = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.5, 12)]);
    const dateText = (t: string) => [...svg.querySelectorAll('text')].find((e) => e.textContent === t)!;
    expect(dateText('Oct 5').getAttribute('text-anchor')).toBe('start');
    expect(dateText('Oct 26').getAttribute('text-anchor')).toBe('end');
    // The y labels hang off the left edge of the plot, so they end where the plot begins.
    expect(dateText('100%').getAttribute('text-anchor')).toBe('end');
    expect(dateText('0%').getAttribute('text-anchor')).toBe('end');
  });

  it('centres the date when there is only one reading', () => {
    const { svg } = draw([point(WEEKS[1], 0.5, 12)]);
    const only = [...svg.querySelectorAll('text')].filter((e) => e.textContent === 'Oct 12');
    expect(only).toHaveLength(1);
    expect(only[0].getAttribute('text-anchor')).toBe('middle');
  });

  it('centres the date when every reading has the same date', () => {
    const { svg } = draw([point(WEEKS[1], 0.5, 12), point(WEEKS[1], 0.7, 12)]);
    const only = [...svg.querySelectorAll('text')].filter((e) => e.textContent === 'Oct 12');
    expect(only).toHaveLength(1);
    expect(only[0].getAttribute('text-anchor')).toBe('middle');
  });
});

describe('TrendChart: the marker', () => {
  it('draws a dashed line, and its words in a legend under the chart, when given a date inside the range', () => {
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.6, 12)], {
      marker: { date: WEEKS[2], text: 'Examples stored by Oct 19' },
    });
    expect(c.marker()).not.toBeNull();
    expect(c.marker()!.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(c.legend()!.textContent).toBe('Examples stored by Oct 19');
    // The words are outside the SVG, so they cannot land on the line or the dots.
    expect(c.svg.contains(c.legend())).toBe(false);
    expect(c.texts()).not.toContain('Examples stored by Oct 19');
  });

  it('draws nothing for no marker, and nothing for a date outside the plotted range', () => {
    expect(draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.6, 12)]).marker()).toBeNull();
    document.body.innerHTML = '';
    const out = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[1], 0.6, 12)], { marker: { date: '2026-12-01', text: 'Later' } });
    expect(out.marker()).toBeNull();
    expect(out.legend()).toBeNull();
    expect(out.wrapper.textContent).not.toContain('Later');
  });

  it('hides the legend glyph from a screen reader, so the words are read once', () => {
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.6, 12)], { marker: { date: WEEKS[1], text: 'Early' } });
    const glyph = c.legend()!.querySelector('svg')!;
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(c.legend()!.textContent).toBe('Early');
  });

  it('puts the words in the same place whichever side of the middle the line is on', () => {
    for (const date of [WEEKS[0], WEEKS[3]]) {
      document.body.innerHTML = '';
      const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.6, 12)], { marker: { date, text: 'Stored' } });
      expect(c.legend()!.textContent).toBe('Stored');
      expect(c.svg.querySelectorAll('tspan')).toHaveLength(0);
    }
  });
});

describe('TrendChart: paint', () => {
  const all = () =>
    draw(
      [point(WEEKS[0], 0.5, 12), point(WEEKS[1], null, 0), point(WEEKS[2], 0.75, 4), point(WEEKS[3], 0.9, 30)],
      { marker: { date: WEEKS[2], text: 'Marker' } },
    ).wrapper.outerHTML;

  it('uses no colour literal: no hex, no rgb(), no hsl(', () => {
    const html = all();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgba?\(/i);
    expect(html).not.toMatch(/hsla?\(/i);
  });

  it('uses no brand or status colour class: nothing here is good or bad', () => {
    const html = all();
    expect(html).not.toMatch(/emerald|amber|red-|green-|rose|lime|orange/);
  });

  it('paints with the theme: currentColor, and the primary and muted text classes only', () => {
    const html = all();
    expect(html).toContain('currentColor');
    expect(html).toContain('text-primary');
    expect(html).toContain('text-muted-foreground');
    expect(html).toContain('var(--card)');
  });

  it('is a fixed-size viewBox that scales down, so a phone does not scroll sideways', () => {
    const c = draw([point(WEEKS[0], 0.5, 12)]);
    expect(c.svg.getAttribute('viewBox')).toBe('0 0 260 84');
    expect(c.svg.getAttribute('class')).toContain('w-full');
    // Capped at its own width, so one user unit is about one pixel and the labels keep their size.
    expect(c.svg.getAttribute('class')).toContain('max-w-[260px]');
    expect(c.svg.getAttribute('width')).toBeNull();
  });

  it('keeps every label readable at phone width: at least 9 px even on a 320 px phone', () => {
    // The card leaves about 214 px for the chart on a 320 px phone and about 254 px on a 360 px one.
    // A 320-wide box with 9-unit labels printed them at 6 to 7 px there.
    const c = draw([point(WEEKS[0], 0.5, 12), point(WEEKS[3], 0.6, 12)], { marker: { date: WEEKS[2], text: 'Marker' } });
    const width = Number(c.svg.getAttribute('viewBox')!.split(' ')[2]);
    const sizes = new Set<number>();
    for (const el of c.svg.querySelectorAll('[font-size]')) sizes.add(Number(el.getAttribute('font-size')));
    expect(sizes.size).toBeGreaterThan(0);
    for (const size of sizes) {
      expect((size * Math.min(214, width)) / width, `font-size ${size}`).toBeGreaterThanOrEqual(9);
      expect((size * Math.min(254, width)) / width, `font-size ${size}`).toBeGreaterThanOrEqual(10);
    }
    // And the chart never renders larger than its own box, so desktop labels are not blown up either.
    expect(c.svg.getAttribute('class')).toContain(`max-w-[${width}px]`);
  });
});
