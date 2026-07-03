import type { Database } from 'better-sqlite3';

export const id = '0102_auth_states';

/**
 * U1 (CI-Portal SSO) — pre-login OAuth state store.
 *
 * Same shape and lifecycle as `oauth_states` (0058) — one short-lived row per
 * in-flight authorize redirect, single-use, expiring — but WITHOUT `owner_id`:
 * the Google flow is account-*linking* (an already-authenticated owner attaches a
 * calendar), so its state row binds an owner; U1's flow IS the login, so no owner
 * exists yet when `/api/auth/ciportal/start` runs. `oauth_states.owner_id` is
 * NOT NULL — correctly, other code relies on it — so rather than loosening that
 * constraint this is its own table (the plan's explicit call, U1 note #1).
 *
 * `state` is the CSRF nonce echoed back on the callback (UNIQUE gives it an
 * index — no separate index needed); `code_verifier` is the PKCE S256 verifier
 * the callback exchanges; `nonce` binds the id_token to this flow. Expired rows
 * are opportunistically pruned by /start (they're minted unauthenticated, so
 * they must never accumulate).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_states (
      id            TEXT PRIMARY KEY,
      state         TEXT NOT NULL UNIQUE,  -- CSRF nonce echoed on the callback
      code_verifier TEXT NOT NULL,         -- PKCE verifier (exchanged for tokens)
      nonce         TEXT NOT NULL,         -- OIDC nonce (bound into the id_token)
      redirect_uri  TEXT,                  -- the redirect_uri sent to the portal, echoed at exchange
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at    TEXT NOT NULL
    );
  `);
}
