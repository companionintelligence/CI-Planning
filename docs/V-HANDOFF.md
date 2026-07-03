> **V is now BUILT** (Path B — local reset). Canonical as-built guide: [`V-auth.md`](V-auth.md).
> Locked decisions: D0 = build local reset; D3 = SMTP via nodemailer (console fallback);
> D4 = emailed link; D5 = invalidate **all** sessions (auth-epoch, no opt-out checkbox).
> Migrations `0103`/`0104` (head now 0104). The rest of this doc is the intake reconciliation
> that guided the build.

# U → V handoff (password reset)

**Phase U is complete and on `main`** (rescue PR #230 merged; migration head **0102**). This doc hands
off to **Phase V — password reset for local sign-in**, reconciled against *as-built* U. The owner's
fuller V plan lives (uncommitted, by the usual future-phase convention) in the local `main` checkout as
**`docs/V-password-reset.md`** + **`docs/V-password-reset-tickets.md`** — that's the canonical scope; this
doc is the as-built delta a successor needs on top of it.

---

## 0. Phase U — final state (what V builds on)
Everything is on `main` and green. See **[`docs/U-auth.md`](U-auth.md)** and **[`docs/U-HANDOFF.md`](U-HANDOFF.md)**.
- `owners.username` + `owners.password_hash` exist (migration `0101`). **V does NOT add them.**
- `owners.email` predates U (local copy; no live Hub lookup).
- **argon2id** hashing: reuse `hashPassword()` from `server/src/lib/auth/password.ts` (do NOT add bcrypt).
- **Login screen** (`client/src/views/Login.tsx`) already has the **"Forgot password?" stub hook**
  (a placeholder near the local form) for V to wire up.
- **Rate limiter** already exists: an in-memory per-IP sliding window in `server/src/routes/auth.ts`
  (`rateLimited()`, driven by `config.auth.rateLimit` = `AUTH_RATE_WINDOW_MS/MAX/ISSUE_MAX`, with a
  `__resetAuthRateLimit()` test seam). V9's "build a rate-limit shim" is **half-done** — extend this to
  key **per-account** as well (today it's per-IP only), don't build a new one.
- **Single-use expiring token pattern** to mirror: `auth_states` (migration `0102`) + `oauth_states`.
- Two tiny U review items are closed in the same PR as this handoff (logout-CSRF hardening + a stale
  comment) — see that PR.

---

## 1. THE gating decision (resolve before writing any V code) — D0
The owner's draft §7 already frames this, and **U1 shipping makes Path A concretely available:**

- **Path A — delegate to CI-Portal (recommended for multi-user / family).** CI-Portal (better-auth)
  already owns accounts, email verification, and **password reset**. Register a `ci-planner` public PKCE
  client (the established pattern — `ci-server`/`ci-hub`/`ci-import-tools` already exist) and use U1's
  SSO. Then **portal users reset in the portal, and Phase V is not needed** — local passwords (U2) stay
  only as an offline fallback (or are dropped). This also needs the one open U item: register
  `CIPORTAL_CLIENT_ID`.
- **Path B — build local reset.** Only if the app must support **local accounts with no portal
  dependency** (offline appliance). Then build V per the owner's ticket set, with the corrections below.

**Recommendation:** confirm with the owner whether local accounts are a real requirement. If not, close V
as "delegated to CI-Portal" and move on. The rest of this doc is for Path B.

---

## 2. As-built corrections to the V ticket drafts (Path B)
The drafts were written against an older tree. Fix these before implementing:

1. **Migration numbers collide — renumber.** The drafts say `0093_owner_backup_email` / `0094_password_reset_tokens`.
   **`0093`/`0094` are already merged** (unrelated). Migration head is **`0102`**; V's are **`0103_owner_backup_email`**
   and **`0104_password_reset_tokens`**. (Always re-verify the head before numbering — this bit Phase U too.)
2. **⚠️ There is NO session store — the biggest correction.** V4/V7/D5 ("sign out other devices" /
   "invalidate existing sessions on reset") assume a Phase-U session store to clear. **U sessions are
   STATELESS signed cookies** (`cp_session` = the owner id, signed via `app.keys`; `verifySession()` in
   `server/src/lib/auth/session.ts` just checks the signature + that the owner exists). Nothing to revoke —
   a signed cookie stays valid until expiry. To make reset invalidate other devices, add an **auth epoch**:
   - `owners.session_epoch INTEGER NOT NULL DEFAULT 0` (part of the `0103` migration);
   - encode it in the cookie (`setSession` writes `${ownerId}.${epoch}`), and in `verifySession` reject
     when the cookie's epoch ≠ the owner's current `session_epoch`;
   - **bump `session_epoch` on password reset** ⇒ every existing cookie for that owner is instantly invalid.
   This is the minimal fit for the stateless model. (A full `sessions` table is the alternative only if
   per-session revocation is ever needed — not worth it now.) **This is a real design addition V must make;
   the draft's "clear the session store" step cannot be implemented as written.**
3. **`username`/`password_hash` are already provided by U0** — the draft's "confirm U owns these, else V1
   adds them" resolves to **U owns them; V1 only adds `backup_email` + `password_reset_tokens`** (+ the
   `session_epoch` from correction #2).
4. **Hash the reset token at rest** (sha256 of a `randomBytes(32)` base64url token) — the draft already
   says this; note CI-Portal stores it unhashed, so keep our hashing as a deliberate improvement.
5. **Email (V0) is net-new** and is the real effort driver. Owner's D1 = self-send SMTP via `nodemailer`
   with a **console transport when SMTP env is unset** (keeps dev/CI offline, mirrors `AUTH_MODE=test`).
   New env vars go in `.env.example` (see Phase Y). **Path A avoids this entirely.**
6. **Anti-enumeration + rate limit** on `POST /api/auth/reset-request`: always return the same neutral 200,
   and rate-limit per-account AND per-IP (extend U's limiter, correction from §0).

Endpoints/UI (unchanged from the draft, all in CI-Planner only): `POST /api/auth/reset-request`,
`POST /api/auth/reset`, `PATCH /api/owner/backup-email`; client `ForgotPassword.tsx` modal (off the login
screen's existing hook), `/reset-password` page (`ResetPassword.tsx`), Settings backup-email row.

---

## 3. Lessons to carry into V (these caused real pain in U)
- **Stacked-merge trap (cost us a whole rescue PR twice — S and U).** A PR whose base is a *feature
  branch* merges **into that branch, not `main`**, unless the base branch is deleted on merge. Keep V's
  PRs shallow (base `main`), and after every merge run `git cat-file -e origin/main:<path>` to prove the
  content actually reached `main` — "PR merged" ≠ "on main".
- **Copilot autofix** commits directly onto your PR branch and can (a) push a *broken* suggestion (it
  dropped a JSDoc `*/` on #226) and (b) apply only *some* of its own suggestions (on #230 it committed the
  doc fixes but not the logout-CSRF code fix). Always `git fetch` + inspect its diff + `tsc` before pushing
  over it, and re-check which comments it actually resolved.
- **pnpm, not npm.** CI uses `pnpm-lock.yaml`; the tracked `server/package-lock.json` is vestigial and
  out-of-sync (`npm ci` fails). Use `pnpm add --filter server` (V0 adds `nodemailer` this way).
- **`style-canon-lint`** (runs on every PR) fails only on non-teal `--primary:`; hex in components is a
  non-blocking warning. V's SolidJS UI should use the teal design tokens (also fixes U3's pending mint→teal polish).
- **`TRUST_PROXY=true`** is required behind CI-Hub's TLS tunnel for `Secure` cookies + real client IP
  (matters for V's per-account rate-limit keying).
- **CI-Portal is better-auth** and already implements the full reset flow (Path A). Its reference flow is
  in the owner's draft §7 if mirroring for Path B.
- **Migration head is `0102`; next free is `0103`.** Re-verify before numbering.

---

## 4. Open confirmations (owner) before V starts
- **D0** — Path A (delegate to CI-Portal) vs Path B (build local reset)? *(gates whether V is built)*
- If Path B: D3 email provider (SMTP/nodemailer default), D4 link vs code (link), D5 session behavior
  (invalidate-all via the auth-epoch above, vs a user opt-out).
- Register `CIPORTAL_CLIENT_ID` with the CI-Portal team (needed for Path A; also the last open U item).
