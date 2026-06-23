import type Koa from 'koa';
import { config } from '../config.js';

/**
 * Fixed-window rate limiter for the auth surface (D4 — CI-Server has none on its
 * own /authenticate; this is our explicit addition). Keyed by client IP **and**
 * credential prefix, and checked in `requireAuth` **before** any signature/hash
 * work — so it also blunts a hash-grinding flood (the limiter must never be the
 * CPU-amplification vector). In-process Map for the single-node deployment; the
 * one-function `consume()` interface lets a Redis backend drop in for multi-node.
 */

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when the window rolls over
}

const buckets = new Map<string, Bucket>();

export interface RateResult {
  ok: boolean;
  retryAfter: number; // seconds until the window resets (0 when ok)
}

/** Count one hit against `key`; deny once `max` is exceeded within `windowMs`. */
export function consume(key: string, max: number, windowMs: number): RateResult {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > max) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Bucket identity: IP + the presented credential's short prefix (no secret material). */
function limiterKey(ctx: Koa.Context, scope: string): string {
  const apiKey = ctx.get('x-api-key') || (typeof ctx.query.api_key === 'string' ? ctx.query.api_key : '');
  const bearer = ctx.get('authorization').replace(/^Bearer\s+/i, '');
  // First few chars only — enough to separate distinct callers, never the secret.
  const cred = apiKey ? apiKey.slice(0, 5) : bearer ? bearer.slice(0, 8) : 'none';
  return `${scope}:${ctx.ip}:${cred}`;
}

function deny(ctx: Koa.Context, retryAfter: number): false {
  ctx.status = 429;
  ctx.set('Retry-After', String(retryAfter));
  ctx.body = { error: 'rate limited' };
  return false;
}

/**
 * Guard credential validation. Returns false (and writes a 429 + Retry-After) when
 * the caller is over the limit — `requireAuth` must `return` immediately, before
 * touching any crypto.
 */
export function checkAuthRateLimit(ctx: Koa.Context): boolean {
  const { max, windowMs } = config.auth.rateLimit;
  const r = consume(limiterKey(ctx, 'auth'), max, windowMs);
  return r.ok ? true : deny(ctx, r.retryAfter);
}

/**
 * Tighter guard for key-issuance / local-login endpoints (when one is mounted).
 * Same window, lower ceiling (`issueMax`).
 */
export function checkIssueRateLimit(ctx: Koa.Context): boolean {
  const { issueMax, windowMs } = config.auth.rateLimit;
  const r = consume(limiterKey(ctx, 'issue'), issueMax, windowMs);
  return r.ok ? true : deny(ctx, r.retryAfter);
}

/** Test-only: clear all buckets so windows don't bleed across cases. */
export function _resetRateLimit(): void {
  buckets.clear();
}
