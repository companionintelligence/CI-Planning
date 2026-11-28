import { createEffect, createSignal, onCleanup, type Accessor, type JSX } from 'solid-js';

/** Fixed viewport geometry for a popover centered in the canvas below its toolbar trigger. */
function positionFor(anchor: HTMLElement, preferredWidth: number): JSX.CSSProperties {
  const visual = window.visualViewport;
  const viewportLeft = visual?.offsetLeft ?? 0;
  const viewportTop = visual?.offsetTop ?? 0;
  const viewportWidth = visual?.width ?? window.innerWidth;
  const viewportHeight = visual?.height ?? window.innerHeight;
  const edge = 12;
  const gap = 8;
  const width = Math.max(1, Math.min(preferredWidth, viewportWidth - edge * 2));
  const rect = anchor.getBoundingClientRect();
  const left = viewportLeft + (viewportWidth - width) / 2;
  const top = Math.max(viewportTop + edge, Math.min(rect.bottom + gap, viewportTop + viewportHeight - edge - 1));
  const maxHeight = Math.max(1, viewportTop + viewportHeight - edge - top);

  return {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    'max-height': `${maxHeight}px`,
    'overflow-y': 'auto',
    'overscroll-behavior': 'contain',
  };
}

/** Keep the panel within the visible viewport as the page, keyboard, or device rotates. */
export function createAnchoredPopoverStyle(
  open: Accessor<boolean>,
  anchor: Accessor<HTMLElement | undefined>,
  preferredWidth: number,
) {
  const [style, setStyle] = createSignal<JSX.CSSProperties>({});

  createEffect(() => {
    if (!open()) {
      setStyle({});
      return;
    }
    if (!anchor()) return;

    const update = () => {
      const element = anchor();
      if (element) setStyle(positionFor(element, preferredWidth));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    onCleanup(() => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    });
  });

  return style;
}
