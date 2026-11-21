import { createEffect, createSignal, onCleanup, type Accessor, type JSX } from 'solid-js';

/** Fixed viewport geometry for a popover opened from a small toolbar trigger. */
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
  const left = Math.max(
    viewportLeft + edge,
    Math.min(rect.right - width, viewportLeft + viewportWidth - width - edge),
  );

  const belowTop = rect.bottom + gap;
  const belowSpace = Math.max(0, viewportTop + viewportHeight - edge - belowTop);
  const aboveSpace = Math.max(0, rect.top - gap - viewportTop - edge);
  const openAbove = belowSpace < Math.min(preferredWidth * 0.55, 280) && aboveSpace > belowSpace;
  let top = openAbove ? rect.top - gap - aboveSpace : belowTop;
  let maxHeight = openAbove ? aboveSpace : belowSpace;

  if (maxHeight < 160) {
    top = viewportTop + edge;
    maxHeight = Math.max(1, viewportHeight - edge * 2);
  }
  top = Math.max(viewportTop + edge, Math.min(top, viewportTop + viewportHeight - edge - 1));
  maxHeight = Math.max(1, Math.min(maxHeight, viewportTop + viewportHeight - edge - top));

  return {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
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
    const element = anchor();
    if (!element) return;

    const update = () => setStyle(positionFor(element, preferredWidth));
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
