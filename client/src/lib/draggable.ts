/**
 * Minimal pointer-based DnD for cross-component drag-and-drop (PR-C+, Phase E).
 *
 * Why pointer events, not HTML5 draggable: the rest of the app drives gestures
 * with `pointerdown`/`move`/`up` (see `lib/drag.ts`, `useBlockDrag`). Sharing
 * that paradigm means a single capture model, no native ghost image quirks,
 * and easy interop with the Planner's click-vs-drag thresholds.
 *
 * Model:
 *  - A global `dragPayload` signal holds whatever the active drag carries
 *    ({kind, id}). Drop targets read it on pointerup-within-bounds.
 *  - `useDraggable({ kind, id })` returns a `onPointerDown` to attach to a
 *    drag-source element. A small `CLICK_PX` threshold lets a near-zero move
 *    pass through as a normal click (so the existing onClick on a row still
 *    fires when the user just clicks).
 *  - `dropZoneHandlers(onDrop)` returns the props for a drop target. It hides
 *    its highlight state inside `isDragOver()` you read in the JSX.
 */
import { createSignal } from 'solid-js';

export type DragKind = 'habit' | 'time-block' | 'flight-task';
export interface DragPayload { kind: DragKind; id: string } // CON-1: ids are opaque UUIDv7 strings

const [dragPayload, setDragPayload] = createSignal<DragPayload | null>(null);
export { dragPayload };

/** Pixel threshold below which a pointerdown→up is treated as a click, not a drag. */
const CLICK_PX = 5;

/**
 * Attach to a drag source. `kind` + `id` are captured on pointerdown and read
 * by drop targets. The returned object spreads onto a JSX element.
 */
export function useDraggable(payload: DragPayload | (() => DragPayload)) {
  return {
    onPointerDown(e: PointerEvent) {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let armed = false;
      const onMove = (ev: PointerEvent) => {
        if (armed) return;
        if (Math.abs(ev.clientX - startX) > CLICK_PX || Math.abs(ev.clientY - startY) > CLICK_PX) {
          armed = true;
          setDragPayload(typeof payload === 'function' ? payload() : payload);
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        // The drop target reads dragPayload synchronously on its own pointerup
        // (which fires before this handler because of bubble order during
        // capture). Clearing here is safe — covers the "dropped on nothing" case.
        setTimeout(() => setDragPayload(null), 0);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
  };
}

/**
 * Wire a drop target. Reads `dragPayload` on pointerup-within-bounds and calls
 * `onDrop`. The `isOver` signal it returns flips to true while a drag is in
 * progress so the JSX can show the highlight state.
 *
 * `onDrop` also receives the originating `PointerEvent`, so a position-aware target
 * (e.g. the Planner grid: drop-Y → time) can read the drop coordinates. Targets that
 * don't care about position simply ignore the second argument.
 */
export function useDropZone(onDrop: (payload: DragPayload, e: PointerEvent) => void) {
  const isOver = () => dragPayload() != null;
  return {
    isOver,
    handlers: {
      onPointerUp(e: PointerEvent) {
        const p = dragPayload();
        if (p) onDrop(p, e);
      },
    },
  };
}
