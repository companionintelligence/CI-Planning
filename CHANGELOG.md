# Changelog

All notable changes to Companion Planning. Releases are git tags (`v4.1.0` was the last
cut before this file existed); the container image publishes on each tag and reports the
version at `GET /api/health` (`release`).

## [Unreleased]

### Fixed
- **No stack trace in the server log each time a live-update stream closes.** Koa reports a
  response stream that closes before it ends (`ERR_STREAM_PREMATURE_CLOSE`) as an error, and
  with no listener prints the stack to stderr. For `/api/events` that is the normal ending (a
  reload, a closed tab, a locked phone), so every disconnect logged a failure that was not one.
  The app now owns the `error` listener: it drops that one code and logs the rest through the
  server's logger.

### Added
- **iOS and Android app shells (Capacitor).** `mobile/ios` and `mobile/android` wrap the
  `client/` bundle in a native app that connects to a server you run. First run asks for the
  server's address (checked against `/api/health` and `/api/auth/config`, kept on the device,
  never built into the bundle); it can be changed under Settings → Profile → Server. All of it
  is guarded behind the `window.Capacitor` global, so the web app and the container image are
  unchanged. `pnpm --filter client build:mobile` builds the bundle into `client/dist`, and the
  manual `mobile-build.yml` workflow builds a debug APK and an unsigned Simulator `.app`. Not
  store-ready: see "Mobile app" in the README. Companion Portal sign-in is not available in the
  app yet.

## [4.2.0] — 2026-10-29

### Changed
- **License changed from CI-Commercial-1.0 to the PolyForm Noncommercial License 1.0.0.** Companion Planning is now free for noncommercial use and the source is public. the license file is now `LICENSE`; package manifests declare `PolyForm-Noncommercial-1.0.0`. See [docs/License-FAQ.md](docs/License-FAQ.md).

### Added
- **Companion Portal sign-in that works against the real Portal (#619).** The id_token
  verifier accepts the Portal's EdDSA/Ed25519 tokens (RS256 stays for Google); the default
  issuer is the production portal `https://hub.ci.computer/api/auth` (it was the dev zone);
  the first Portal login on an instance with no operator becomes the operator; an optional
  `AUTH_DEFAULT_*` pair seeds a break-glass local operator; a local-open (loopback) login
  returns to the loopback host. User-facing copy says "Companion Portal".
- **A new-user path (#619).** The login screen offers both methods; "Create one with
  Companion Portal"; invite-code local sign-up (`AUTH_SIGNUP=open|invite|off`, `/signup`,
  migration 0172); a first-time Portal sign-in confirms on a no-JS page before an account
  is created. README, screenshots and video stills refreshed from synthetic data.
- **Release pipeline (Track C).** GitHub Actions stay manual-dispatch by owner decision
  (#618; "test local"): the merge gate is `pnpm typecheck && pnpm build && pnpm test` on a
  dev box, and `tests/container/run-local.sh` runs the container smoke gate — the
  screenshot, service-worker and security-header checks plus both login paths
  (username/password, and the Companion Portal flow against the repo's fixture portal) —
  without Docker. A dispatched publish on a release tag bakes `CI_PLANNING_VERSION` into the
  image and runs the same login phases in real containers before pushing.
- **Security headers (Track D2).** Every response carries a Content-Security-Policy,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`, a conservative
  `Permissions-Policy`, and HSTS over HTTPS. The theme-bootstrap script moved out of
  `index.html` so the policy needs no inline-script allowance.
- **Open-time range** setting, high-contrast panel toggles, and a Today layout with the
  Planner in the centre and the Flight Plan in the drawer (#604, #601).
- A scheduled task can be given up on, and that is counted (#606); the trust dial is an
  ordering policy independent of `planning_mode` (#605).
- Placement learning: the scheduler records what it chose and what it passed over, rolls
  up an owner's preferred hour band, biases gap choice toward it, and exposes a survival
  trend + reset endpoint (migrations 0166/0167).
- Focus Ritual restyle, a style preference, and the Focus Lab.
- Ecosystem attribution: NOTICE, THIRD_PARTY, CREDITS (#617).

### Changed
- **Self-host compose no longer requires Postgres (Track D3).** `docker compose up` boots
  on SQLite with only a session secret and the admin login set; the Postgres service sits
  behind `--profile postgres` for the still-in-progress schema port.
- Brand canon 1.0: CI-Common tokens layer, Manrope, `ci-lint-canon`; primary CTA treatment
  moved off the retired teal-200/teal-600 (#610–#614).
- Undo moved to the Planner header alongside Schedule.
- Pattern placement routes through `mirrorEnginePlacement` so nightly placement honours a
  user-pinned `task_time` instead of overwriting it (AD1, #615 — see
  `docs/AD-calendar-reliability.md`).

### Fixed
- **Security:** wildcard CORS replaced with an explicit origin allowlist (#608). The image
  published on 2026-09-06 predates this fix; the next tag carries it.
- `completed_at` is stamped when a task's status is set to done directly (#607).
- `issue-key` initialises the store before minting an API key.
- Mobile: an empty details-drawer bottom sheet no longer blocks taps (#600).
- `<select>` gets the canon chevron instead of the browser's (#602).
- Two flaky server tests pinned to a fixed wall clock; test DB resets clear the
  classification tables (#593).

## [4.1.0] — earlier
Tag `v4.1.0`. History before this file: `git log v4.1.0`.
