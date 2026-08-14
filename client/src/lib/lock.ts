import type { Block } from './api.js';
import { isExternalBlock } from './overlay.js';

/**
 * The lock model (Focus × Time Blocks, Phase 1).
 *
 * Lock state is universal — every scheduled item shows it and, if the owner authored
 * it, toggles it. The one exception is decision 1: a **synced calendar event cannot
 * be unlocked**, and where a native block renders the toggle it renders its SOURCE
 * instead. Not a disabled control — a dead toggle says "broken", while the source
 * line says *why* the event answers to no one here: its calendar owns its time.
 *
 * Pure so the decision is unit-testable without jsdom, and so the drawer, the
 * Planner card, and the Focus rows (Phases 2–3) all answer identically.
 */

/** Human name for a connector provider id. Unknown providers title-case their id. */
const PROVIDER_NAME: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
  caldav: 'CalDAV',
  ical: 'iCal',
};

export function providerLabel(provider: string): string {
  const key = provider.trim().toLowerCase();
  if (!key) return 'calendar';
  return PROVIDER_NAME[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The provenance line a synced event shows in place of a lock toggle, e.g.
 * "Synced from Google · work". Null for anything created here.
 *
 * Keyed on `source_account` exactly as `isExternalBlock` is: `source_provider` alone
 * is also stamped on locally-created rows, so it cannot be the test for "external".
 * A row with an account but no provider still gets a line — the account is the part
 * that identifies which calendar, and a missing provider should degrade, not hide it.
 */
export function sourceLine(b: Pick<Block, 'source_provider' | 'source_account'>): string | null {
  if (!b.source_account) return null;
  return `Synced from ${providerLabel(b.source_provider ?? '')} · ${b.source_account}`;
}

/**
 * Which affordance a block gets where the lock lives:
 *  - `'source'` — a synced event: provenance, no control (decision 1);
 *  - `'toggle'` — anything the owner created here.
 */
export function lockAffordance(b: Pick<Block, 'source_account'>): 'source' | 'toggle' {
  return isExternalBlock(b) ? 'source' : 'toggle';
}

/** Label + tooltip for the toggle, so every surface words it the same way. */
export function lockActionLabel(locked: boolean): { label: string; title: string } {
  return locked
    ? { label: 'Unlock', title: 'Unlock — reflow may move this again' }
    : { label: 'Lock', title: 'Lock — hold this slot through reflow' };
}
