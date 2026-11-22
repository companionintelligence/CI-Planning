import { onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

/** Render screen-level UI outside route scrollers and keep it inside iOS's
 * currently visible viewport (which can shrink or pan when the keyboard opens). */
export function ViewportOverlay(props: JSX.HTMLAttributes<HTMLDivElement>) {
  let overlay: HTMLDivElement | undefined;

  onMount(() => {
    const viewport = window.visualViewport;
    const update = () => {
      if (!overlay) return;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      Object.assign(overlay.style, {
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        maxHeight: `${height}px`,
      });
    };

    update();
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    onCleanup(() => {
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    });
  });

  return (
    <Portal>
      <div {...props} ref={overlay} />
    </Portal>
  );
}
