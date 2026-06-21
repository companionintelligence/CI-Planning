/**
 * Pattern textures (Phase G, G8). A deterministic, dependency-light generator that
 * turns a pattern's **type** (`icon_shape`) and **tag** into a subtle background
 * motif behind a PLANNER item.
 *
 * Two rules from the design (design-today-cockpit.md §4):
 *  - The **shape** is fixed by the pattern type — squares / circles / triangles.
 *  - The **variation** (cell size, rotation, motif size) is a deterministic
 *    function of the **tag name** — `textureSeed(tag)` — so a tag always looks the
 *    same across renders/sessions, and different tags look visibly different.
 *
 * Nothing is stored: the look is fully derived. The texture is theme-adaptive — it
 * renders as a `currentColor` overlay clipped to the motif via a CSS mask, so it is
 * a low-contrast whisper (≤ ~6%) over whatever surface it sits on, in light or dark.
 */

/** The motif shapes we can draw. A pattern type's `icon_shape` maps onto one. */
export type Motif = 'square' | 'circle' | 'triangle';

/** Map a pattern type's `icon_shape` (incl. user-defined) onto a drawable motif. */
export function motifFor(iconShape: string | null | undefined): Motif {
  switch ((iconShape ?? '').toLowerCase()) {
    case 'circle': return 'circle';
    case 'triangle': return 'triangle';
    case 'square': return 'square';
    default: return 'square'; // user-defined shapes fall back to the square motif
  }
}

/**
 * A deterministic 32-bit hash of the tag (FNV-1a). Stable across renders/sessions
 * and well-distributed, so it seeds a per-tag texture variation. Empty/undefined
 * tags collapse to a single stable seed (fine — untagged patterns share a texture).
 */
export function textureSeed(tag: string | null | undefined): number {
  let h = 0x811c9dc5; // FNV offset basis
  const s = tag ?? '';
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return h >>> 0; // unsigned
}

/**
 * The CI-Hub categorical hue token (`tag-1`…`tag-12`) for a tag string, picked
 * deterministically from the same FNV seed — so a tag always maps to the same
 * colour. Stays on the design system (the tokens are defined in index.css).
 */
export function tagHueToken(tag: string | null | undefined): string {
  return `tag-${(textureSeed(tag) % 12) + 1}`;
}

/** CSS colour value for a tag's hue, e.g. `var(--tag-5)`. */
export function tagColorVar(tag: string | null | undefined): string {
  return `var(--${tagHueToken(tag)})`;
}

/**
 * Background style for a *completed* item: a sparse diagonal hatch in the tag's
 * hue at 60% alpha — 1px stroke / 8px gap, upper-left → lower-right ("\"). Reads
 * as "done, and here's its tag" while staying legible (vs. just dimming it).
 */
export function doneHatchStyle(tag: string | null | undefined): Record<string, string> {
  const c = `color-mix(in srgb, ${tagColorVar(tag)} 60%, transparent)`;
  return { 'background-image': `repeating-linear-gradient(45deg, ${c} 0 1px, transparent 1px 9px)` };
}

/** The opaque inner SVG motif, centered in a `cell`×`cell` tile (mask uses its alpha). */
function motifSvg(motif: Motif, cell: number, r: number): string {
  const c = cell / 2;
  switch (motif) {
    case 'circle':
      return `<circle cx="${c}" cy="${c}" r="${r}" fill="#000"/>`;
    case 'triangle': {
      // Up-pointing triangle inscribed around the centre.
      const p = `${c},${c - r} ${c - r},${c + r} ${c + r},${c + r}`;
      return `<polygon points="${p}" fill="#000"/>`;
    }
    case 'square':
    default:
      return `<rect x="${c - r}" y="${c - r}" width="${2 * r}" height="${2 * r}" fill="#000"/>`;
  }
}

/** Max contrast of the texture over its surface — a whisper, never noise (design §7). */
export const TEXTURE_OPACITY = 0.06;

/** A style object (Solid `style=` shape) for the texture overlay. */
export type TextureStyle = Record<string, string | number>;

/**
 * The overlay style for a pattern instance with the given type shape + tag.
 *
 * Deterministic in `(iconShape, tag)`: identical inputs yield an identical object,
 * different tags yield a visibly different motif tile (size/rotation/density). The
 * overlay tints `currentColor` (so it flips with the theme) and clips it to the
 * motif via a CSS mask at `TEXTURE_OPACITY`.
 */
export function textureStyle(iconShape: string | null | undefined, tag: string | null | undefined): TextureStyle {
  const motif = motifFor(iconShape);
  const seed = textureSeed(tag);

  // Derive the per-tag variation from independent slices of the seed.
  const cell = 14 + (seed % 7) * 2;          // 14..26px tile
  const rot = ((seed >>> 3) % 4) * 15;        // 0 | 15 | 30 | 45 deg
  const r = Math.round((cell / 2) * (0.34 + ((seed >>> 6) % 4) * 0.07)); // motif radius

  const inner = motifSvg(motif, cell, r);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}" viewBox="0 0 ${cell} ${cell}">` +
    `<g transform="rotate(${rot} ${cell / 2} ${cell / 2})">${inner}</g></svg>`;
  const uri = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const size = `${cell}px ${cell}px`;

  return {
    position: 'absolute',
    inset: '0',
    'pointer-events': 'none',
    'background-color': 'currentColor',
    'mask-image': uri,
    '-webkit-mask-image': uri,
    'mask-size': size,
    '-webkit-mask-size': size,
    'mask-repeat': 'repeat',
    '-webkit-mask-repeat': 'repeat',
    opacity: TEXTURE_OPACITY,
  };
}
