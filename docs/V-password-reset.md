# V — Password reset (local sign-in) — planning doc

**Status:** Planning only. **Depends on:** Phase U (local username/password must exist first — there's nothing to reset otherwise).

> **Blocked on external input:** you asked me to "find the password reset used in CI-Hub" to mirror it. I don't have CI-Hub's source — it isn't in either of your connected folders (`Companion-Planning`, `OTHERWIS3-Book`), and I have no other access to it. Everything below is a standard, defensible reset-flow design, **not** a copy of CI-Hub's actual implementation. If you share the CI-Hub repo, a design doc, or even a screen recording of the flow, I'll revise this to match it exactly rather than guessing.

## Goal (from your ask, restated precisely)

A password-reset modal on the local sign-in screen. By default, the reset email goes to the owner's **portal account email** (their hub.companionintelligence.com account email — implying Companion Planning needs to know or look up that address). The user can override this with a **backup email** they set themselves.

## What has to exist first (none of it exists today)

Checked `server/package.json` — there is **no email-sending library** anywhere in this codebase (no nodemailer, no transactional-email SDK, nothing). This phase requires standing up email delivery from scratch, which is a bigger prerequisite than the reset flow itself. Two sub-decisions:

1. **Send via your own SMTP/transactional provider**, independent of the Hub, or **ask the Hub to send it** (since the "portal account email" implies the Hub already owns that identity/email relationship — it may make more sense for Companion Planning to ask the Hub "please email this user a reset link" via an API call, rather than Companion Planning sending email itself under its own name). This is genuinely a Hub-integration-shape question, not just a library choice — worth resolving with whoever owns hub.companionintelligence.com before building either way.
2. If Companion Planning sends the email itself: which provider (Resend, Postmark, SES, plain SMTP)? None currently configured — new env vars either way (see Y).

## Proposed flow (pending the CI-Hub reference)

1. **Request:** local sign-in screen has a "Forgot password?" link opening a modal — enter username (or the account email); submit.
2. **Resolve destination email:** default = the owner's portal-account email (from `owners.email`, which today just holds whatever was set at signup — if this needs to be the *live* Hub account email rather than a locally-stored copy, that implies either syncing it from the Hub at login time, or looking it up via a Hub API call at reset-request time — another Hub-integration question). Fallback = a `backup_email` column on `owners` (new — the "allow the user to change the backup email" part of your ask), settable from a Settings page before it's ever needed.
3. **Token issuance:** generate a single-use, short-lived (e.g., 30-60 min) reset token — same pattern already used elsewhere in this codebase for `oauth_states` (random bytes, hashed at rest, expiry column, one-time use). A new `password_reset_tokens` table: `id, owner_id REFERENCES owners(id) ON DELETE CASCADE, token_hash, expires_at, used_at, created_at`. Never store or email the raw token in a retrievable place — only the emailed link carries it.
4. **Email sent** with a link containing the raw token (`https://<app>/reset-password?token=...`); the token itself is the only credential, no separate code needed unless you want a shorter numeric-code option instead of a link (mobile-friendlier, but the link pattern is simpler and matches typical portal-style resets).
5. **Reset page:** validates token (exists, unexpired, unused) → new-password form → argon2id hash it, mark token `used_at`, invalidate any other outstanding reset tokens for that owner, and (recommended) invalidate existing sessions so a stolen session can't survive a password change the user just made specifically because they suspected compromise.
6. **Rate limiting:** reuse the rate-limiting shim already planned for auth in `I-identity-auth.md`/`U` — reset-request should be tightly limited per account and per IP (this is a classic account-enumeration and email-bombing vector if unguarded).

## Client-side surface (expanded in the 2026-07-01 review — was one parenthetical before)

Three real UI pieces, all in `client/` (**SolidJS**, `@solidjs/router`, `lucide-solid`, CI-Hub color tokens — **not React**). None exist today:

1. **"Forgot password?" modal** — opened from U3's login screen. A component in the existing modal style (`onClose`/`onSaved` props, `createSignal` for the field, `showToast` on submit — mirror `ObjectiveModal.tsx`/`CategorySettings.tsx`). One field (username or account email) → `POST /api/auth/reset-request` → always show the same neutral "if that account exists, a link is on its way" confirmation regardless of whether the account exists (anti-enumeration — pairs with the server-side rate limit in step 6 below).
2. **Reset page** — a new unauthenticated `/reset-password` route + `ResetPassword.tsx` reading `?token=` from the URL, new-password + confirm fields, client-side strength/confirm-match check, → `POST /api/auth/reset`. On success: toast + navigate to `/login`. On invalid/expired token: an inline "this link has expired, request a new one" state that reopens the modal from piece 1.
3. **Backup-email field in Settings** — a row on the existing `/settings` page (Settings view already exists) to view/set `owners.backup_email`, → a new `PATCH /api/owner/backup-email`. Simple text input + save, same pattern as the other Settings rows.

> **CI-Hub parity (unchanged from the original blocker):** CI-Hub's source is still not in any connected folder, so the three pieces above follow this app's own modal conventions, not CI-Hub's. When you share CI-Hub's reset modal (source or screenshots), reconcile pieces 1–3 to match it — this is the same reference this doc has been waiting on since the start.

## Open decisions

- **Does Companion Planning send the email itself, or ask the Hub to?** (see above — the single biggest fork in this design.)
- **Is `owners.email` kept in sync with the Hub, 