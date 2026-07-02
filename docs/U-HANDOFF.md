# Phase U — handoff to complete & ship

**Status (verified against `origin` 2026-07-02):** Phase U (auth: OIDC SSO + local login) is
**fully built, reviewed, and tested** — but **only U0 actually reached `main`.** U2, U1, U3, and
the discovery/`iss`/Secure alignment are stranded on a feature branch by a stacked-merge trap
(below). One rescue PR gets everything onto `main`.

Reference docs: **[`docs/U-auth.md`](U-auth.md)** (the canonical U0–U3 design/config guide) and
[`docs/screenshots/login-screens.html`](screenshots/login-screens.html) (login-screen reproduction).

---

## 1. THE critical item: land the rest of Phase U on `main`

### What happened (stacked-merge trap — the 2nd time in this repo; see Phase S)
The four PRs were a stack (`#225 → #226 → #228 → #229`), each based on the previous *feature branch*.
`#225 (U0)` merged to `main` first. The other three then merged **into their base branches, not
`main`** (GitHub only auto-retargets a stacked PR to `main` if the base branch is deleted on merge —
these weren't). Net result:

- **`main` has only U0** (migration `0101`, the `owners` auth columns) + the unrelated `#227` style work.
- **U2 + U1 + U3 + the alignment fixes all sit on `origin/claude/phase-u1-ciportal-sso`** (the head of
  the old stack — it accumulated everything).

### The rescue PR (opened as part of this handoff)
A PR from **`claude/phase-u1-ciportal-sso` → `main`**. Verified safe:
- `U0` (`788a2cd`) is a true ancestor of `main`, so the diff is exactly the U2/U1/U3/alignment delta
  (~33 files), **not** a re-application of U0.
- **No file overlap with `#227`** — the branch was merged up-to-date with `main`; conflict-free.
- **CI-clean:** the new `style-canon-lint` gate passes (it fails only on non-teal `--primary:`; the
  diff has none — Login.tsx's hex colors are non-blocking warnings). Full server suite **1178 pass /
  3 skip**; client **223 pass**.

**Action:** review + **squash-merge** the rescue PR (squash collapses the messy stack history — the
Copilot "Potential fix" commits and merge commits — into one clean commit). Then **delete the four
merged feature branches** (`claude/phase-u-oidc-local-auth`, `-u2-local-auth`, `-u1-ciportal-sso`,
`-u1-oidc-discovery`). After merge, confirm content reached main:
`git cat-file -e origin/main:server/src/routes/auth.ts` (exit 0 = present).

> **Verify content reached `main`, not just "PR merged."** That's the whole lesson of this trap.

---

## 2. Remaining items to reach shippable (ranked)

1. **Merge the rescue PR** (above) — unblocks everything, incl. Phase V (which needs
   `owners.username`/`password_hash`, the login screen, and the session store on `main`).
2. **Register the real CI-Portal client** — the ONLY external dependency left. Ask the CI-Portal team
   to register a **public PKCE client** for this app (CI-Import Tools registers `ci-import-tools`), then
   set `CIPORTAL_CLIENT_ID`. Everything else is correct-by-discovery (issuer defaults to the real
   `https://hub.companionintelligence.com/api/auth`; endpoints + the `iss` claim come from discovery).
   Then run a **live end-to-end login over Tailscale** (dev flow already proven against the fixture
   portal). See `docs/U-auth.md` → Configuration + "Developing against a fixture CI-Portal".
3. **Login-screen brand reconciliation (polish, non-blocking).** `client/src/views/Login.tsx` uses the
   original **mint** gradient (`#58ebbf`/`#409b9b`); `#227` retargeted the app to **CI teal**
   (`#0f717a`). Post-merge the login screen is off-brand vs the rest of the app (and emits canon-lint
   *warnings*). Reconcile to the teal design tokens for a consistent look.
4. **Real login-screen screenshots.** Not captured this session — the Chrome extension was disconnected
   and the Preview screenshotter timed out (verified the UI via DOM snapshot + computed-style inspection
   + live e2e instead). `docs/screenshots/login-screens.html` is a faithful reproduction; regenerate as
   PNGs once a working browser tool is available.
5. **Phase V (password reset)** — the login screen's "Forgot password?" is a stub hook; V ships the
   modal + reset flow. V is otherwise unblocked once the rescue PR lands.
6. **Cleanup (low priority):** delete the orphaned `server/package-lock.json` (npm, stale/out-of-sync —
   CI uses `pnpm-lock.yaml`); it's a footgun (see lessons).

---

## 3. Deployment / config reference (what "on" looks like)

| Deployment | Env |
|---|---|
| Dev / CI | `AUTH_MODE=test` (default) — implicit system owner, no login. |
| Headless Docker | `AUTH_MODE=standalone` — hashed `x-api-key`. |
| **CI-Portal SSO** | `AUTH_MODE=sso`, `SESSION_SECRET=<openssl rand -hex 32>`, `CIPORTAL_CLIENT_ID=<registered>`, `TRUST_PROXY=true` (behind CI-Hub's TLS tunnel — needed for Secure cookies + real client IP), `CIPORTAL_REDIRECT_URI` matching the registered URI. Issuer defaults to the real portal. |
| **Local user/pass** | `AUTH_MODE=sso` + `DISABLE_OIDC=true`, `SESSION_SECRET`, `AUTH_DEFAULT_USERNAME`/`AUTH_DEFAULT_PASSWORD` (first-boot seed), `TRUST_PROXY=true` if TLS-fronted. |

Boot fails closed on: `AUTH_MODE=test` in prod; `sso` without `SESSION_SECRET`; prod `sso`+OIDC without
`CIPORTAL_ISSUER`+`CIPORTAL_CLIENT_ID`; partial `CIPORTAL_*_URI` overrides; local mode with no login path.

---

## 4. Lessons (hard-won this phase — read before touching the stack)

- **Stacked PRs merge into their base *branch*, not `main`**, unless the base branch is deleted on merge
  (then GitHub auto-retargets). This trap has now hit twice (Phase S #209, Phase U). **Always** verify
  content landed with `git cat-file -e origin/main:<path>`, and prefer a single rebased/squashed
  PR-to-`main` over a deep stack.
- **The Copilot autofix bot pushes commits directly to your PR branch** — and *can push broken ones*
  (it dropped a JSDoc `*/` on #226, a syntax error). Before pushing over it: `git fetch` (your push will
  be rejected non-ff), inspect its diff, and **run `tsc`** — never assume its fix compiles. When its fix
  is correct, accept it and just add the test it skipped.
- **This repo uses `pnpm`, not `npm`.** CI reads `pnpm-lock.yaml`; the tracked `server/package-lock.json`
  is vestigial *and out-of-sync with `package.json`* (`npm ci` fails). Never `npm install` here — it
  de-junctions `node_modules` and rewrites the wrong lockfile. Use `pnpm add --filter server` etc.
- **A fresh worktree has no `node_modules`.** `pnpm install` at the root works (better-sqlite3 fetches a
  Node-22/24 prebuild; `@node-rs/argon2` is prebuilt — no node-gyp).
- **Shared pid-keyed test DB:** running exactly two test files together can flake (co-scheduled DB
  contention); the **full suite is deterministic and green**. `resetDb()` prunes non-sentinel owners and
  must delete owner-scoped tables (scheduling_prefs/tag_prefs/patterns/pattern_types) before `owners`
  (NO-ACTION owner FKs).
- **CI-Portal is `better-auth`.** Discovery is at `…/api/auth` but the id_token `iss` claim is the **bare
  origin** — validate `iss` against the *discovery doc's* issuer, never the configured URL. Consumers are
  **public PKCE** clients. `CI-Import-Tools` (`backend/src/auth/`) is the reference consumer — read its
  *current* HEAD (I first reviewed a stale local checkout; always `git log`/`status` the target repo).
- **`secure: ctx.protocol === 'https'` is a no-op behind a TLS-terminating proxy** unless Koa `app.proxy`
  is on — hence the `TRUST_PROXY` flag. (CI-Import-Tools has the same latent gap.)
- **`style-canon-lint` (on `main` since #227)** fails only on non-teal `--primary:` declarations; hardcoded
  hex in components is a non-blocking warning.
- **N-SENTINEL:** every owner lookup excludes `SYSTEM_OWNER_ID` so an external login can't take over the
  single dev/test owner.

---

## 5. What was built (one-liner map)

- **U0** `0101` — `owners.external_subject`/`username`/`password_hash` (nullable, partial unique idx). *(on main)*
- **U2** — `DISABLE_OIDC` local login: argon2id (`@node-rs/argon2`), signed `cp_session` cookie, constant-work
  verify, boot seed/fail-closed. `lib/auth/{password,session,localBootstrap}.ts`, `routes/auth.ts`.
- **U1** `0102` `auth_states` — CI-Portal OAuth2.1+PKCE RP login, discovery-driven, `iss`-from-doc, shared
  `verifyOidcIdToken.ts` (also used by Google `oauth.ts`), `provisionOwner` (closes G-BASETAG),
  `scripts/fixture-portal.ts` for dev e2e.
- **U3** — SolidJS `/login` + `SessionGate` route guard + sign-out; `test`/`standalone` byte-for-byte
  unchanged (client guard is UX only; the server enforces every `/api` call).

All slices went through adversarial review workflows (U1+U3 fixed a **medium login-CSRF**; the discovery
alignment came back 0-findings). Migration head after the rescue PR: **0102**.
