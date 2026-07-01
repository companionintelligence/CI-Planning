/**
 * An 8-pointed star (octagram) — lucide-solid has no true 8-point star, so this is
 * a small hand-drawn SVG in the same spirit as ShapeIcon's custom 'spiral' motif.
 * Marks a task that belongs to the strategic plan (an objective). Outline by default.
 */
export function EightPointStar(props: { size?: number; class?: string; strokeWidth?: number; fill?: string }) {
  const size = () => props.size ?? 13;
  const sw = () => props.strokeWidth ?? 1.5;
  // 16 vertices: 8 outer points (R≈11) alternating with 8 inner points (r≈4.5),
  // centred in a 24×24 box, first point at top.
  const points =
    '12,1 13.72,7.84 19.78,4.22 16.16,10.28 23,12 16.16,13.72 19.78,19.78 13.72,16.16 ' +
    '12,23 10.28,16.16 4.22,19.78 7.84,13.72 1,12 7.84,10.28 4.22,4.22 10.28,7.84';
  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={props.fill ?? 'none'}
      class={props.class}
      style={{ stroke: 'currentColor', 'stroke-width': String(sw()), 'stroke-linejoin': 'round' }}
    >
      <polygon points={points} />
    </svg>
  );
}
