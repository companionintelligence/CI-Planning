import type { Score } from './api.js';

/**
 * The close ritual's three-face → 1-5 encoding (0161).
 *
 * 0137 argued against a numeric self-rating: a face is answered instantly and honestly
 * where a number invites deliberation. That objection was about the INPUT, and it stands.
 * What changed is that three faces with an optional SECOND pick express five ordered
 * levels, so the input stays a tap while the stored value becomes a score that can be
 * averaged and trended — which the old four moods could not be, "frustrated" and
 * "stressed" being two different kinds of bad with no order between them.
 *
 * Pure and icon-free so it can be unit-tested in the node project; the component owns the
 * lucide icons and colours.
 */

/** Worst → best. The order IS the scale, so it is not cosmetic. */
export const FACE_KEYS = ['frown', 'flat', 'smile'] as const;

export type FaceKey = (typeof FACE_KEYS)[number];

/**
 * One pick is an odd number; an adjacent pair fills the even gap between:
 *
 *   frown 1 · frown+flat 2 · flat 3 · flat+smile 4 · smile 5
 *
 * frown+smile returns null on purpose and is unreachable via [[toggleFace]] — "it was both
 * terrible and great" is not a point on this scale, and quietly scoring it 3 would make a
 * conflicted answer indistinguishable from an indifferent one.
 */
export function scoreOf(picked: readonly FaceKey[]): Score | null {
  const has = (k: FaceKey) => picked.includes(k);
  if (picked.length === 1) return has('frown') ? 1 : has('flat') ? 3 : 5;
  if (picked.length === 2) {
    if (has('frown') && has('flat')) return 2;
    if (has('flat') && has('smile')) return 4;
  }
  return null;
}

/** Are these the two opposite ends of the scale? */
const opposed = (a: FaceKey, b: FaceKey) =>
  (a === 'frown' && b === 'smile') || (a === 'smile' && b === 'frown');

/**
 * Tap handling. Toggling off is always allowed — a mis-tap must be undoable without
 * closing the sheet. Tapping a face that opposes the current selection REPLACES it rather
 * than refusing: there is then no invalid state to explain, and the last thing tapped is
 * obviously what was meant.
 */
export function toggleFace(picked: readonly FaceKey[], tapped: FaceKey): FaceKey[] {
  if (picked.includes(tapped)) return picked.filter((k) => k !== tapped);
  if (picked.some((k) => opposed(k, tapped))) return [tapped];
  if (picked.length >= 2) return [tapped];
  // Keep scale order so the rendered selection reads left-to-right.
  return FACE_KEYS.filter((k) => k === tapped || picked.includes(k));
}
