import { createEffect, createSignal, type JSX } from 'solid-js';
import { ChevronLeft } from 'lucide-solid';

type DockableFabProps = {
  name: string;
  storageKey: string;
  position: string;
  icon: JSX.Element;
  onOpen: () => void;
  title?: string;
  initiallyDocked?: () => boolean;
};

const TAB_WIDTH = 15;

export function DockableFab(props: DockableFabProps) {
  const [docked, setDocked] = createSignal(
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(props.storageKey) === 'docked'
        || (localStorage.getItem(props.storageKey) === null && (props.initiallyDocked?.() ?? false))
      : props.initiallyDocked?.() ?? false,
  );
  const [dragOffset, setDragOffset] = createSignal<number | null>(null);
  let start: { x: number; y: number; pointerId: number } | undefined;
  let dragged = false;
  let suppressClick = false;

  const setDockedAndSave = (value: boolean) => {
    setDocked(value);
    localStorage.setItem(props.storageKey, value ? 'docked' : 'open');
  };

  // Dense mobile routes can request a docked default. A saved user preference
  // always wins; once the user expands or docks the button, persist that choice.
  createEffect(() => {
    if (typeof localStorage === 'undefined' || localStorage.getItem(props.storageKey) !== null) return;
    setDocked(props.initiallyDocked?.() ?? false);
  });

  const onPointerDown: JSX.EventHandler<HTMLButtonElement, PointerEvent> = (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    dragged = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove: JSX.EventHandler<HTMLButtonElement, PointerEvent> = (event) => {
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!dragged && (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2)) return;
    dragged = true;
    const openRight = parseFloat(getComputedStyle(event.currentTarget).right);
    const dockOffset = event.currentTarget.getBoundingClientRect().width + openRight - TAB_WIDTH;
    setDragOffset(Math.max(0, Math.min(dockOffset, (docked() ? dockOffset : 0) + dx)));
  };

  const onPointerUp: JSX.EventHandler<HTMLButtonElement, PointerEvent> = (event) => {
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    if (dragged) {
      if (dx > 40) setDockedAndSave(true);
      if (dx < -40) setDockedAndSave(false);
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 350);
    }
    start = undefined;
    dragged = false;
    setDragOffset(null);
  };

  return (
    <button
      type="button"
      class={`fab dockable-fab ${props.position}`}
      classList={{ 'dockable-fab-docked': docked(), 'dockable-fab-dragging': dragOffset() !== null }}
      style={{ transform: dragOffset() === null
        ? (docked() ? `translateX(calc(100% + 1.5rem - ${TAB_WIDTH}px))` : 'translateX(0)')
        : `translateX(${dragOffset()}px)` }}
      aria-label={docked() ? `Show ${props.name}` : props.name}
      title={docked() ? `Show ${props.name}` : props.title ?? props.name}
      aria-description={docked() ? 'Swipe left to show the button' : 'Swipe right to dock the button'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start = undefined; dragged = false; setDragOffset(null); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') { event.preventDefault(); setDockedAndSave(true); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); setDockedAndSave(false); }
      }}
      onClick={(event) => {
        if (suppressClick) { event.preventDefault(); return; }
        if (docked()) setDockedAndSave(false);
        else props.onOpen();
      }}
    >
      {docked() ? <ChevronLeft size={12} aria-hidden="true" /> : props.icon}
    </button>
  );
}
