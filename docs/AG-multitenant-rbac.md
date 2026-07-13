# Phase AG — Multi-tenant RBAC (operator/tenant role split)

**Status: IMPLEMENTED (2026-07-12) — migration 0125, role-derived session scopes, `/api/accounts` with email-invite onboarding, Settings → Accounts UI. See `server/test/accounts.test.ts` for the behavioral contract.**

## Why

The multi-tenant leak audit ([PR #328](https://github.com/companionintelligence/Companion-Planning/pull/328)) closed every cross-tenant *data* leak, but surfaced one gap that is a product decision, not a bug: **under multi-tenant SSO every logged-in owner is an admin.** `verifySession` grants every session `[READ, WRITE, ADMIN]` unconditionally (`server/src/lib/auth/session.ts:114`). Consequences for a true multi-tenant deployment:

- Any tenant can hit the system job registry (`/api/jobs`) and trigger jobs — some of which run maintenance across *all* tenants.
- Any tenant can read every other tenant's `job_runs` logs (per-owner email/sync/memory counts) via `/api/jobs` and the GraphQL `scheduledJobs`/`runScheduledJob` resolvers.
- Any tenant can read and **overwrite** the server-global Google OAuth client (`/api/google-config`).

This is acceptable for the app's original "one operator per box, reached over Tailscale" model, where the logged-in owner *is* the operator. It is a blocker for untrusted-tenant SaaS. The owner's directive: **true SaaS with a real operator-vs-tenant role split — one admin account that can create other accounts and set permissions per account.**

## What the audit already gives us (reuse, don't rebuild)

- **The scope model already exists**: `SCOPE_READ` / `SCOPE_WRITE` / `SCOPE_ADMIN` (`server/src/lib/auth/types.ts:16`), `hasScope(scopes, method)` and `hasAdminScope(scopes)` (`server/src/lib/auth/scopes.ts`). Roles just need to *map* onto these.
- **API-key mode already stores per-credential scopes** (`api_keys.scopes` JSON; `apiKey.ts:66` returns them verbatim). A read-only or admin key is already expressible. The gap is only on the SSO/session side.
- **One choke point** turns an SSO/local session into scopes: `verifySession` at `session.ts:114`. Changing that one line (plus a `role` column to read) flips the whole model from "everyone is admin" to role-derived.
- **Provisioning + hashing primitives exist and are test-proven**: `provisionOwner(fields)` (`server/src/lib/owners.ts:75`) creates a fully-seeded owner including `username`/`passwordHash` columns; `hashPassword(plain)` (argon2id, `server/src/lib/auth/password.ts:29`); `deleteOwner` (`owners.ts:263`, already refuses the SYSTEM sentinel); `bumpSessionEpoch` (`session.ts:59`).
- **Admin-gate pattern to copy verbatim**: the `requireAdmin(ctx)` helper in `routes/jobs.ts:19` / `routes/google-config.ts:15` (`hasAdminScope(currentScopes())` → 403).

The gap: no `role` column, no endpoint/CLI creates a second local account, no owner-enumeration helper, and the client has no is-admin concept (admin-ness is inferred by probing an admin GET).

## Decisions

- **Three roles**, mapped onto the existing scopes:
  | Role | Scopes | Meaning |
  |---|---|---|
  | `operator` | `[READ, WRITE, ADMIN]` | Full access + account management + system jobs + Google-config |
  | `member` | `[READ, WRITE]` | Normal tenant; full access to their own data only |
  | `viewer` | `[READ]` | Read-only tenant |
  "Set permissions per account" = assign one of these roles. Three roles map 1:1 onto `planning:read/write/admin`, so **no new permission table** is needed.
- **New local accounts: email invites (owner ruling, 2026-07-12 — supersedes the earlier operator-set-password default).** Creating an account mints it with **no password** and sends the user a single-use set-your-password link (the existing V reset-token machinery: `password_reset_tokens` + `/reset-password`; invite links live 7 days, reset links keep the V TTL). The operator never handles anyone's password. With **no SMTP** configured (or a failed send) the link is returned to the operator once, to forward out-of-band — same honesty rule as reset-request's "written to the server log" message.
- **At least one operator, always.** Guard against demoting or deleting the last operator (lockout prevention).
- **API-key mode is unchanged** — per-credential scopes already cover it.

## Design

### 1. Schema — `owners.role`
New migration `0125_owner_roles.ts` (additive + idempotent, following `0101_owners_auth_columns.ts` / `0103_owner_reset_columns.ts`):
- `ALTER TABLE owners ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`.
- **Backfill every existing real owner to `operator`** — a current single-owner install must keep admin and never lock itself out. The SYSTEM sentinel (`00000000-0000-7000-8000-000000000001`) is auth-inert, so its value is irrelevant.

### 2. Role → scopes (the one choke point)
`verifySession` (`session.ts:97`) — the query at `:107` already selects the owner row; extend it to also fetch `role`, and replace the hardcoded `return { ownerId, scopes: [READ, WRITE, ADMIN] }` at `:114` with role-derived scopes. Add a shared `roleToScopes(role)` helper in `scopes.ts` and reuse it everywhere a role becomes scopes (session + any future path). Update the now-stale `SCOPE_ADMIN` doc comment in `types.ts` ("a logged-in owner IS the operator").

### 3. Provisioning defaults — this is what actually closes the hazard
- `provisionOwner` (`owners.ts:75`) gains an optional `role` field (default `'member'`).
- `ensureLocalAuthBootstrap` (`localBootstrap.ts:34`): seed the first local owner as `role='operator'` — the founding admin.
- OIDC auto-provision (`routes/auth.ts:503`): new portal users default to `role='member'`, **not** operator. This is the change that stops "every auto-provisioned portal user is an operator."

### 4. Admin accounts API — new `routes/accounts.ts`, operator-gated
Copy the `requireAdmin(ctx)` helper; register in `routes/index.ts` (one import + one array entry, after `googleConfigRouter()`). Every route below is `requireAdmin`-gated:
- `GET /api/accounts` — list all owners (new `listOwners()` in `owners.ts`, excluding the sentinel): id, name, username, email, role, hasPassword. (`owners` has no created_at column — ids are UUIDv7, so ordering by id is creation order.)
- `POST /api/accounts` — create a local account and send its invite: `provisionOwner({ name, username, email, role })` (password-less) → `issueResetToken(id, 7d)` → invite email, or the link back to the operator when SMTP is absent. Duplicate username → 409 (DB partial-unique already enforces it, per `owners-auth.test.ts`).
- `POST /api/accounts/:id/invite` — (re)send the set-password link: a fresh invite for a password-less account, a reset link for an active one. The newest link supersedes older ones. 409 for OIDC-only (no username) or email-less accounts.
- `PATCH /api/accounts/:id` — set `role`, `name`, and/or `email` (so a mistyped invite address can be fixed). **Guard: refuse to demote the last operator** (409). A role change calls `bumpSessionEpoch(id)` so the target's live sessions re-derive scopes on their next request. (Completing an invite/reset already bumps the epoch inside `/api/auth/reset`.)
- `DELETE /api/accounts/:id` — `deleteOwner(id)`. **Guards: refuse to delete the last operator, and refuse to delete yourself** (409); the sentinel is already refused inside `deleteOwner`.

### 5. Surface role to the client
- `GET /api/auth/me` (`routes/auth.ts:126`) returns `role` (and a derived `isOperator`). Extend `AuthMe` in `client/src/lib/api.ts`.
- Settings → **Accounts** section, operator-only, using the existing probe-and-hide convention (`api.googleConfig.get().catch(() => null)` at `Settings.tsx:366`): list / create / change-role / reset-password / delete accounts. Non-operators never render it.
- Optional polish: hide the `/jobs` nav entry for non-operators (`components/Nav.tsx`) — currently server-403 only.

## Files (implementation follow-up)
| Area | Files |
|---|---|
| Schema | `server/src/db/migrations/0125_owner_roles.ts`, `migrations/index.ts` |
| Scopes | `server/src/lib/auth/session.ts`, `lib/auth/scopes.ts`, `lib/auth/types.ts` |
| Provisioning | `server/src/lib/owners.ts`, `lib/auth/localBootstrap.ts`, `routes/auth.ts` |
| Accounts API | `server/src/routes/accounts.ts` (new), `routes/index.ts` |
| Client | `client/src/lib/api.ts`, `client/src/views/Settings.tsx`, maybe `components/Nav.tsx` |
| Tests | `server/test/accounts.test.ts` (new); update `owners-auth` / `ciportal-auth` / `local-auth` for the `role` column + operator/member defaults |

## Verification (implementation follow-up)
- **Migration**: fresh DB → first owner `operator`; a DB with pre-existing owners → all backfilled to `operator`; new provisions default `member`.
- **Auth scoping**: a `member` session resolves `[READ, WRITE]` and 403s on `/api/jobs`, `/api/google-config`, `/api/accounts`; a `viewer` session 403s on any write; `operator` passes all. (Tests can drive roles via the `role` column + `x-test-owner`, or via the derived scopes with `x-test-scopes`.)
- **Accounts**: operator creates a member; the member logs in, reaches its own data, is denied admin; last-operator demote/delete → 409; a role change invalidates the target's live session (epoch bump).
- **E2E**: operator sees Accounts in Settings and can create/promote/demote; a member logs in and sees neither the Accounts section nor the Jobs admin surface.

## Out of scope (deliberate)
- Per-feature permissions (calendar vs objectives vs memory) — the coarse read/write/admin model is sufficient for the stated goal; revisit only if finer control is required.
- ~~Email invite / reset-link account onboarding~~ — **now the ratified default** (see Decisions); the SMTP-free path is the returned-link fallback, not operator-set passwords.
- Rate-limiter shared state across horizontally-scaled instances (flagged in the audit) — a separate scaling concern, not part of the role split.
