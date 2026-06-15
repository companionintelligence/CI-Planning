import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  ownerId: number;
}

const als = new AsyncLocalStorage<RequestContext>();

/**
 * The single owner used everywhere until Phase I introduces authenticated
 * identities. Business logic reads `currentOwnerId()` (never a literal 1), so
 * going multi-tenant later is swapping the resolver — not a rewrite.
 */
export const SYSTEM_OWNER = 1;

/** Run `fn` with `ownerId` bound as the owner for the current async context. */
export function runWithOwner<T>(ownerId: number, fn: () => T): T {
  return als.run({ ownerId }, fn);
}

/** The owner bound for the current async context, or SYSTEM_OWNER outside one. */
export function currentOwnerId(): number {
  return als.getStore()?.ownerId ?? SYSTEM_OWNER;
}
