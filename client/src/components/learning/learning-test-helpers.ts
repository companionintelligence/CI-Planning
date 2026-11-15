/**
 * Shared by the Settings → Learning component tests (not shipped: nothing in the app imports it).
 *
 * The trend chart always prints its fixed scale, '0%' and '100%', and a point's hover text can
 * read '0%' for a real zero. Neither is a measurement. A test that asks "does a standalone 0%
 * appear where nothing was measured?" must therefore look at the text WITHOUT the chart, or it
 * fails (or, worse, passes) for the wrong reason. Every test in this folder goes through here,
 * so they all ask the question the same way.
 */

/** A '0%' that is not the tail of another number ('10%', '100%'). */
export const ZERO_PERCENT = /(^|[^0-9])0%/;

/** The element's text with every chart (the svg and its test-id wrapper) taken out. */
export function textWithoutChart(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('svg, [data-testid^="learning-chart"]').forEach((n) => n.remove());
  return clone.textContent ?? '';
}
