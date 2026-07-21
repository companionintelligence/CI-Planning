/**
 * Client feature flags. Compile-time constants for now (no server plumbing) — flip
 * here and rebuild. Promote to a server-driven flag when one genuinely needs to vary
 * per deployment at runtime.
 */

/**
 * 0134 — Categories are unified with the Balance Core Dimensions and, for this
 * delivery, are a FIXED set of six (health/career/relationships/growth/leisure/
 * finance). Adding/removing categories is gated OFF (owner ruling 2026-07-20):
 * changing the set means changing the Balance dimensions, which is a later phase.
 * Editing (rename/recolour) an existing category stays allowed.
 */
export const CATEGORIES_EDITABLE = false;
