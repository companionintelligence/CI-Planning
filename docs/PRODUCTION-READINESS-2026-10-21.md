# Production readiness review — 2026-10-21

**Scope.** Is Companion Planning ready to launch, with a path for a new user to get an
account or to sign in with Companion Portal the way Companion Memory does? Everything
below was checked against `main` at `011c1a42` (this worktree), the live CI-Marketplace
listing (`apps/ci-planning/`), CI-Hub's app-environment generator, CI-Portal's source
(`origin/dev`) **and the live production Portal**, and Companion-Memory's auth code — not
against this repo's own docs.

Companion docs: [U-auth.md](U-auth.md) (how auth works — see §8 for what is now stale in
it), [AG-multitenant-rbac.md](AG-multitenant-rbac.md) (roles + invites),
[RELEASE-READINESS.md](RELEASE-READINESS.md) (the July plan this supersedes).

---

## 1. Bottom line

**The product is in good shape; the launch path is not wired, and Portal sign-in cannot
work against the real Portal today.** Typecheck, build and both test suites are green;
auth (local login, Portal SSO flow, password reset, roles, invites) is implemented and
well tested; the Hub marketplace install works today with a username/password seeded at
install.

What is **not** ready, in priority order:

| # | Gap | Why it blocks the stated goal |
|---|---|---|
| 0 | **Portal id_tokens cannot be verified.** CI-Portal (better-auth `jwt()` with default key config) signs id_tokens with **EdDSA / Ed25519**; the live JWKS at `https://hub.ci.computer/api/auth/jwks` holds exactly one key, `{"alg":"EdDSA","crv":"Ed25519","kty":"OKP"}`. This app's verifier accepts **only `alg: RS256`** and only `kty: RSA` JWKs (`server/src/lib/auth/verifyOidcIdToken.ts:143,155`). Every real Portal login ends in `400 invalid_id_token`. The flow was proven only against `fixture-portal.ts`, which issues RS256. | "Sign in with Companion Portal" fails 100 % of the time against production, regardless of configuration. |
| 1 | **Portal sign-in is unreachable in the production install path.** The marketplace listing pins `DISABLE_OIDC=true`; the default issuer is the *dev* portal (`hub.companionintelligence.com`; production is `hub.ci.computer`); the manifest does not ask the Hub for the paired issuer; `AUTH_AUTO_PROVISION` defaults to `false` (every first portal login → 403); and in OIDC mode nothing ever creates an operator. | Even after #0, no real install offers the portal button. |
| 2 | **No self-serve new-user path.** The only way to get a second account is an operator invite from Settings → Accounts. The login screen shows exactly one method (portal *or* password, never both) and has no sign-up affordance. | Memory offers "Sign in with Companion account", email/password, and "Don't have an account? Sign up" on one screen. |
| 3 | **The release pipeline is switched off.** `ci.yml` and `docker-publish.yml` are `workflow_dispatch`-only since #618 (2026-10-08). The published `:latest` image (`sha-e598ba0`, 2026-09-06) is 14 commits behind `main` and **predates the CORS allowlist security fix (#608)**. | Nothing merged reaches users; the image in the store has a known security gap. |
| 4 | Second-order: `docker-compose.yml` demands a Postgres the app does not use; a `wip(...)` commit sits on `main` (#615); no security headers; the container smoke test never exercises login; no Hub forward-auth (edge SSO); version/tag drift (`package.json` 0.3.0 vs tag `v4.1.0`, 1,504 commits since). | Self-host friction, trust, and operability. None blocks a Hub install on its own. |

The critical path to "Portal sign-in + new users on a Hub" is **A0–A6 + B1 + C1–C2**:
roughly two to three focused weeks for one engineer, with the CI-Marketplace change
(and possibly a CI-Portal change) landing in those repos.

---

## 2. What was verified working

| Area | Evidence (run in this worktree, 2026-10-21) |
|---|---|
| Typecheck | `tsc --noEmit` clean in `server/` and `client/` |
| Client build | `vite build` succeeds (one >500 kB chunk warning — pre-existing) |
| Client tests | **94 files, 1,212 tests passed** |
| Server tests | **273 files passed, 3 skipped; 3,582 tests passed, 30 skipped** (682 s on the shared dev box) |
| Local login (U2) | `POST /api/auth/login`, argon2id, constant-work verify, generic 401, per-IP 429, first-owner seed from `AUTH_DEFAULT_*`, fail-closed boot without a login path (`lib/auth/localBootstrap.ts`) |
| Portal SSO flow (U1) | OAuth 2.1 + PKCE RP flow with discovery, `iss`/`aud`/`azp`/nonce/skew checks, discovery-origin pinning, state bound to the starting browser (`routes/auth.ts`); negative matrix in `server/test/ciportal-auth.test.ts`. **Signature verification is RS256-only — see #0.** |
| Sessions | Signed httpOnly `cp_session`, `SameSite=Lax`, `Secure` when the request is HTTPS (`TRUST_PROXY` honours `X-Forwarded-Proto`), epoch-based revocation on password reset / role change |
| Password reset (V) | `reset-request` / `reset` with single-use tokens, SMTP or console transport, enumeration-neutral |
| Roles + invites (AG) | operator / member / viewer; `POST /api/accounts` mints a password-less account and emails a 7-day set-password link (link shown to the operator when SMTP is absent); last-operator lockout guard; Settings → Accounts UI |
| Boot guards | `AUTH_MODE=test` refused in production; `sso` requires `SESSION_SECRET` (auto-provisioned to `.session-secret` beside the DB when unset); unknown `AUTH_MODE` refused |
| Container | Multi-arch image, `HEALTHCHECK` on `/api/health`, SIGTERM checkpoints the SQLite WAL, `/data/.env` overrides, Sentry opt-out with kill switches |
| Secrets hygiene | No key material in tracked files; `.env*`, `*.db`, `.session-secret`, `data/` ignored; only the two `.env.example` files tracked |
| Marketplace install | `CI-Marketplace/apps/ci-planning/docker-compose.json` runs the image with `AUTH_MODE=sso`, `DISABLE_OIDC=true`, operator-supplied admin password, `TRUST_PROXY=true`, `PUBLIC_BASE_URL=${APP_BASE_URL}`, `CP_KEK_B64` auto-generated |
| Portal registration | `ci-planning` is a first-party public PKCE client in CI-Portal (`oidcClients.ts:27`), callbacks `/api/auth/ciportal/callback` + `/api/memory/ciportal/callback` (`firstPartyRedirect.ts:357-360`) |

Not verified here: a live login round-trip against the Portal (it would fail at #0), and
the published image's runtime behaviour (CI's screenshot gate runs it in `standalone`
mode, so the login screen is never rendered in CI).

---

## 3. The Portal contract (facts the plan is built on)

From CI-Portal `origin/dev` (2b13b381) and the live discovery document.

| Fact | Value |
|---|---|
| Issuer (`iss` claim) | bare origin; discovery base is `<origin>/api/auth` |
| Origins | prod **`https://hub.ci.computer`** · staging `hub.companionintel.com` · dev `hub.companionintelligence.com` · local `hub.ci.localhost` |
| Endpoints | `/api/auth/oauth2/{authorize,token,userinfo,register,endsession}`, `/api/auth/jwks` |
| Scopes / grants | `openid profile email offline_access`; `code` only; PKCE **S256 required** |
| id_token | **EdDSA (Ed25519)**, `kid`-matched; `aud = client_id`; `exp = iat + 3600`; claims `sub iss aud iat exp auth_time nonce acr` + `name given_name family_name profile updated_at` (profile) + `email email_verified` (email). No org / device claims by design. |
| Access / refresh | opaque access token (1 h, works at `userinfo`); refresh (7 d) only with `offline_access` |
| Client registration | **static list in code** (`PUBLIC_CLIENTS`), no secret; dynamic registration yields confidential clients that the bearer middleware rejects — not usable for this app |
| Redirect-URI rules (no wildcards) | 1 **on-device**: any port/path on `localhost`, `*.localhost`, `*.local`, RFC1918, `127/8`, `::1` — the only case that skips consent · 2 **provisioned tunnel host**: `https://ci-planning-<device>-<org>.<root>` + one of the two registered paths, user must be an org member · 3 **tailnet**: host must equal a paired device's self-reported `tailscale_dns` (device check-in), user must be in that device's org; the old blanket `.ts.net` allowance is gone · 4 verified custom-domain alias of 2 |
| Sign-up | open self-serve (email + verification, passkey, 2FA); `/login` and `/signup` are the same card with a client-side toggle; **no `screen_hint` / `prompt=create`** — an RP just sends users to `/oauth2/authorize`, and an unauthenticated authorize round-trips through login/sign-up and `/api/oidc-resume` (10-minute window) |
| New-user constraint | a brand-new Portal account has no org and no device: on a tunnel or tailnet host `/authorize` answers **400 "Invalid redirect URI"** until the user is a member of the org that owns the Hub; on-device redirects work immediately |
| Hub injection | CI-Hub writes `<CI_CLOUD_URL>/<issuer_path>` into the env var named by a manifest's `hub_integration.oidc.issuer_env`; it injects **only the issuer** (no client id / secret). Declaring `hub_integration.oidc` also makes the Hub provision `HUB_URL`, a managed Hub API key, and `CI_HUB_FORWARD_AUTH_ENABLED/SECRET` for official-store apps (`app.helpers.ts:127-150, 740-800, 880-900`). The exchange is RP ↔ Portal over public HTTPS; nothing is Hub-mediated. |

---

## 4. Gap analysis: Companion Planning vs Companion Memory

Memory is the reference the owner named. Its auth lives in `backend/apps/api/src/domains/auth/`
(NestJS). The comparison that matters for launch:

| Concern | Companion Memory (today) | Companion Planning (today) | Gap |
|---|---|---|---|
| Methods offered | Portal + email/password + sign-up are **always mounted**; no mode switch | One of three `AUTH_MODE`s; inside `sso`, `DISABLE_OIDC` picks **either** portal **or** password | Either/or UI and config |
| Login screen | Primary **"Sign in with Companion account"**, "Sign in with email instead", "Don't have an account? Sign up" | "Continue with CI-Portal" **or** username/password; no sign-up link | UI + naming |
| Sign-up | `/signup` page (name, email, password, optional invite code) + "Sign up with CI Portal" | None; operator invite only (owner ruling 2026-07-12) | Product decision + build |
| First user | First account on an empty appliance becomes **admin**, local or via Portal (advisory-locked `createFirstAccount`) | Local: seeded from env as operator. **Portal: never** — auto-provisioned users are always `member`, and no bootstrap runs in OIDC mode | Operator bootstrap under OIDC |
| Later users via Portal | Admitted with an invite code, or when Hub forward-auth headers verify; else `signup_code_required`. Hub installs set `ENABLE_REQUIRE_SIGNUP_CODES=false` | 403 unless `AUTH_AUTO_PROVISION=true` (default false; the listing does not set it) | Policy + manifest |
| First-time portal sign-in UX | No-JS "Create account?" confirmation page before the account is created | Silent provision (when allowed) | Nice-to-have |
| Portal issuer | `OIDC_ISSUER_URL`, **injected by CI-Hub** (bare origin) | `CIPORTAL_ISSUER` (`<origin>/api/auth`), defaults to the **dev** origin; not Hub-injected | Wrong default; manifest |
| Token verification | id_token decoded only; identity from **userinfo**; no nonce — so the EdDSA question never arose | Signature-verified, nonce enforced — but **RS256-only** | #0: add EdDSA; keep the stronger posture |
| Client id | `ci-server`, redirect `/api/authenticate/oidc/callback` | `ci-planning`, both callbacks registered | — |
| Hub edge SSO (forward-auth) | Verifies Hub-signed `x-ci-hub-user` / `-timestamp` / `-signature` (+ stable-id triple), HMAC-SHA256, 5-min skew (`common/crypto/hub-forward-auth.ts`) | Not implemented; the material would arrive (once the manifest declares `hub_integration.oidc`) and be ignored | Second sign-in on a Hub |
| Session | HS256 JWT cookie + CSRF double-submit; server-side rows; 7 d | Signed cookie `ownerId.epoch`; stateless; `SameSite=Lax`; JSON-only API | Equivalent for this app |

---

## 5. Work plan

Sizes: **S** ≤ 1 day · **M** 2–4 days · **L** ≥ 1 week. "Repo" says where the change lands.
Each item has a definition of done (DoD). Dependencies are explicit; everything else can
run in parallel.

### Track A — Portal sign-in that actually works, reachable in production (critical path)

| ID | Item | Repo | Size | DoD |
|---|---|---|---|---|
| **A0** | **Verify EdDSA id_tokens.** _Implemented on this branch, 2026-10-21 (verifier, fixture portal, tests, docs); the live-token capture is still open and folds into A6._ In `verifyOidcIdToken.ts` accept `alg: EdDSA` with `kty: OKP, crv: Ed25519` JWKs (node:crypto `verify(null, data, key, sig)`), keep RS256 for Google, reject everything else exactly as now. Make `fixture-portal.ts` issue EdDSA by default (RS256 behind a flag) so the fixture matches production. | CI-Planning | S | `ciportal-auth.test.ts` gains the EdDSA happy path + `alg` confusion cases (EdDSA token vs RSA key, RS256 header on an OKP key, `crv` ≠ Ed25519); `oauth.test.ts` (Google, RS256) unchanged; a token minted by the live Portal (captured once, `exp` ignored under a test flag) verifies. |
| **A1** | **Fix the default issuer and naming.** _Implemented on this branch, 2026-10-21._ Default `CIPORTAL_ISSUER` → `https://hub.ci.computer/api/auth`; document the dev/staging/local origins as overrides. Rename user-facing "CI-Portal" → "Companion Portal" (login button, error copy, Settings); keep env names. | CI-Planning | S | `config.ts:426`, README env table, `server/.env.example`, `U-auth.md` agree; `Login.tsx` says "Continue with Companion Portal"; tests updated. |
| **A2** | **Declare the Hub OIDC integration in the manifest.** `apps/ci-planning/config.json`: add `"oidc": { "issuer_env": "CIPORTAL_ISSUER", "issuer_path": "api/auth" }` under `hub_integration`; `docker-compose.json`: drop `DISABLE_OIDC=true`, add `AUTH_AUTO_PROVISION=true`; keep `AUTH_DEFAULT_*` as the break-glass local operator (A3). Confirm the Hub release that ships `hub_integration.oidc` and raise `min_hub_version` to it. | CI-Marketplace | S | A fresh install on a paired Hub boots with the paired issuer injected and the login screen offers the portal. |
| **A3** | **Operator bootstrap under OIDC** (Memory parity). _Implemented on this branch, 2026-10-21; local login and password reset are now served in both `sso` sub-modes, so the break-glass operator can sign in via the API before A4 adds it to the screen, and operator invites (which complete through `/api/auth/reset`) work under Portal mode. Full server suite: 3,599 passed after updating the one test that pinned the old reset gating._ When the instance has **no operator** and a portal login provisions the first owner, that owner becomes `operator`, inside the same transaction as `provisionOwner`, with an operator-count re-check to survive two concurrent first logins. Later portal users stay `member`. Also honour `AUTH_DEFAULT_*` in OIDC mode so the install-time password still seeds a break-glass local operator. | CI-Planning | M | `ciportal-auth.test.ts`: first-login-claims-operator, second-is-member, concurrent-first-login race, sentinel excluded; `local-auth.test.ts`: env seed under OIDC mode. |
| **A4** | **Both methods on one screen, driven by server capability flags.** _Implemented on this branch, 2026-10-21: `GET /api/auth/config` now returns `{ mode, disableOidc, portal, local, signup }` (`authConfigPayload()` in `routes/auth.ts`); `Login.tsx` is flag-driven with the username form folded behind "Sign in with username instead" when both are on; `client/src/views/Login.test.tsx` covers every flag combination and both `?sso_error=` renderings; `local-auth.test.ts` pins the payload per mode._ `GET /api/auth/config` → `{ mode, portal: bool, local: bool, signup: 'portal' \| 'invite' \| 'open' \| 'off' }` (keep `disableOidc` for one release). `Login.tsx`: primary "Continue with Companion Portal", secondary "Sign in with username instead" (expand in place), "Forgot password?" under the local form, and the B1 link. `DISABLE_OIDC=true` still means portal off. | CI-Planning | M | Client tests for every combination; `test`/`standalone` stay ungated and byte-identical. |
| **A5** | **Redirect coverage on every entry point.** _Resolved on this branch, 2026-10-21: (1) the Portal applies its redirect check only after the user signs in there (unauthenticated `/authorize` probes 302 to `/login` for every host shape), so host coverage rests on its source rules, which the registration already satisfies for the tunnel host and tailnet hosts; (2) CI-Hub ADR 001 made local access `http://127.0.0.1:<port>` and deprecated LAN hostnames, so no Portal change is needed for LAN; (3) the app now sends a loopback `redirect_uri` for a local-open browser (`loginRedirectUriFor` in `routes/auth.ts`) instead of bouncing the user to the tunnel host — tested. The live round-trips from a paired Hub fold into A6._ With the Portal's rules in §3: the Hub tunnel host and tailnet host are covered by the existing registration once the device has checked in; **local open** (`http://127.0.0.1:<port>`, ADR 001) is covered by the on-device rule. Verify each from a paired dev Hub; if the Hub's LAN hostname (`*.<localDomain>`) is used, it is **not** in any Portal rule — either route users through the tunnel/tailnet host for login or add that pattern in CI-Portal `firstPartyRedirect.ts`. | CI-Planning (+CI-Portal if needed) | S–M | A login round-trip succeeds from the tunnel host, the tailnet host and local open; the LAN-host decision is written down. |
| **A6** | **End-to-end proof on a Hub.** _Local stand-in complete on this branch, 2026-10-21 (real browser through the built client against the EdDSA fixture: Portal button → consent → confirm-account → operator; second login member; break-glass login; sign-out; local-login expander; `/signup`). The on-Hub run is still open — the checklist with expected results is in `docs/U-auth.md` §"Verified on a Hub (A6)" and needs a paired dev Hub plus two Portal accounts._ Install from the store on a paired dev Hub; sign in with a Portal account → operator (A3); second Portal account (org member) → member; non-member Portal account → the Portal's 400 is surfaced as a readable error on `/login?sso_error=`; sign out; break-glass local login. Record it in `U-auth.md` §"Verified on a Hub" with the Hub/Portal versions. | CI-Planning (+Hub) | S | Checklist with dates in the doc. |

Dependencies: A0 first (everything else is untestable against production without it);
A3 → A4 (the config payload carries the sign-up policy); A2 after A1; A6 last.

### Track B — A new-user path

**Decision needed (see §6):** which of these the owner wants. Recommendation in bold.

| ID | Item | Repo | Size | DoD |
|---|---|---|---|---|
| **B1** | **Portal is the sign-up path (recommended).** _Implemented on this branch, 2026-10-21: the "Don't have an account? Create one with Companion Portal" line (same `/start` URL) plus the org-membership hint render whenever `signup === 'portal'`; `invalid_redirect_uri` / `access_denied` / `unauthorized_client` on `/login?sso_error=` read as "Ask your Hub's owner to invite you to the organization, then try again", everything else keeps the generic copy. On return the B3 confirmation creates the owner through the A3 path. The live non-member round-trip itself is A6's to record._ Login screen gets "Don't have an account? **Create one with Companion Portal**" → the same `/api/auth/ciportal/start` (the Portal has no `screen_hint`; its login card carries the sign-up toggle and `oidc-resume` brings the user back). On return, A3 provisions the owner. Copy must say that on a Hub the new account also needs to be **invited into the Hub's organization** first (Portal rule in §3), and the `/login` error view must render the Portal's "Invalid redirect URI"/membership refusal as "Ask your Hub's owner to invite you to the organization". | CI-Planning | S | Link present whenever `portal` is on; a brand-new Portal account that is an org member ends in a functional owner (G-BASETAG seeds); a non-member gets the actionable message. |
| **B2** | **Invite-code sign-up for local mode** (Memory's `signup_code` model; keeps the 2026-07-12 "operator never sees a password" ruling). _Implemented on this branch, 2026-10-21: `AUTH_SIGNUP=open \| invite \| off` (default `invite`, validated at boot); `signup_codes` table (migration 0172, hashed at rest, 7-day TTL, single-use via one guarded UPDATE, revocable); operator routes `GET/POST /api/accounts/signup-codes` + `DELETE …/:id` with the Settings → Accounts "Invite codes" section; public `GET /api/auth/signup/requirements` + rate-limited `POST /api/auth/signup` provisioning through `provisionOwner({ claimOperatorIfNone })`; `/signup` page with the Portal alternative. Tests: `server/test/signup.test.ts`, the B2 block in `accounts.test.ts`, `client/src/views/Signup.test.tsx`._ Operator mints codes in Settings → Accounts; `/signup` takes name, username, email, password, code; `GET /api/auth/signup/requirements` tells the page whether a code is required. `AUTH_SIGNUP=open \| invite \| off` (Hub manifest: `invite`). | CI-Planning | M | `signup.test.ts`: code required / consumed once / expires; `open` only when configured; rate-limited; first account becomes operator via A3's path. |
| **B3** | **First-time portal sign-in confirmation** ("Create account?" page before provisioning, as Memory does on web) — prevents accidental tenant creation from the wrong Portal account. _Implemented on this branch, 2026-10-21: the callback parks an unknown `sub` in a Koa-signed httpOnly `cp_portal_intent` cookie (verified sub/name/email + CSRF token + server-enforced 10-minute `exp`, `lib/auth/portalIntent.ts`) and redirects to the self-contained no-JS `GET /api/auth/ciportal/confirm-account` page; `POST` with `decision=create` provisions via the shared A3 path and signs in, `cancel` clears and returns to `/login`; a sentinel-held sub is refused before the page. `ciportal-auth.test.ts` drives every provisioning case through the step and adds decline / expired / tampered / CSRF / policy-flip / two-tab cases._ | CI-Planning | S | No-JS page, CSRF-bound, 10-minute signed intent cookie; declining provisions nothing. |

If the owner keeps invite-only onboarding, B1 alone satisfies "a path to make a new
user" because the Portal owns sign-up; B2 is then optional.

### Track C — Turn the release pipeline back on

| ID | Item | Repo | Size | DoD |
|---|---|---|---|---|
| **C1** | **Restore CI triggers** (`push` to `main`, `pull_request`) on `ci.yml` and `style-canon-lint.yml`; restore `docker-publish.yml` on `push` to `main` + tags. If the cost pass that gated them must stand, keep `pull_request` + tag-only publish at minimum and say so in the workflow header. | CI-Planning | S | A PR run and a `main` run visible in Actions; `:latest` republished from current `main` (closes the CORS-fix gap). |
| **C2** | **Cut a release.** Tag `v4.2.0` (and move `package.json` onto the tag line), bake `CI_PLANNING_VERSION` into the image build, add a `CHANGELOG.md` seeded from #591–#618. Pin the marketplace listing to the tag or a digest instead of `latest` (Memory pins digests). | CI-Planning + CI-Marketplace | S | `GET /api/health` reports the release; the store listing points at an immutable tag. |
| **C3** | **Exercise login in the container gate.** Two Playwright specs in `tests/container/`: local login (container in `sso` + `DISABLE_OIDC=true`) and portal login against `fixture-portal.ts` (EdDSA after A0) running beside it. | CI-Planning | M | Both pass in `docker-publish.yml` before the push step. |
| **C4** | **Fresh-clone install works without ceremony.** pnpm 11 ignores the `${NODE_AUTH_TOKEN}` placeholder in the repo `.npmrc` ("environment variables are not expanded in repository-controlled registry credentials"), so `pnpm install` fails the supply-chain check on the private `@companionintelligence/*` packages until a user-level npmrc carries the token. Copy CI-Portal's `scripts/gh-packages-auth.sh`; document it in CONTRIBUTING. | CI-Planning | S | `scripts/gh-packages-auth.sh --install` succeeds from a clean clone with only `gh auth login`. |

### Track D — Hardening and operability (should-have before a public launch)

| ID | Item | Repo | Size | DoD |
|---|---|---|---|---|
| **D1** | **Hub edge SSO (forward-auth).** When `CI_HUB_FORWARD_AUTH_ENABLED=true`, accept the Hub-signed identity headers (`x-ci-hub-user`, `-timestamp`, `-signature`, plus the stable-id triple), HMAC-SHA256 with 5-minute skew, map `(issuer, user-id)` → owner the way `external_subject` does, mint the normal session. The Hub injects the per-app secret once A2 lands. | CI-Planning | M | A Hub-logged-in user opening the app is signed in without a second prompt; forged / expired / replayed headers rejected (port Memory's test matrix). |
| **D2** | **Security headers.** `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors`, a CSP that admits the SPA and `/api`, HSTS when `ctx.protocol === 'https'`. One middleware in `app.ts`. | CI-Planning | S | Headers present on `/` and `/api/*`; container spec asserts them. |
| **D3** | **Self-host compose no longer requires Postgres.** Move `postgres` and `DATABASE_URL` behind a `postgres` profile, or delete them until the cutover ships (`feat/postgres-cutover` is 63 commits ahead of `main`, unmerged, with one known blocker: `sync_events.seq`). The README already says Postgres is "not a supported deployment option yet". | CI-Planning | S | `cp .env.example .env && docker compose up -d` boots with only `SESSION_SECRET` + admin login set. |
| **D4** | **Settle the WIP on `main`.** #615 was merged as `wip(scheduling)`; its message notes a pre-existing `triality-metrics` failure. Finish it under a real title or document it as shipped behaviour (AD1 pinning) in `AD-calendar-reliability.md`. | CI-Planning | S | No `wip` in the shipped changelog; the test it mentions is green or quarantined with a reason. |
| **D5** | **Login observability.** Audit-log `login`, `logout`, `provision`, `reset`, `invite` via the existing `writeAudit`; surface them on the Settings → Logs tab. | CI-Planning | S | An operator can see who signed in and when. |

### Track E — Docs and marketing readiness

| ID | Item | Repo | Size | DoD |
|---|---|---|---|---|
| **E1** | Rewrite README §"Run with Docker (CI Hub)" and the env table for the post-A world: portal first, local second, break-glass third; fix the stale `AUTH_MODE=sso (JWKS-verified Bearer JWT)` comment in `server/.env.example`; apply §8 to `U-auth.md`. _README (Docker/Compose sections, env table, API rows), CONTRIBUTING (fresh-clone install) and the RELEASE-READINESS pointer implemented on this branch, 2026-10-21; the `.env.example` comment and the §8 edits to `U-auth.md` belong to track-b-signup's files and are handed over as text in that session's report. The README env table carries a `<!-- AUTH_SIGNUP rows: added by track-b-signup -->` marker for the sign-up rows._ | CI-Planning | S | Docs match `GET /api/auth/config` and §3. |
| **E2** | Marketplace listing copy: "Sign in with your Companion account"; drop "No telemetry" (crash reporting is opt-out since Sentry landed). | CI-Marketplace | S | Listing is truthful. |
| **E3** | Re-capture screenshots/video with synthetic data (open item from the 2026-08-15 handoff). _Implemented on this branch, 2026-10-21: all 14 PNGs under `docs/screenshots/` + `docs/ui/` (plus the theme-toggle GIF) and all 18 stills under `video/assets/shots/` re-shot from the committed synthetic stage (`seed --no-llm --target=40` + `POST /api/demo/sample-data` for the docs; `video/stage.sh` + `scripts/stage-data.sh` for the film, which were fixed to the #563 fixture titles). Still open: the login screens (`docs/screenshots/login-screens.html` and any login PNG) wait for track-b-signup's new login screen._ | CI-Planning | L | No real names in any committed image. |

---

## 6. Decisions needed from the owner

1. **Sign-up policy.** Portal-only (B1), invite-code local sign-up (B2), or open local sign-up? Recommendation: **B1 + B2 with `invite` as the Hub default** — on a Hub, "trusted" means "a member of the Hub's Portal organization", which the Portal already enforces at the redirect check, so `AUTH_AUTO_PROVISION=true` is safe there.
2. **Who is the operator on a Portal-only install?** Recommendation: **first portal login claims it** (A3), with the install-time admin password kept as break-glass.
3. ~~**Hub LAN hostname login.**~~ Closed by A5: CI-Hub ADR 001 already replaced LAN hostnames with `http://127.0.0.1:<port>` local open, which the Portal's on-device rule accepts; the app now returns local-open logins to that loopback host.
4. **CI cost vs. safety.** Restore automatic CI fully (C1) or PR-only? Recommendation: PR + `main` CI, tag-only image publish.
5. **Release line.** Continue `v4.x` tags (the last tag is `v4.1.0`) or re-base on `package.json`'s `0.3.0`? Recommendation: tags win; bump `package.json` to `4.2.0`.
6. **Postgres.** Park the cutover branch (D3) or schedule it? It is not on the launch path.

---

## 7. Suggested sequencing

```
week 1   A0 ─ A1 ─┬─ A2 ────────────────┐
                  ├─ A3 ─ A4 ─ B1 ──────┤── A6 (on a dev Hub)
                  └─ C1 ─ C2 ─ C4       │
week 2   A5 ─────────────────────────────┘   B2, B3, C3, D2, D3, D4
week 3   D1 (forward-auth), D5, E1, E2 ── launch review
later    E3, Postgres cutover
```

---

## 8. Claims in `U-auth.md` that are now wrong

- "Only an **RS256** signature is accepted" is presented as a security property; against
  the real Portal it is the reason login cannot succeed (#0).
- "Self-hosted `*.ts.net` installs match on host alone and never needed either
  registration" — the Portal removed the blanket `.ts.net` allowance; tailnet hosts must
  match a paired device's checked-in `tailscale_dns` and the user must be in its org.
- "discovery issuer is `https://hub.companionintelligence.com/api/auth` (now the
  default)" — that is the **dev** origin; production is `https://hub.ci.computer/api/auth`.
- "Cookie `Secure` flag: omitted deliberately" — superseded; it is set per request over
  HTTPS and the Hub sets `TRUST_PROXY=true`.

---

## 9. Evidence log

- `pnpm install --frozen-lockfile` (with a user-level npmrc token) → 806 packages, lockfile passes the supply-chain policy.
- `server/node_modules/.bin/tsc --noEmit` → clean; `client/…/tsc --noEmit` → clean; `vite build` → ok.
- `client: vitest run` → 94 files / 1,212 passed.
- `server: LOG_LEVEL=error GOOGLE_MODE=fixture vitest run` → 273 files passed / 3 skipped; 3,582 tests passed / 30 skipped; 682.7 s. (Stderr shows `Premature close` and `store not initialised` log lines from `sse.test.ts` — noise in passing tests, not failures.)
- `curl https://hub.ci.computer/api/auth/.well-known/openid-configuration` → `issuer: https://hub.ci.computer`, `id_token_signing_alg_values_supported: ["RS256","EdDSA"]`; `curl …/api/auth/jwks` → one key, `alg EdDSA / crv Ed25519 / kty OKP`.
- `better-auth@1.6.33/dist/plugins/jwt/utils.mjs:21-23` → default `keyPairConfig = { alg: "EdDSA", crv: "Ed25519" }`; CI-Portal `createAuth.ts` calls `jwt()` with no overrides.
- `server/src/lib/auth/verifyOidcIdToken.ts:143` → `if (header.alg !== 'RS256') return null;` `:155` → `if (jwk.kty !== 'RSA' …) continue;`. `fixture-portal.ts:36-47,108` → RSA keypair, RS256.
- `gh run list` → last automatic CI on `main` 2026-09-27; `docker-publish` last ran 2026-09-06 (manual); workflows gated 2026-10-08 (#618).
- `gh api …/packages/container/ci-planning/versions` → `latest` = `sha-e598ba0`, created 2026-09-06; `git merge-base --is-ancestor f10a5f84 e598ba0` → false (CORS fix not in the image); `git log e598ba0..main | wc -l` → 14.
- `CI-Marketplace/apps/ci-planning/docker-compose.json` → `AUTH_MODE=sso`, `DISABLE_OIDC=true`, `TRUST_PROXY=true`, `PUBLIC_BASE_URL=${APP_BASE_URL}`; `config.json` → `hub_integration.inference` only.
- `CI-Hub/packages/backend/src/modules/apps/app.helpers.ts:127-150, 740-800, 880-900` → `hub_integration.oidc` injection, `needsHubAppKey`, forward-auth secret injection.
- CI-Portal (`origin/dev`): `wrangler.jsonc` origins; `domains/core/services/oidcClients.ts:11-65`; `firstPartyRedirect.ts:325-380, 357-360, 641-915`; `createAuth.ts:662-679, 905`; `routes/api/oidc-resume.ts`.
- `Companion-Memory/backend/apps/api/src/domains/auth/controllers/OidcController.ts`, `SignupController.ts`, `common/crypto/hub-forward-auth.ts`; `frontend/apps/web/src/pages/LoginPage/LoginPage.tsx`, `SignupPage.tsx`.
- Open GitHub issues: 7 (M1–M5 deferred multi-user sharing, #518 video plates, #575 Memory feed) — none are launch blockers.
