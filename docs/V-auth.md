# V — Password reset (local sign-in)

**Status: BUILT.** Canonical as-built guide for Phase V. Builds on Phase U (see
[`U-auth.md`](U-auth.md)); the planning drafts are `V-password-reset.md` +
`V-password-reset-tickets.md`, and the intake reconciliation is [`V-HANDOFF.md`](V-HANDOFF.md).

## What V is (and is not)

V adds **self-service password reset for LOCAL username/password owners** — the accounts
that exist only when `AUTH_MODE=sso` + `DISABLE_OIDC=true` (U2). It is the follow-through on
the login screen's "Forgot password?" hook.

- **CI-Portal SSO owners are out of scope.** They have no local `password_hash`; they reset
  in CI-Portal (better-auth owns that flow). Every V route is gated to local-login mode and
  404s otherwise.
- **Scope rule (owner directive):** all work is in CI-Planner. Nothing in CI-Server / CI-Portal
  was touched. There was no reset flow to mirror in CI-Server; V is built fresh.

## The flow

```
/login  ──"Forgot password?"──▶  ForgotPassword modal
   │                                    │  POST /api/auth/reset-request { identifier }
   │                                    ▼
   │                         issue token → email a link (neutral 200 either way)
   │                                    │
   ▼                                    ▼
   ◀────────  navigate('/login')  ◀── /reset-password?token=…  (ResetPassword page)
                                        │  POST /api/auth/reset { token, newPassword }
                                        ▼
                        set password_hash · bump session_epoch (all devices signed out)
```

## Endpoints (all CI-Planner, `/api/auth` + `/api/owner`)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/reset-request` | public | Body `{ identifier }` (username OR email). Resolves the owner, emails a reset link. **Always** returns the same neutral `200` (anti-enumeration). Rate-limited per-IP AND per-identifier. |
| `POST /api/auth/reset` | public | Body `{ token, newPassword }`. Consumes the single-use token, argon2id-hashes the password, sets `owners.password_hash`, and bumps `session_epoch`. |
| `PATCH /api/owner/backup-email` | session | Body `{ backup_email }` (null clears). Sets the current owner's fallback reset address. |

`GET /api/auth/me` also now returns `backupEmail` so Settings can show it.

## Key design points

- **Token** — `randomBytes(32)` base64url, emailed once. Only `sha256(token)` is stored
  (`password_reset_tokens`, migration `0104`); a DB read never yields a usable token (a
  deliberate hardening over the CI-Portal reference, which stores it unhashed). Single-use,
  60-min TTL (`AUTH_RESET_TOKEN_TTL_MS`). A fresh request supersedes the owner's prior tokens;
  consuming one deletes its siblings. Service: `server/src/lib/auth/resetToken.ts`.
- **Session invalidation (D5 = invalidate all)** — U's session is a **stateless** signed
  cookie (owner id + HMAC); there is no session store to selectively clear. V adds an **auth
  epoch**: the cookie now carries `${ownerId}.${epoch}`, `verifySession` rejects any cookie
  whose epoch ≠ `owners.session_epoch` (migration `0103`), and a reset **always bumps** the
  epoch — instantly invalidating every existing session for that owner (matches CI-Portal's
  `revokeSessionsOnPasswordReset`). Legacy pre-V cookies (no `.epoch`) read as epoch 0 and keep
  working across the upgrade. There is **no "sign out other devices" checkbox** — reset always
  signs out everyone; the user signs in fresh. `server/src/lib/auth/session.ts`.
- **Anti-enumeration** — `reset-request` returns a byte-identical `200` whether or not the
  account exists or has a deliverable address, and the email send is fire-and-forget so SMTP
  latency can't become a timing oracle.
- **Rate limiting (V9)** — extends U's in-memory sliding-window limiter (`server/src/routes/auth.ts`)
  from per-IP to also key **per-identifier** for `reset-request` (stops one mailbox being
  hammered). Bounds are the existing `AUTH_RATE_*` vars.
- **Email (V0)** — `server/src/lib/mail/index.ts`, `sendMail({ to, subject, html, text })`.
  SMTP via **nodemailer** (the one new server dep, lazily imported) when `SMTP_HOST` is set;
  otherwise a **console transport** that logs the message — dev/CI/offline need no SMTP.

## ⚠️ Local owners have no email by default

A locally-bootstrapped owner (seeded from `AUTH_DEFAULT_USERNAME`/`AUTH_DEFAULT_PASSWORD`) has
**neither `email` nor `backup_email`**, so `reset-request` for it has no destination — it still
returns the neutral 200 but no link is sent (an operator sees a `warn` log). **To make reset
usable, the owner must set a `backup_email` in Settings → Account first** (V8), or a primary
`email` must be present. SSO-provisioned owners get `email` from the id_token `email` claim
automatically; local owners do not.

## Configuration

Only meaningful under `AUTH_MODE=sso` + `DISABLE_OIDC=true`. See `server/.env.example` →
"Email / password reset (Phase V)":

- `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` — SMTP transport. Unset
  ⇒ console transport (logs instead of sends). A **production** local-login deploy with no
  `SMTP_HOST` boots with a warning.
- `MAIL_FROM` — the `From:` header.
- `APP_BASE_URL` — base for the reset link (defaults to `PUBLIC_BASE_URL`).
- `AUTH_RESET_TOKEN_TTL_MS` — link lifetime (default 60 min).

## Schema

- `0103_owner_reset_columns` — `owners.backup_email TEXT`, `owners.session_epoch INTEGER NOT NULL DEFAULT 0`.
- `0104_password_reset_tokens` — `id, owner_id (FK→owners ON DELETE CASCADE), token_hash, expires_at, used_at, created_at` + indexes on `owner_id` and `token_hash`.

Migration head after V: **0104**.

## Tests

- Server: `server/test/password-reset.test.ts` — token single-use/expiry/hash-at-rest, the
  enumeration-neutral `reset-request` (existing == non-existent, no-email accounts, backup
  fallback, sentinel exclusion), reset completion + **all-session invalidation via the epoch
  bump**, rate limiting, mode gating, and the backup-email endpoint. Console mail transport
  exercised throughout.
- Client: `client/src/views/ResetPassword.test.tsx` — submit gating (length + match),
  success → `/login`, and the invalid/expired recovery state.
