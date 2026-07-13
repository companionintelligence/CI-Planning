import { SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN } from './types.js';

/**
 * The scope a request needs, derived from its HTTP method: safe (GET/HEAD) reads
 * need `planning:read`; everything else mutates and needs `planning:write`. A
 * coarse map by design — Phase I authenticates and gates read-vs-write; it does
 * not build per-route RBAC (that is out of scope, see I-identity-auth.md).
 */
export function requiredScope(method: string): string {
  return method === 'GET' || method === 'HEAD' ? SCOPE_READ : SCOPE_WRITE;
}

/** A write-scoped credential also satisfies read; a read-only one does not write. */
export function hasScope(scopes: string[], method: string): boolean {
  if (requiredScope(method) === SCOPE_READ) {
    return scopes.includes(SCOPE_READ) || scopes.includes(SCOPE_WRITE);
  }
  return scopes.includes(SCOPE_WRITE);
}

/**
 * Admin gate (W12) — the single predicate REST and GraphQL both use so the two surfaces
 * decide identically. Admin is NOT implied by write; it must be present explicitly.
 */
export function hasAdminScope(scopes: string[]): boolean {
  return scopes.includes(SCOPE_ADMIN);
}

/**
 * Phase AG — the role→scopes map, the single place an `owners.role` becomes a scope
 * set (verifySession + any future path). Three roles map 1:1 onto the existing
 * scopes, so no per-feature permission table exists:
 *
 *   operator → [read, write, admin]  (account management, system jobs, Google config)
 *   member   → [read, write]         (a normal tenant — full access to their own data)
 *   viewer   → [read]                (read-only tenant)
 *
 * An unrecognized value (a hand-edited row, a role from a newer schema) degrades to
 * read-only — the fail-closed direction, matching verifySession's malformed-epoch
 * handling: never grant write/admin on input we don't understand.
 */
export const OWNER_ROLES = ['operator', 'member', 'viewer'] as const;
export type OwnerRole = (typeof OWNER_ROLES)[number];

export function roleToScopes(role: string | null | undefined): string[] {
  switch (role) {
    case 'operator': return [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];
    case 'member':   return [SCOPE_READ, SCOPE_WRITE];
    default:         return [SCOPE_READ]; // 'viewer' + anything unrecognized
  }
}
