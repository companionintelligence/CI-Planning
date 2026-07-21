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
 * The CSS colour for a Time Block (0069). Precedence:
 *   1. `block.color_token` — the FROZEN category stamp (immutable; forward-only)
 *   2. live `category_prefs[category_id].color_token` — transitional, for an unstamped block
 *   3. `tagColorVar(block.tag)` — the legacy per-tag hash (also the no-tag fallback)
 * Editing a category never re-colours a placed block because step 1 reads the stamp.
 */
export function blockColorVar(
  block: { color_token?: string | null; category_id?: string | null; tag?: string | null },
  categoryPrefs?: Record<string, { color_token: string }>,
): string {
  if (block.color_token) return `var(--${block.color_token})`;
  if (block.category_id && categoryPrefs?.[block.category_id]) return `var(--${categoryPrefs[block.category_id].color_token})`;
  return tagColorVar(block.tag);
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

/** Max contrast of the texture over its surface — a whisper, never noise (design §7).
 *  Phase C (owner ruling 2026-07-20): halved 0.06 → 0.03 — denser geometry, fainter ink. */
export const TEXTURE_OPACITY = 0.03;

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
// ── Phase C (0134/0135): category stripes ────────────────────────────────────
// The per-element texture: even diagonal stripes of the element's category
// colours (position order = stripe order), 1px line / 2px gap (denser than the
// old 8px hatch), at the halved TEXTURE_OPACITY. Colour resolution:
//   element texture_color_token (user override) → its categories' colour tokens
//   → the legacy motif fallback (routine patterns keep their tile, fainter).
// `texture_enabled=0` suppresses the overlay entirely.

/** Stripe geometry: 1px ink line, 2px transparent gap (owner: "2px apart"). */
const STRIPE_LINE_PX = 1;
const STRIPE_GAP_PX = 2;

/**
 * Resolve category NAMES → CSS colour values, via the tag list (name → id) and
 * category_prefs (id → colour token). Pure — callers pass the stores' current
 * values. Unknown names drop out; order is preserved (position = stripe order).
 */
export function categoryStripeColors(
  names: readonly string[] | undefined,
  tagList: readonly { id: string; name: string; kind: string }[] | undefined,
  prefs: Record<string, { color_token: string }> | undefined,
): string[] {
  if (!names?.length || !tagList?.length) return [];
  const out: string[] = [];
  for (const n of names) {
    const t = tagList.find((x) => x.kind === 'category' && x.name.toLowerCase() === n.toLowerCase());
    const token = t ? prefs?.[t.id]?.color_token : undefined;
    if (token) out.push(`var(--${token})`);
  }
  return out;
}

/**
 * The even-stripe overlay for 1–3 colours: a 45° repeating-linear-gradient whose
 * cycle interleaves one 1px line PER colour, each followed by the 2px gap — so a
 * two-category element alternates its two hues line by line (even distribution),
 * and a single category reads as a plain fine hatch in its hue. Deterministic in
 * `colors`; empty input yields no stripes (callers fall back to the motif).
 */
export function stripeStyle(colors: readonly string[]): TextureStyle | undefined {
  if (!colors.length) return undefined;
  const period = STRIPE_LINE_PX + STRIPE_GAP_PX;
  const stops: string[] = [];
  colors.forEach((c, i) => {
    const at = i * period;
    stops.push(`${c} ${at}px ${at + STRIPE_LINE_PX}px`, `transparent ${at + STRIPE_LINE_PX}px ${at + period}px`);
  });
  return {
    position: 'absolute',
    inset: '0',
    'pointer-events': 'none',
    'background-image': `repeating-linear-gradient(45deg, ${stops.join(', ')})`,
    opacity: TEXTURE_OPACITY * 2, // 1px lines carry ~⅓ the ink of the motif tile — 2× keeps the whisper visible
  };
}

/** The element fields the texture reads (snake_case API shape, tasks + blocks). */
export interface TexturedElement {
  texture_enabled?: boolean;
  texture_color_token?: string | null;
  categories?: string[];
}

/**
 * The ONE resolution rule for a task/block texture (Phase C). Returns the overlay
 * style, or undefined when the element opted out / nothing to derive from:
 *   1. `texture_enabled === false` → none (per-element opt-out, 0135);
 *   2. `texture_color_token` set → single-colour stripes in the override hue;
 *   3. categories present → even stripes of their colour tokens (position order);
 *   4. `motifFallback` given (a routine/pattern member) → the legacy motif tile;
 *   5. otherwise → none.
 */
export function elementTextureStyle(
  el: TexturedElement,
  tagList: readonly { id: string; name: string; kind: string }[] | undefined,
  prefs: Record<string, { color_token: string }> | undefined,
  motifFallback?: { iconShape: string | null | undefined; seedTag: string | null | undefined },
): TextureStyle | undefined {
  if (el.texture_enabled === false) return undefined;
  if (el.texture_color_token) return stripeStyle([`var(--${el.texture_color_token})`]);
  const catColors = categoryStripeColors(el.categories, tagList, prefs);
  if (catColors.length) return stripeStyle(catColors);
  return motifFallback ? textureStyle(motifFallback.iconShape, motifFallback.seedTag) : undefined;
}

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
