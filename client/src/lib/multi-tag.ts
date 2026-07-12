/**
 * AF-11 Slice 5 — multi-value tag helpers.
 *
 * A block's denormalized `tag` string is USUALLY a single name, but two sources
 * produce a comma-joined union: legacy wizard-era rows ("work,deep,errand") and
 * legacy routine-container stamps. Sites that render `#${tag}` or equality-filter
 * on the whole string break on those — these helpers split the string into names
 * (so multi-value tags render as separate chips and filters match per-name) and
 * classify a name list by tag kind (directions vs the rest) for the derived
 * routine-union display. Pure functions — unit-tested without jsdom.
 */

/** Minimal tag shape needed for classification (matches `Tag` from api.ts). */
export interface KindedTag {
  name: string;
  kind: 'direction' | 'intention' | 'category';
}

/** Split a (possibly comma-joined) tag string into trimmed, deduped names. */
export function splitTagNames(tag: string | null | undefined): string[] {
  if (!tag) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tag.split(',')) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * AF-11 Slice 4 — the RoutinesPanel chip lists for a routine. Prefers the server's
 * DERIVED `directions`/`intentions` (union of member tasks' tags); falls back to
 * splitting the legacy authored `tag` string when a stale payload predates the
 * derived fields (those names render as ghosts — kind is unknown client-side).
 */
export function routineChips(p: {
  tag?: string | null;
  directions?: string[];
  intentions?: string[];
}): { directions: string[]; ghosts: string[] } {
  if ((p.directions?.length ?? 0) > 0 || (p.intentions?.length ?? 0) > 0 || p.directions !== undefined) {
    return { directions: p.directions ?? [], ghosts: p.intentions ?? [] };
  }
  return { directions: [], ghosts: splitTagNames(p.tag) };
}

/**
 * Classify tag names by kind: `directions` (kind='direction', prominent chips)
 * vs `others` (intentions + names with no known tag row — ghost chips). Matching
 * is case-insensitive; input order is preserved within each bucket.
 */
export function classifyTagNames(
  names: string[],
  allTags: readonly KindedTag[],
): { directions: string[]; others: string[] } {
  const directionNames = new Set(
    allTags.filter((t) => t.kind === 'direction').map((t) => t.name.toLowerCase()),
  );
  const directions: string[] = [];
  const others: string[] = [];
  for (const n of names) (directionNames.has(n.toLowerCase()) ? directions : others).push(n);
  return { directions, others };
}
