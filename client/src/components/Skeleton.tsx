/**
 * A placeholder bar for content that is still loading. The caller sets its size with classes
 * (`h-3 w-1/2`, `h-16`), so it takes the shape of what is coming and the layout does not jump when
 * the data lands. It is hidden from assistive technology; the region it sits in says it is loading
 * with `role="status"` and a line of sr-only text.
 */
export function Skeleton(props: { class?: string }) {
  return <div class={`skeleton block ${props.class ?? ''}`} aria-hidden="true" />;
}
