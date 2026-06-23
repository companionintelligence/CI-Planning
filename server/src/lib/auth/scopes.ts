import { SCOPE_READ, SCOPE_WRITE } from './types.js';

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
