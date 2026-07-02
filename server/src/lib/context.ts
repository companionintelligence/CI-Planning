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

/**
 * The owner bound for the current async context.
 *
 * Outside any `runWithOwner` scope this used to silently return SYSTEM_OWNER.
 * Once multi-tenant lands (Phase T), that silent fallback would serve owner #1's
 * data to an un-scoped code path — an invisible cross-tenant leak. So in real
 * (non-test) runs we now **fail loud**: a missing `runWithOwner` wrapper is a bug,
 * not a default. Every owner-scoped read/write must run inside a request (wrapped
 * by `requireAuth`) or a cron/job (wrapped by the dispatcher).
 *
 * The test suite runs the whole app as the single system owner, so under
 * `NODE_ENV==='test'` the SYSTEM_OWNER fallback is kept.
 */
export function currentOwnerId(): string {
  const bound = als.getStore()?.ownerId;
  if (bound) return bound;
  if (process.env.NODE_ENV === 'test') return SYSTEM_OWNER;
  throw new Error(
    'currentOwnerId() called outside a runWithOwner context — every owner-scoped read/write ' +
      'must run inside runWithOwner (a request via requireAuth, or a cron/job).'
  );
}
