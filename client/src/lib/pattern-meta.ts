/**
 * Shared metadata for pattern types — the token colour palette and the motif
 * shapes the Pattern Settings UI offers. Colours are stored as **CI-Hub token
 * keys** (e.g. 'chart-1'), never hex, so patterns stay on the shared design system
 * and flip light/dark. `bg-${token}` is safelisted in tailwind.config.js.
 */

export interface ColorToken { token: string; label: string }

/** The CI teal-first core — the main interaction family (keep these primary). */
export const CORE_COLORS: readonly ColorToken[] = [
  { token: 'primary', label: 'Primary' },
  { token: 'chart-1', label: 'Mint' },
  { token: 'chart-3', label: 'Aqua' },
  { token: 'chart-4', label: 'Steel' },
  { token: 'chart-5', label: 'Navy' },
];

/**
 * The 12 categorical tag hues (index.css `--tag-1`…`--tag-12`). For tags, chips,
 * and pattern elements — never primary CTAs. Names match the palette spec.
 */
export const TAG_COLORS: readonly ColorToken[] = [
  { token: 'tag-1', label: 'Carnelian' },
  { token: 'tag-2', label: 'Sunstone' },
  { token: 'tag-3', label: 'Pyrite' },
  { token: 'tag-4', label: 'Citrine' },
  { token: 'tag-5', label: 'Jade' },
  { token: 'tag-6', label: 'Amazonite' },
  { token: 'tag-7', label: 'Aquamarine' },
  { token: 'tag-8', label: 'Amethyst' },
  { token: 'tag-9', label: 'Kunzite' },
  { token: 'tag-10', label: 'Rhodochrosite' },
  { token: 'tag-11', label: 'Rhodonite' },
  { token: 'tag-12', label: 'Topaz' },
];

/** Colours a pattern element can pick from — the teal core plus the tag hues. */
export const PATTERN_COLORS: readonly ColorToken[] = [...CORE_COLORS, ...TAG_COLORS];

/** Motif shapes with both a lucide icon and a texture motif (textures.ts). */
export const SHAPE_OPTIONS = ['circle', 'square', 'triangle', 'diamond', 'spiral', 'smile', 'gear', 'hourglass'] as const;
export type ShapeOption = (typeof SHAPE_OPTIONS)[number];

/**
 * Brand-set base pattern tags get a sensible default shape + colour until the owner
 * customizes them in Pattern Block Settings. Keyed by lowercased tag name. Shared so
 * the settings cards and the Planner availability overlay show the same look before
 * anything is saved.
 */
export const BASE_TAG_DEFAULTS: Record<string, { icon_shape: string; color_token: string }> = {
  community: { icon_shape: 'circle',   color_token: 'primary' },
  home:      { icon_shape: 'square',   color_token: 'chart-1' },
  work:      { icon_shape: 'triangle', color_token: 'chart-4' },
};

/**
 * Per-pattern horizontal phase offset (px) for the Planner availability overlay's
 * hatch texture, keyed by lowercased tag name. Shifts the line shape's start so that
 * overlapping windows don't render their waves/walls in lock-step. Unlisted patterns
 * use 0.
 */
export const HATCH_OFFSET_BY_NAME: Record<string, number> = {
  home: 2,
  work: 2,
};

/** CSS colour for a token key — for inline tints (e.g. a texture's currentColor). */
export function colorVar(token: string | null | undefined): string {
  return token ? `var(--${token})` : 'var(--primary)';
}

/** A canonical Concept tag: a name (used as title + tag) + a default estimate + optional colour. */
export interface ConceptTag { name: string; minutes: number; color_token?: string }

/** Fallback canonical Concept-Tag list (mirrors migration 0021) — used until the
 * owner's `scheduling_prefs.concept_tags` is loaded/edited. */
export const DEFAULT_CONCEPT_TAGS: readonly ConceptTag[] = [
  { name: 'Work', minutes: 240 },
  { name: 'Relax', minutes: 60 },
  { name: 'Family-Time', minutes: 120 },
  { name: 'Me-Time', minutes: 60 },
  { name: 'Socialize', minutes: 120 },
  { name: 'House-work', minutes: 60 },
  { name: 'Yard-work', minutes: 90 },
  { name: 'Exercise', minutes: 45 },
  { name: 'Meal-prep', minutes: 45 },
];
