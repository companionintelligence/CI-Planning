import { AsyncLocalStorage } from 'node:async_hooks';
import { SYSTEM_OWNER_ID } from './ids.js';
import { SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN } from './auth/types.js';

export interface RequestContext {
  ownerId: string;
  /** The scopes the bound credential carries (W12). Threaded so downstream REST handlers
   *  and GraphQL resolvers can gate on them (e.g. admin-only job surfaces) via currentScopes(). */
  scopes: string[];
}

/** Every scope — the trusted-context default (test mode + crons/jobs running as themselves). */
const ALL_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];

const als = new AsyncLocalStorage<RequestContext>();

/**
 * The single owner used everywhere until Phase I introduces authenticated
 * identities. Business logic reads `currentOwnerId()` (never a literal), so
 * going multi-tenant later is swapping the resolver — not a rewrite. CON-1: the
 * owner id is a TEXT UUIDv7 (the fixed system-owner sentinel).
 */
export const SYSTEM_OWNER = SYSTEM_OWNER_ID;

/** Run `fn` with `ownerId` + `scopes` bound for the current async context. `scopes` is the
 *  credential's scope list (W12) — requireAuth passes the verified claims' scopes; crons/jobs
 *  and test mode pass the full trusted set. */
export function runWithOwner<T>(ownerId: string, scopes: string[], fn: () => T): T {
  return als.run({ ownerId, scopes }, fn);
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

/**
 * The scopes bound for the current async context (W12), mirroring currentOwnerId().
 *
 * Bound → the credential's scopes (what requireAuth threaded through). Unbound in a test
 * run → all three scopes: the suite runs the whole app as the trusted system owner, so
 * every existing test keeps its admin capability without change (the x-test-scopes header
 * lets a test opt into a narrower set to exercise the FORBIDDEN path). Unbound in a real
 * run → an empty scope list: unlike an owner leak (silently serving owner #1), an empty
 * scope set simply denies — the fail-safe direction — so we don't need currentOwnerId()'s
 * throw here (and every real path binds scopes anyway, via requireAuth or the job dispatcher).
 */
export function currentScopes(): string[] {
  const store = als.getStore();
  if (store) return store.scopes;
  if (process.env.NODE_ENV === 'test') return ALL_SCOPES;
  return [];
}
