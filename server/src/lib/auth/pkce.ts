import { createHash } from 'node:crypto';

/**
 * PKCE / base64url helpers (RFC 7636, RFC 4648 §5) — extracted from routes/oauth.ts
 * in U1 so the Google connector flow and the CI-Portal login share one copy.
 */

/** base64url-encode a buffer — no padding, URL-safe alphabet. */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256 challenge: base64url(SHA-256(verifier)). */
export function s256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}
