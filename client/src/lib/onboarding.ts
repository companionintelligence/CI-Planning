import type { Integrations } from './api.js';

/**
 * FTUE · T12 (#348) — pure, node-testable helpers shared by the wizard's Connect step,
 * the empty-state CTA, and the OAuth-return resume handler. No Solid/DOM dependency.
 */

/**
 * Set just before navigating to Google's consent screen; read back on the next load
 * (wherever the callback's redirect lands) to tell an ordinary Settings visit apart
 * from a wizard-initiated round trip, so only one of them reacts to `?google=`.
 */
export const FTUE_RESUME_KEY = 'cp-ftue-resume';

/** A real, usable Google connection: either a live account is connected, or the
 *  owner is exploring in fixture (sample-data) mode — both fill the app with content. */
export function hasConnectedSource(integrations: Integrations | undefined): boolean {
  if (!integrations) return false;
  if (integrations.google.mode === 'fixture') return true;
  return integrations.google.connections.some((c) => c.status === 'connected');
}

/** The empty-state CTA shows only when there's genuinely nothing to fill the view —
 *  fails closed (hidden) while `integrations` hasn't resolved yet. */
export function shouldShowConnectCTA(integrations: Integrations | undefined): boolean {
  if (!integrations) return false;
  return !hasConnectedSource(integrations);
}
