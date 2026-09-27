# U — OIDC (hub.companionintelligence.com) + local username/password fallback — planning doc

**Status:** Planning only. **Depends on:** Phase T (owners schema decisions). Companion to [I-identity-auth.md](I-identity-auth.md) — read that first; this phase **completes and redirects** work it already speced but never shipped, plus adds something it never speced at all (local username/password login).

> **Needs external input before this can go from draft to buildable — see RELEASE-READINESS.md.** I don't have hub.companionintelligence.com's OIDC discovery document, client registration process, or how CI-Import Tools/CI-Hub register as consumers today. Everything OIDC-specific below is standard-practice-shaped, not confirmed against your actual Hub.

## What already exists vs. what's new

`I-identity-auth.md` already speced two of three auth modes, and **PR1 (the API-key "standalone" mode) actually shipped** — confirmed in code (`server/src/lib/auth/requireAuth.ts`, `apiKey.ts`). **PR2 (the SSO/JWKS Bearer path) was speced but never built** — confirmed by comments still in the code today: `requireAuth.ts` literally says *"SSO Bearer path is added in PR2"*, and `config.ts` marks `jwksUrl`/`issuer`/`contractVersion` as `// (PR2)`. There is no `auth/jwks.ts` file and no `jwtVerify`/`createRemoteJWKSet` call anywhere in `server/src` — the only JWKS code that exists verifies **Google's** id_token for the calendar connector, unrelated to Hub login.

So: **U1 below is "finish what was already designed."** **U2 (local username/password with a toggle and default credentials) is genuinely new** — the existing spec's "standalone" mode is API-key-only (for headless/Docker use), not a login form with a password. Your ask is for a third, human-facing login mode.

## U1 — Finish the SSO path, pointed at hub.companionintelligence.com

The existing design in `I-identity-auth.md` (JWKS verify-only, `jose` library, `createRemoteJWKSet` + `jwtVerify`, algorithm allow-list RS256/EdDSA only, never `alg:none`/`HS*`) is sound and doesn't need to change — it just needs to actually be built, and its `AUTH_JWKS_URL`/`AUTH_ISSUER` pointed at your Hub instead of being generic placeholders. Concretely:

- `AUTH_ISSUER` = hub.companionintelligence.com's OIDC issuer URL.
- `AUTH_JWKS_URL` = the Hub's published JWKS endpoint (from its `.well-known/openid-configuration`).
- **Reachability over Tailscale:** the app already uses Tailscale for its own MCP HTTP endpoint (`CLAUDE_COWORK.md` documents `http://100.x.x.x:3847/mcp`), so there's precedent — the JWKS fetch and any token-exchange calls to the Hub need to resolve over the tailnet, which likely just means the deployment's network config allows outbound tailnet access, not new app code. Confirm whether hub.companionintelligence.com is *only* reachable via Tailscale (no public DNS) — if so, the JWKS client's cooldown/retry behavior (`jose`'s `createRemoteJWKSet` cache) should tolerate transient tailnet hiccups gracefully rather than hard-failing every request.
- **Becoming an OIDC consumer like CI-Import Tools/CI-Hub:** this app needs to register as a client with the Hub (get a `client_id`, and a `client_secret` if using a confidential-client flow, or just validate tokens if it's verify-only/resource-server-only as `I-identity-auth.md` specifies). **Open question:** does Companion Planning need to *initiate* logins (redirect users to the Hub to sign in, receive a token back — an actual OIDC Relying Party flow), or does it only *verify* tokens minted elsewhere (the narrower "resource server" role `I-identity-auth.md` explicitly scoped it to)? Your phrasing ("OIDC consumer... like CI-Import Tools, CI-Hub") suggests the former — a real login redirect — which is a **larger scope than what's currently speced** (verify-only assumes some other app already got the user a token; a login redirect means this app drives the OIDC Authorization Code flow itself). This needs a decision: verify-only (smaller) vs. full RP login flow (larger, but matches "consumer" framing more literally).
- `owners.external_subject TEXT UNIQUE` (from T) maps the JWT `sub` claim to a local owner row. First-login provisioning behavior (`autoProvision` config flag, already sketched) needs a product decision: does a new Hub-authenticated user automatically get a new Companion Planning owner row, or must an admin pre-approve? For a personal tool, auto-provision-on-first-valid-token is the natural default.

## U2 — Local username/password mode + the disable-OIDC toggle

New work, no existing spec to build from. Proposed shape, consistent with the existing `AuthMode` pattern in `config.ts`:

```ts
export type AuthMode = 'test' | 'standalone' | 'sso' | 'local';  // 'local' is new
```

Using the **existing `AUTH_MODE` variable** as the toggle (set it to `'local'` to fully disable OIDC and run username/password instead) is simpler and more consistent than adding a second, separate boolean flag next to it — one variable, one source of truth for "which auth system is active," matching the pattern the codebase already uses for `standalone` vs `sso`. Flag if you'd specifically prefer a separate `DISABLE_OIDC=true` flag layered on top of `AUTH_MODE=sso` instead (e.g., for a deployment that wants to keep `sso` configured but temporarily fall back) — that's a valid alternative, just a different shape.

New env vars (drafted for Y to fold into `.env.example`):

```
AUTH_MODE=local                    # disables OIDC entirely; local login only
AUTH_DEFAULT_USERNAME=admin        # seeded on first boot if no local users exist
AUTH_DEFAULT_PASSWORD=             # required if AUTH_MODE=local and no users exist yet — fail closed if unset, same pattern as the existing GOOGLE_MODE=live guard in config.ts
```

**New schema (belongs to T, but the exact shape is U's call):** `owners` gains `username TEXT UNIQUE` and `password_hash TEXT` (nullable — an OIDC-only owner has no password). Hash with **argon2id**, per `I-identity-auth.md`'s own explicit guidance ("if local passwords are kept at all... use argon2id; do not introduce bcrypt") — that guidance was written for a case the doc then declined to build; U2 is the case it was anticipating.

**Session mechanism for local login:** JWKS/API-key are stateless; a username/password login needs *something* issued back to the browser after a successful login (a session cookie, or a short-lived JWT the app mints itself — note this is different from the SSO path, where the app never mints tokens; for local mode, minting its own session token is unavoidable, and that's fine — it's a *local* trust boundary, not claiming to speak for the Hub). Recommend a signed, httpOnly session cookie (simplest, no client-side token storage/XSS surface) — a decision worth confirming since it's a real architectural choice, not free.

**Default-credentials safety:** the existing `config.ts` pattern of hard-failing boot on unsafe combinations (`AUTH_MODE=test` in production, `GOOGLE_MODE=live` without credentials) should extend here: `AUTH_MODE=local` with no `AUTH_DEFAULT_PASSWORD` set and no local users yet existing should refuse to boot, exactly like the existing guards — a default-credential footgun left silently unset is worse than not shipping the feature.

## U3 — Client-side login screen (was under-specced; added in the 2026-07-01 review)

The earlier draft was entirely server-framed. `AUTH_MODE=local` needs a real UI, and there is none today — the client (`client/`, **SolidJS** + `@solidjs/router`, `lucide-solid`, CI-Hub color tokens, **not React**) has *no* auth-gated routes; every route in `App.tsx` (`/`, `/calendar`, `/inbox`, …) is open because test/standalone mode injects the owner. Local mode changes that. Concretely:

- **New `/login` route + `Login.tsx` screen.** Username + password fields, submit → `POST /api/auth/login` (the U2 route) → on success the server sets the httpOnly session cookie and the screen navigates to `/`. Build it with the app's existing conventions (a `createSignal` form + `showToast` on error, same shape as `ObjectiveModal.tsx`), colours from CI-Hub tokens (`color_token`, never hex — matching `CategorySettings.tsx`), `lucide-solid` icons.
- **Route guard.** In `AUTH_MODE=local`, `Router root={Shell}` needs a guard that redirects unauthenticated users to `/login` (a `<Show>`-gated wrapper or a `createResource` session check in `Shell`). In `test`/`standalone`/`sso` modes the guard is a no-op, so single-owner dev and headless Docker are unchanged. The client must learn which mode is active — add a tiny unauthenticated `GET /api/auth/mode` returning `{ mode }` so the SPA knows whether to show a login screen at all.
- **Logout.** A menu action → `POST /api/auth/logout` clears the cookie → redirect to `/login`. Only meaningful in `local` mode.
- **"Forgot password?" link** on the login screen opens V's reset modal (see V-password-reset.md → its client section). U ships the link; V ships the modal.

> **CI-Hub parity (still needs the reference).** You asked to mirror CI-Hub's password modals. I checked — **CI