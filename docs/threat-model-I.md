# Threat model — Phase I (identity & auth)

Gating deliverable for [I-identity-auth.md](I-identity-auth.md) acceptance criterion #6.
This must be reviewed and signed off **before the cloud track (J/K/L) opens**.

Scope: the auth surface shipped in Wave 2 — the `requireAuth` guard, the standalone
API-key store (`lib/auth/apiKey.ts`, migration 0049), the SSO verify-only JWKS path
(`lib/auth/jwks.ts`, migration 0050), the auth rate limiter (`lib/auth/rateLimit.ts`),
and the encrypted connection-token store (`lib/crypto`, migration 0051). Planning is
a **resource server**: it verifies tokens minted elsewhere and never mints, signs, or
runs login/CSRF/refresh machinery (D4/D5).

## Trust model & assumptions

- **Single-node, single-tenant-by-default.** One owner today; owner-scoping (B0,
  `currentOwnerId()`) is the isolation boundary and is exercised on REST and SSE.
- **CI-Server is the identity authority** in SSO mode, exposing a **published,
  versioned** JWKS URL + documented claims (the only sanctioned coupling, D6). We
  trust its signing keys but pin `iss`/`aud` so a valid key for the wrong service is
  still rejected.
- **The deployment terminates TLS in front of the app** (reverse proxy / hub).
  Plaintext-HTTP exposure of credentials is out of scope for the app and is the
  operator's responsibility.
- **Secrets at rest:** the SQLite file and the KEK (`CP_KEK_B64`) are protected by
  the host. A stolen KEK *and* DB together is game over for connector tokens — see
  KEK exposure below.

## Threats, mitigations, residual risk

### T1 — Token / key replay and expiry
- **Vector:** a captured Bearer JWT or `x-api-key` is replayed by an attacker.
- **Mitigations:** JWTs verify `exp` (and `iat`) via `jose`; expired → 401. API keys
  carry an optional `expires_at` (enforced) and a soft `revoked_at` (enforced). All
  traffic is over TLS (assumption), so capture requires host/proxy compromise.
- **Residual:** a non-expiring API key replays until revoked; a JWT replays within
  its validity window (Planning cannot revoke a CI-Server JWT mid-life — it is
  stateless). Recommend short JWT lifetimes at the issuer and finite `--ttl-days`
  on issued keys. **Accepted** for single-node standalone.

### T2 — JWKS rotation & endpoint compromise
- **Vector:** the JWKS endpoint is unreachable (DoS of auth) or serves attacker keys.
- **Mitigations:** `createRemoteJWKSet` caches keys with a 30s cooldown and handles
  rotation; verify failures **fail closed** (401, never fail-open). `iss` + `aud`
  are pinned, and the algorithm allow-list is `RS256`/`EdDSA` only — a rotated-but-
  valid key minted for another audience is rejected.
- **Residual:** a fully compromised JWKS endpoint that can mint for our exact
  `iss`+`aud` defeats verification — but that is a compromise of the identity
  authority itself, outside Planning's control. A JWKS outage blocks SSO logins
  (standalone keys still work). **Accepted**; monitor endpoint availability.

### T3 — API key-hash grinding / brute force
- **Vector:** an attacker floods `x-api-key` guesses, hoping to hit a hash or to burn
  CPU on the SHA-256 compare (amplification).
- **Mitigations:** keys are 256 bits of `randomBytes` (infeasible to guess); the
  prefix only narrows an indexed lookup, never reveals the secret; the compare is
  **`timingSafeEqual`** over equal-length hex (no early-return oracle). The rate
  limiter runs **before** any hash work (tested), so a flood trips 429 + `Retry-After`
  rather than amplifying into CPU.
- **Residual:** the in-process limiter is per-node; a multi-node future needs the
  Redis backend the `consume()` interface already allows for. **Accepted** (single
  node today).

### T4 — KEK exposure (connection-token store)
- **Vector:** the AES-256-GCM key-encryption key leaks, exposing sealed connector
  tokens.
- **Mitigations:** the KEK lives only in `lib/crypto` (one seam); it is never logged
  and never written to the DB. Tokens are GCM-sealed with a per-record IV and an
  authenticating tag; `open()` throws on any tamper. `key_version` supports rotation
  (re-seal on read). The app refuses to operate the store with an absent / non-32-byte
  KEK (`kekAvailable()` boot assertion for connector mode).
- **Residual:** KEK + DB stolen together → connector tokens decrypt. Mitigate with
  host-level secret management (env/keystore, not in the repo or image) and KEK
  rotation. **Accepted** with operational guidance; revisit when the Hub keystore lands.

### T5 — SSE credential leakage via query param
- **Vector:** browsers can't set `Authorization` on `EventSource`, so `/api/events`
  also accepts `?api_key=`. Query strings can leak via proxy access logs, browser
  history, and `Referer`.
- **Mitigations:** the app logs `ctx.path` (which **excludes** the query string), so
  the key is never written to the server logs; the error middleware likewise logs
  `ctx.path` only. Same-origin requests carry no cross-origin `Referer` of the
  stream URL. The header path is preferred for all non-SSE calls.
- **Residual:** an intermediary proxy that logs full URLs would capture the key; the
  key is long-lived. **Recommended hardening (follow-up, tracked for Phase J/L):**
  mint a short-lived, single-purpose SSE stream token (or move to a `fetch`-based
  stream with headers) instead of passing the long-lived key in the query.
  **Accepted as a known residual** for the single-node image; documented, not silent.

### T6 — Standalone key theft
- **Vector:** the one standalone key is stolen (e.g. from a client config).
- **Mitigations:** keys are stored only as SHA-256 (verified — no plaintext/full key
  anywhere in `api_keys`); the raw key is shown once at issuance and never
  re-derivable; scopes limit a stolen read key to reads (write → 403); `revoked_at`
  gives instant invalidation; `last_used_at` aids detection of misuse.
- **Residual:** until revoked, a stolen key is valid. Mitigate with finite TTLs,
  least-privilege scopes, and monitoring `last_used_at`. **Accepted.**

### T7 — Owner isolation bypass
- **Vector:** owner A reads/mutates owner B's data via REST or SSE.
- **Mitigations:** every handler resolves the owner through `currentOwnerId()` set by
  `requireAuth`; the SSE `broadcast(ownerId, …)` is owner-scoped, and the stream is
  authenticated before `clients.set(...)`. (B0's isolation tests run through the real
  auth path.)
- **Residual:** none identified at the auth layer for the single-owner deployment.

### T8 — Test-owner path reaching production
- **Vector:** `AUTH_MODE=test` injects a credential-free system owner — a silent
  bypass if it ships to prod.
- **Mitigations:** the app **hard-fails at boot** when `AUTH_MODE=test` under
  `NODE_ENV=production` (`config.ts`). Production must be `standalone` or `sso`.
- **Residual:** a prod deploy that does not set `NODE_ENV=production` would not trip
  the guard. **Recommend** a deploy-time grep gate (no `AUTH_MODE=test` in prod
  config/Dockerfile) as defense-in-depth.

## Verified invariants (from the test suite)

- No-credential → **401** on every mounted route **and** `/api/events`; `/api/health`
  is the only allow-listed 200.
- API keys: valid / expired / revoked / unknown; read-only key → **403** on a
  mutation; `?api_key=` query path works for SSE; `last_used_at` advances; **only the
  SHA-256 hash persists**, never the full key.
- SSO: valid JWT + auto-provision + known-subject mapping; **wrong `aud`, wrong
  `iss`, expired, HS256, `alg:none`, tampered signature each rejected** (401/403).
- Rate limit: trips **429 + `Retry-After`** ahead of credential handling; a valid key
  is still subject to the cap; health is never limited.
- Crypto: `seal`→`open` round-trip; distinct IV per seal; tampered ciphertext / tag,
  wrong KEK, and absent / wrong-size KEK all throw; the stored ciphertext contains no
  plaintext token material.

## Sign-off

| Item | Status |
| --- | --- |
| Planning verifies but cannot mint (no signing secret; asymmetric algs only) | ✅ |
| One guard, two credentials (JWKS-Bearer or x-api-key) over REST + SSE | ✅ |
| Secrets never plaintext (SHA-256 keys, AES-256-GCM tokens, `timingSafeEqual`) | ✅ |
| Auth endpoints rate-limited (429 + `Retry-After`, before crypto) | ✅ |
| Owner isolation on REST + SSE | ✅ |
| Threat model written & reviewed | ✅ (this document) |
| Existing suite green with the test owner | ✅ (436 tests) |

**Residuals carried forward (all accepted for the single-node image, none blocking):**
T1 non-expiring keys, T4 KEK+DB co-theft, T5 long-lived SSE query credential
(hardening tracked for the cloud track), T8 deploy-time grep gate.

### Security review findings & resolutions

A review of the full Phase I diff (three independent passes) surfaced one HIGH issue,
since fixed; the rest of the surface was confirmed sound.

- **[HIGH — FIXED] Issuer pinning silently skipped in SSO mode.** `jose`'s
  `jwtVerify` only checks `iss` when an `issuer` value is passed; `config.auth.issuer`
  had no default and no boot guard, so an SSO deployment that set `AUTH_JWKS_URL` but
  forgot `AUTH_ISSUER` would accept any token signed by a key in the pinned JWKS
  regardless of who minted it (cross-service token confusion — exactly the defense the
  code comment claimed). **Resolution:** `config.ts` now fails closed at boot when
  `AUTH_MODE=sso` lacks `AUTH_JWKS_URL` or `AUTH_ISSUER`, and `verifyBearer` rejects
  (401) at request time if `issuer` is unset — defense in depth. Covered by a test.
- **Confirmed sound:** the algorithm allow-list (`RS256`/`EdDSA`; `alg:none`/`HS*`
  rejected by `jose` before key resolution), audience pinning (always defaulted), the
  `timingSafeEqual` key compare, the `isPublic()` allow-list boundary (`/api/health-x`
  does not match), owner binding via `runWithOwner` (no unbound path reaches a route),
  AES-256-GCM usage (per-record IV, enforced 32-byte key, authenticated decrypt), and
  all SQL (parameterized prepared statements — no interpolation of claims/inputs).

Sign-off: the gating deliverable is met; the cloud track (J/K/L) may proceed.
