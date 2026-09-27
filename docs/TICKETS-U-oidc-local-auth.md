# Tickets — Phase U (OIDC + local auth)

**Source doc:** `docs/U-oidc-local-auth.md`. **Companion to:** `docs/T-multitenant-tickets.md` (Phase T ticket board — T0/T3/T4/T1 merged as of PR #222; T2 next; T5 folded into this doc as **U0**, per owner decision below). **Scope:** Companion Planning (this repo) only. CI-Server was checked read-only — it is **not** the auth system (see naming correction below) and nothing in this phase touches its code, schema, or data.

**Grounded against `main` @ `8c4d10e`** (post-#222, migration head `0099`). File paths/line references below are current as of that commit — re-verify before implementation if more T/main merges land first (T2 is still pending and will touch `schema.ts`/`backup.ts`).

## Naming correction (2026-07-02) — read this before anything else

Earlier drafts of this phase assumed `hub.companionintelligence.com` was CI-Server, based on a misleading comment in this repo's own `config.ts` (`sso: verifies a JWKS-signed Bearer JWT (CI-Server hub)`). **That comment is wrong.** Per the owner, then confirmed directly by the boss's notes below:

- **CI-Portal** — `hub.companionintelligence.com`. The developer CI Portal server: an **OAuth server**. Companion Planning becomes an **OAuth consumer** of it, the same role **CI-Import Tools** and **CI-Hub** already play. Reachable over **Tailscale**. **Not in any connected folder** — no source or discovery doc available to this planning session, but its role and integration shape are now confirmed (see "Direction from the boss" below).
- **CI-Hub** — the app manager (what apps exist / are installed / configured). Itself an OIDC consumer of CI-Portal, same as this app will be. Not connected.
- **CI-Server** — a data provider (sends task data to/from Companion Planning). **This is the repo I inspected.** Confirmed: no OIDC provider, no JWKS, no client registry, its own unrelated internal login (HS256 JWT + `ci_core.users`) is CI-Server authenticating *its own* users for *its own* app, not an identity service for sibling apps. CI-Server is irrelevant to Phase U and struck from U1's design entirely — it was never the right system to check.

**Action:** every reference to "the Hub" in these tickets means **CI-Portal**. The `config.ts` comment saying "CI-Server hub" should be corrected to "CI-Portal" as a one-line fix whenever U1 is picked up, so the next reader isn't misled the same way.

## Decisions locked

| Decision | Answer |
|---|---|
| Tenant model | **1:1 — tenant = user.** Matches Phase T's locked decision #1 (Option A). `owners` is the user table. |
| `owners` rename | Kept as `owners` (Phase T decision #2, unchanged). |
| Local-mode toggle | **`DISABLE_OIDC` boolean, meaningful only when `AUTH_MODE=sso`.** `test` and `standalone` modes ignore it completely — zero behavior change for dev/CI or the headless Docker image. `AUTH_MODE=sso` + `DISABLE_OIDC=true` gives the local username/password path instead of JWKS verification. |
| First-login provisioning | **Auto-provision**, reusing the **already-scaffolded** `AUTH_AUTO_PROVISION` config flag (`server/src/lib/config.ts:117`, currently unused/dead until U1). A valid CI-Portal token with no matching `owners.external_subject` creates a new owner row. |
| Session mechanism (local login) | Signed, httpOnly cookie via Koa's built-in `app.keys` + `ctx.cookies.set(name, val, { signed: true, httpOnly: true })` — no new cookie/session package needed. |
| `owners` auth-columns migration (Phase T's "T5") | **Folded into this phase as U0** (owner decision) — U writes and merges it as its own opening PR rather than waiting on a separate Phase-T PR, since only U's design determines the final column set. |

## Direction from the boss (2026-07-02) — resolves most of what was open

- **Full OAuth/OIDC consumer flow, confirmed.** Companion Planning becomes an OAuth **consumer** (client) of `hub.companionintelligence.com` — "the developer CI Portal server," an OAuth server — the same role CI-Import Tools and CI-Hub already play against it. This settles the verify-only-vs-redirect question from before: it's a **real Relying-Party flow** (redirect to the Portal, come back with a code, exchange it), not passive verification of a token minted elsewhere.
- **Tailscale-only, confirmed.** CI-Portal is reachable through Tailscale, matching the existing precedent (`CLAUDE_COWORK.md`'s tailnet MCP endpoint) — whoever implements U1 needs tailnet access to even reach the discovery endpoint.
- **The local-auth toggle + defaults are exactly U2 as already spec'd** — a default-off toggle that disables OIDC entirely and switches to local username/password, plus default-username/default-password env vars. No changes needed to U2 below; this just confirms it top-down.

**Still genuinely open — this is the one remaining input, and it's a "go get it from the CI-Portal team," not a design decision:**

1. **CI-Portal's actual OIDC discovery values** — issuer URL, authorization endpoint, token endpoint, JWKS URL (fetch `https://hub.companionintelligence.com/.well-known/openid-configuration` over Tailscale, or ask the CI-Portal team directly for the equivalent if it doesn't publish discovery).
2. **Client registration mechanics** — is `client_id` self-service or hand-provisioned? Public client (PKCE only) or confidential (needs a `client_secret`)? Ask whoever provisioned CI-Import Tools/CI-Hub's client credentials — they've done this before, U1 is not the first consumer.

**Everything else about U1 is now buildable in parallel with getting those two answers** — see below: this app already has a working Authorization-Code+PKCE OAuth client (built for Google) that U1 mirrors almost line-for-line.

---

## U0 — `owners` gains auth-identity columns (was Phase T's "T5")

**Depends on:** nothing code-side. **Sequencing:** Phase T's locked PR order is `T0 -> T3 || T4 -> T1 -> T2 -> T5`; T2 (tag owner-scoping, migration `0100`) is still unmerged and also touches `schema.ts`. **Coordinate the migration number with whoever merges T2 next** — if T2 lands first, this is `0101`; if U starts first, claim `0100` and flag the collision risk to Phase T's owner so T2 doesn't also grab it.

**Before:** `owners` = `id, name, email, last_auto_run_id` only (`server/src/db/schema.ts:8-13`). One row exists in practice: the `SYSTEM_OWNER_ID` sentinel (`server/src/lib/ids.ts:8`, `'00000000-0000-7000-8000-000000000001'`).

**After:**
- `external_subject TEXT UNIQUE` — nullable, populated by U1 (CI-Portal token `sub`).
- `username TEXT UNIQUE` — nullable, populated by U2.
- `password_hash TEXT` — nullable, populated by U2.
- No `auth_kind` column — an owner's auth mode is inferable from which columns are non-null.
- `GLOSSARY.md` updated: owner = user (Phase T's decision #1, now canon).

**Sentinel exclusion (carried over from Phase T's own note, `N-SENTINEL` in `T-multitenant-tickets.md`):** the `SYSTEM_OWNER` row will have all three new columns NULL. **U1's auto-provisioning and U2's login lookup must both explicitly exclude `owners.id = SYSTEM_OWNER_ID`** — a bug that let either flow match against the sentinel row would let an external login silently take over the single-owner dev/test identity. Write a test for this specifically, don't rely on it falling out of other tests.

**Schema & files:** new migration (number TBD per sequencing note above); `server/src/db/schema.ts:8-13`; `docs/GLOSSARY.md`.

**DoD:** columns land, all nullable; existing seeded owner row unaffected; `foreign_key_check`/`integrity_check` clean; a test asserts the sentinel row is excluded from any "find owner by external_subject/username" lookup path (even though those lookups don't exist until U1/U2 — add the schema-level test now, the behavioral one lands with each).

---

## U1 — SSO via CI-Portal (OAuth 2.1 + PKCE, Relying-Party login)

**Status: buildable now, in parallel with getting CI-Portal's endpoint/credential info.** The two remaining inputs (discovery values, client registration) block wiring in the real endpoint, not writing the code — everything below can be built and unit-tested against a fixture, then pointed at the real CI-Portal the moment those two facts arrive.

**Depends on:** U0 (schema). Soft-depends on CI-Portal discovery info for the final integration/end-to-end test.

**This app already does this, for Google.** `server/src/routes/oauth.ts` (428 lines) is a mature, working Authorization-Code + PKCE (S256) OAuth 2.1 client with CSRF state, id_token verification (hand-rolled JWKS fetch + RS256 signature check + `iss`/`aud`/`exp`/`nonce` validation, `server/src/routes/oauth.ts:112-157`), and encrypted token storage. **U1 mirrors this pattern**, not the `jose`-based design from the original `I-identity-auth.md` draft — reuse what's already proven in-house rather than adding a new dependency (`jose`) for a second implementation of the same thing.

Two structural differences from the Google flow, both important:

1. **This is a login, not account-linking.** Google's `/start` requires `currentOwnerId()` to already be resolved (it's "attach a calendar to my existing account"). U1's `/start` runs **before** any owner is known — that's the entire point. So it cannot reuse `oauth_states` as-is: `oauthStates.ownerId` is `NOT NULL` (`server/src/db/schema.ts:496`), which has nothing to bind to pre-login. **Add a new table** (`auth_states` or similar — same shape as `oauth_states` minus `owner_id`, plus the same CSRF `state` + PKCE `code_verifier` + `nonce` + `expires_at` columns) rather than loosening `oauth_states`'s constraint, which other code correctly relies on.
2. **The callback resolves/creates an owner and starts an app session — it does not store a `connection_tokens` row.** After verifying the id_token: map `sub` -> `owners.external_subject`; no match + `AUTH_AUTO_PROVISION=true` (existing flag, `config.ts:117`, currently dead) -> create one (a real production `createOwner()` needs to exist — today the only `createOwner` is a **test-only** raw-SQL helper, `server/test/helpers.ts:130`); no match + auto-provision off -> 403. **Exclude `SYSTEM_OWNER_ID`** from the lookup (U0's sentinel note — same requirement as U2's local login). Then issue the same session mechanism U2 uses (signed httpOnly cookie via `ctx.cookies.set(...)`) so post-login requests flow through `requireAuth` identically regardless of which path authenticated them.

**New/changed files:**
- New `server/src/lib/auth/ciPortal.ts` (or generalize `oauth.ts`'s `verifyIdToken` into a shared `lib/auth/verifyOidcIdToken.ts` used by both Google and CI-Portal — recommended, avoids two copies of security-sensitive JWKS/signature code) — the token-exchange + id_token verification, config-driven (issuer/JWKS URL/audience from CI-Portal's discovery, not hardcoded like Google's `GOOGLE_ISSUERS` set).
- New config block in `server/src/lib/config.ts`, parallel to `GoogleConfig`: `clientId`, `clientSecret?` (only if CI-Portal is confidential-client — TBD per the open registration question), `authorizationEndpoint`, `tokenEndpoint`, `jwksUri`, `issuer`, `redirectUri`. New env vars: `CIPORTAL_CLIENT_ID`, `CIPORTAL_CLIENT_SECRET` (optional), `CIPORTAL_ISSUER`, `CIPORTAL_AUTHORIZE_URI`, `CIPORTAL_TOKEN_URI`, `CIPORTAL_JWKS_URI`, `CIPORTAL_REDIRECT_URI` — deliberately separate from the existing generic `AUTH_JWKS_URL`/`AUTH_ISSUER`/`AUTH_AUDIENCE` vars in `config.ts` (those were named for a generic future SSO and can either be repointed at these or retired in favor of the `CIPORTAL_*` names — dev team's call, flag it, don't silently pick one).
- New routes `GET /api/auth/ciportal/start` (redirect/return-URL, same shape as Google's `/start`) and `GET /api/auth/ciportal/callback` (public, in `requireAuth.ts`'s `PUBLIC_PREFIXES` alongside the Google callback) in a new `server/src/routes/auth.ts` (shared with U2's local-login routes — one router, `/api/auth/*`).
- Correct the misleading `config.ts` comment (`// sso: ... (CI-Server hub)` -> CI-Portal) while in this file — it's what caused the earlier misidentification.

**Acceptance:** end-to-end against a **fixture** CI-Portal (mirror the existing Google fixture-mode pattern, `config.google.mode === 'fixture'`) before real credentials exist: negative-test matrix — no code, wrong/replayed `state`, expired state row, `alg:none`, `HS256`-forged, wrong `iss`/`aud`, expired token, tampered signature — all rejected; auto-provisioning creates exactly one owner per new `sub`, excludes the sentinel, and a repeat login with the same `sub` reuses the existing owner (no dupes). Once real CI-Portal credentials land: one live end-to-end login test gated behind an env check (skipped in CI, run manually against tailnet).

---

## U2 — Local username/password mode + `DISABLE_OIDC` toggle

**Status: buildable now.** No external blockers — this is the ticket to hand a dev team today.

**Depends on:** U0 (schema).

**New env vars** (append to `server/.env.example`'s Auth (Phase I) block):
```
DISABLE_OIDC=false           # meaningful only when AUTH_MODE=sso; true = local username/password
                              # instead of JWKS verification. test/standalone modes ignore this entirely.
AUTH_DEFAULT_USERNAME=admin   # seeded on first boot if no local users exist
AUTH_DEFAULT_PASSWORD=        # REQUIRED if DISABLE_OIDC=true and zero local users exist — fail closed if unset,
                              # same pattern as the existing GOOGLE_MODE=live guard (config.ts:160-166)
```

**Config (`server/src/lib/config.ts`):** add `disableOidc: boolean` to `AuthConfig` (line ~15, alongside `autoProvision`), read from `process.env.DISABLE_OIDC === 'true'`. Add a boot guard mirroring the existing ones at the bottom of the file (~line 176): `AUTH_MODE === 'sso' && disableOidc && !AUTH_DEFAULT_PASSWORD && <zero local users>` -> throw.

**New dependency:** `argon2` (not currently in `server/package.json`) for password hashing, per `I-identity-auth.md`'s existing guidance ("if local passwords are kept at all, use argon2id; do not introduce bcrypt").

**New file `server/src/lib/auth/password.ts`** (sibling to `apiKey.ts`, same house style):
- `hashPassword(plain): Promise<string>` — argon2id.
- `verifyPassword(hash, plain): Promise<boolean>`.
- `findOwnerByUsername(username)` — SQL lookup on `owners.username`, **excluding `SYSTEM_OWNER_ID`** (U0 sentinel note).
- On first boot with zero local users and `AUTH_DEFAULT_PASSWORD` set: seed one owner row with `username = AUTH_DEFAULT_USERNAME`, `password_hash = hash(AUTH_DEFAULT_PASSWORD)`. Decide where this seeding runs (a migration afterSql vs. a boot-time check in `config.ts`/`app.ts` — boot-time is more consistent with the fail-closed guards already living there).

**New file `server/src/routes/auth.ts`** (shared with U1's CI-Portal routes — one `/api/auth/*` router; no auth router currently exists, check `server/src/routes/index.ts`'s `mountRoutes()` list, it isn't there):
- `POST /api/auth/login` — `{ username, password }` -> verify via `password.ts` -> `ctx.cookies.set('cp_session', signedValue, { signed: true, httpOnly: true, sameSite: 'lax', maxAge: ... })`. Needs `app.keys = [...]` set somewhere (Koa's cookie-signing secret) — new env var, e.g. `SESSION_SECRET`, fail-closed if unset when `DISABLE_OIDC=true`.
- `POST /api/auth/logout` — clear the cookie.
- **`GET /api/auth/config`** — this path is already whitelisted in `requireAuth.ts`'s `PUBLIC_PREFIXES` (line 25: `['/api/health', '/api/auth/config', '/api/oauth/google/callback']`) but **no route currently implements it** — it's dead reference, presumably a placeholder left from an earlier pass. **Reuse this exact path** for the "which auth mode is active" check U3 needs (`{ mode: 'test'|'standalone'|'sso', disableOidc: boolean }`), rather than adding a new `/api/auth/mode` and a second `PUBLIC_PREFIXES` entry — one less moving part, and it closes a small existing gap instead of leaving it dangling.
- Rate-limit `/api/auth/login` using the **already-scaffolded** `config.auth.rateLimit` (`windowMs`/`max`/`issueMax` in `config.ts` — currently defined but unused anywhere in the codebase). This is the first real consumer of that config block.

**`requireAuth.ts` dispatch change:** when `config.auth.mode === 'sso' && config.auth.disableOidc`, verify the session cookie instead of calling `verifyApiKey`/the JWKS path — resolve to the same `VerifiedClaims` shape.

**Acceptance:** wrong password -> 401; locked/disabled account (if that concept is wanted — confirm with owner, not in original spec, flag as a nice-to-have not a blocker) -> 401; boot refuses to start with `DISABLE_OIDC=true` + no default password + zero local users; cookie is `httpOnly` + `signed` + not readable from `document.cookie`; `GET /api/auth/config` reachable with no credential.

---

## U3 — Client-side login screen (SolidJS)

**Depends on:** U2's `/api/auth/login`, `/api/auth/logout`, `/api/auth/config` contracts fixed. Design can start in parallel with U2; build after.

- New `/login` route + `client/src/pages/Login.tsx` (check exact directory convention against an existing page before creating — `client/` is SolidJS + `@solidjs/router`, not React): username + password fields, `createSignal` form state + `showToast` on error, matching `ObjectiveModal.tsx`'s conventions. Colors via CI-Hub-style design tokens (`color_token`, never hex — matching `CategorySettings.tsx`). Icons from `lucide-solid`.
- Route guard in `App.tsx`/`Shell`: on boot, call `GET /api/auth/config`; if `mode === 'sso' && disableOidc` and no valid session, redirect to `/login`. No-op in `test`/`standalone` modes or when `disableOidc` is false — **zero visual/behavioral change** for existing dev/Docker/SSO-without-fallback deployments.
- Logout menu action -> `POST /api/auth/logout` -> redirect to `/login`.
- "Forgot password?" link -> stub pointing at where V's reset modal will mount (V is not built yet — this is just a hook, not a dependency to wait on).
- **Visual parity — deliberately not resolved here.** CI-Server does have a login screen (`frontend/apps/web/src/pages/LoginPage/`) but per the naming correction above, CI-Server isn't the relevant system for this at all — it's a data provider, and its login screen authenticates *CI-Server's own users*, unrelated to CI-Portal or Companion Planning. There is still no CI-Portal or CI-Hub screen available to mirror. **Build house-style** (matching this app's own SolidJS conventions) and treat "match CI-Portal's actual login" as a future reconciliation pass once someone can share it, not a blocker for this ticket.

**Acceptance:** `/login` renders, authenticates against U2's route, redirects to `/` on success; route guard blocks all other routes exactly when `mode==='sso' && disableOidc===true` and no session cookie is present; every other mode combination is visually and behaviorally unchanged from today; logout round-trips (cookie cleared, redirected, guard re-engages).

---

## Suggested order for the dev team

1. **U0** — schema, can start immediately. Coordinate the migration number with Phase T's owner if T2 hasn't merged yet (see U0's sequencing note — real collision risk, not hypothetical).
2. **U2** and **U1** can run **in parallel** once U0 lands — they touch different files (U2: `password.ts` + local login; U1: `ciPortal.ts`/generalized id-token verifier + CI-Portal OAuth routes) and share only the new `server/src/routes/auth.ts` router file and the session-cookie mechanism, both small/mergeable. U1's fixture-mode build-out doesn't need CI-Portal's real credentials; only its final wiring does.
3. **In parallel with both:** ask whoever provisioned CI-Import Tools' or CI-Hub's OAuth client credentials for (a) CI-Portal's discovery values and (b) the registration process for a new consumer. This is a Slack message, not an engineering task — send it today so it's answered by the time U1's code is ready to point at something real.
4. **U3** — start design/component work in parallel with U2/U1, wire up once U2's and U1's routes are stable (client doesn't need to know which one authenticated the session).
