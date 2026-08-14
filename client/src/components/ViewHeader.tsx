import { Show, type JSX } from 'solid-js';

/**
 * The one view header (drawer-layout mockup): title, optional subtitle, actions
 * ranged right. Every view renders this instead of a hand-rolled h1 — the five
 * different title treatments this replaced were the mockup mismatch.
 */
export function ViewHeader(props: { title: string; sub?: JSX.Element | string; children?: JSX.Element }) {
  return (
    <div class="view-head">
      <div class="min-w-0">
        <h1 class="view-title">{props.title}</h1>
        <Show when={props.sub}><p class="view-sub">{props.sub}</p></Show>
      </div>
      <Show when={props.children}><div class="view-actions">{props.children}</div></Show>
    </div>
  );
}
