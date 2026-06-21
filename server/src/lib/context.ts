import { AsyncLocalStorage } from 'node:async_hooks';
import { SYSTEM_OWNER_ID } from './ids.js';

export interface RequestContext {
  ownerId: string;
}

const als = new AsyncLocalStorage<RequestContext>();

/**
 * The single owner used everywhere until Phase I introduces authenticated
 * identities. Business logic reads `currentOwnerId()` (never a literal), so
 * going multi-tenant later is swapping the resolver — not a rewrite. CON-1: the
 * owner id is a TEXT UUIDv7 (the fixed system-owner sentinel).
 */
export const SYSTEM_OWNER = SYSTEM_OWNER_ID;

/** Run `fn` with `ownerId` bound as the owner for the current async context. */
export function runWithOwner<T>(ownerId: string, fn: () => T): T {
  return als.run({ ownerId }, fn);
}

/** The owner bound for the current async context, or SYSTEM_OWNER outside one. */
export function currentOwnerId(): string {
  return als.getStore()?.ownerId ?? SYSTEM_OWNER;
}
