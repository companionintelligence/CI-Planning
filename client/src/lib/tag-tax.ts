import type { Tag } from './api.js';

/**
 * Tag taxonomy helpers (0036). Pure functions so the Tags page / wizard grouping
 * stays testable out of the components. Direction = top-level category; intention =
 * grouped under one or more directions; an intention with no directions is Unsorted.
 */

const BASE_ORDER = ['home', 'work', 'community'];

/** Brand directions first (home·work·community), then other directions alphabetically. */
export function sortDirections(directions: Tag[]): Tag[] {
  return [...directions].sort((a, b) => {
    const ai = BASE_ORDER.indexOf(a.name), bi = BASE_ORDER.indexOf(b.name);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.name.localeCompare(b.name);
  });
}

/** Display label for a tag name (directions render capitalized). */
export function displayTag(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export interface DirGroup {
  direction: Tag;
  active: Tag[];   // intentions in this direction, not muted
  muted: Tag[];    // intentions in this direction, muted
}
export interface Grouped {
  groups: DirGroup[];
  unsortedActive: Tag[];
  unsortedMuted: Tag[];
}

/**
 * Group intention tags under their directions (a tag in N directions appears in N
 * cards), split active vs muted, plus the Unsorted bucket (no direction).
 */
export function groupByDirection(tags: Tag[]): Grouped {
  const directions = sortDirections(tags.filter((t) => t.kind === 'pattern'));
  const intentions = tags.filter((t) => t.kind === 'intention');
  const groups: DirGroup[] = directions.map((direction) => {
    const inDir = intentions.filter((t) => t.directions.includes(direction.name));
    return {
      direction,
      active: inDir.filter((t) => !t.muted),
      muted: inDir.filter((t) => t.muted),
    };
  });
  const unsorted = intentions.filter((t) => t.directions.length === 0);
  return {
    groups,
    unsortedActive: unsorted.filter((t) => !t.muted),
    unsortedMuted: unsorted.filter((t) => t.muted),
  };
}

/** Directions first (brand order), then everything else — for any tag list/cloud. */
export function directionsFirst(tags: Tag[]): Tag[] {
  return [...sortDirections(tags.filter((t) => t.kind === 'pattern')), ...tags.filter((t) => t.kind !== 'pattern')];
}
