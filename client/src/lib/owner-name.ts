/**
 * The name a profile field should open with.
 *
 * A new owner is seeded with the placeholder name "System" (the owners table's seed row), which
 * nobody chose. Showing it in the first-run wizard and the profile made it look like the owner's
 * own name, so the field opens empty and asks for one instead.
 */
export const SEEDED_OWNER_NAME = 'System';

export function editableOwnerName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed === SEEDED_OWNER_NAME ? '' : trimmed;
}
