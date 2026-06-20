import { Circle, Square, Triangle } from 'lucide-solid';

/**
 * A lucide icon matching a pattern type's `icon_shape`. The three built-in motifs
 * (circle/square/triangle) map 1:1; any custom/unknown shape falls back to a
 * square, mirroring `motifFor` in textures.ts so the icon and texture always agree.
 */
export function ShapeIcon(props: { shape: string | null | undefined; size?: number; class?: string }) {
  const size = () => props.size ?? 14;
  const shape = () => (props.shape ?? '').toLowerCase();
  return (
    <>
      {shape() === 'circle' ? (
        <Circle size={size()} class={props.class} />
      ) : shape() === 'triangle' ? (
        <Triangle size={size()} class={props.class} />
      ) : (
        <Square size={size()} class={props.class} />
      )}
    </>
  );
}
