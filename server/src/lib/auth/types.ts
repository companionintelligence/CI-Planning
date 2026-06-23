/**
 * The identity a credential resolves to, regardless of which path verified it
 * (hashed `x-api-key` in standalone mode, JWKS-Bearer JWT in SSO mode). Every
 * downstream handler reads the owner via `currentOwnerId()` (lib/context.ts);
 * `requireAuth` is the only place that turns a credential into one of these.
 *
 * CON-1: `ownerId` is a TEXT UUIDv7 (owners.id), never an integer.
 */
export interface VerifiedClaims {
  ownerId: string;
  scopes: string[];
}

/** Read access — every GET/HEAD on the API surface. */
export const SCOPE_READ = 'planning:read';
/** Mutating access — POST/PUT/PATCH/DELETE. Implies read. */
export const SCOPE_WRITE = 'planning:write';
