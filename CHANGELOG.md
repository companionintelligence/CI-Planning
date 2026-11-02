# Changelog

All notable changes to Companion Planning. Releases are git tags (`v4.1.0` was the last
cut before this file existed). The container image is published by dispatching
`docker-publish.yml` on the tag's ref (see [docs/CI.md](docs/CI.md)) and reports the
version at `GET /api/health` (`release`).

## [Unreleased]

### Changed
- **Companion Portal sign-in brings you back to the page you asked for**, as Companion Memory does. When the
  app sends you to the login screen it remembers where you were going (same-origin paths only, for ten
  minutes), and the Portal round trip, the first-time account confirmation and the username sign-in all
  return you there. Before, every sign-in landed on the home page.

### Fixed
- **No stack trace in the server log each time a live-update stream closes.** Koa reports a
  response stream that closes before it ends (`ERR_STREAM_PREMATURE_CLOSE`) as an error, and
  with no listener prints the stack to stderr. For `/api/events` that is the normal ending (a
  reload, a closed tab, a locked phone), so every disconnect logged a failure that was not one.
  The app now owns the `error` listener: it drops that one code and logs the rest through the
  server's logger.
- **Two server tests no longer depend on when or in what order they run (#632).** The
  recurrence test compares the New York wall clock across a DST change (it compared UTC
  hours, so it failed whenever its window crossed one), and `startTestServer` clears the
  stored VAPID pair so a pair sealed by an earlier test file cannot leave push dormant.

### Added
- **Settings switches for Routines and Rituals.** Settings → Preferences → Routine Settings now
  has "Routines on the Planner" (`enable_routines`: the Routine option in the Add dialog, and recurring
  Routines placing themselves on the Planner) and "Rituals" (`enable_rituals`: the Ritual type in the
  Routines tab). Both were per-owner flags that only an API call could set; both stay off by default.
  Saving also refreshes the pattern types, which the server filters on `enable_rituals`.
- **`GET /api/sync/changes?since=<seq>`.** The `sync_events` log the SSE stream replays from,
  answered as JSON for a client that cannot hold an `EventSource`: the same rows, the same
  500-event window and the same overflow rule (`resync: true` means refetch everything, and is
  also the answer to a cursor ahead of anything the owner has, as after a restored backup). No
  `since` returns the latest cursor and no events. The mobile app shell polls it, since an
  `EventSource` there cannot carry the session cookie. SSE is unchanged for browsers.
- **iOS and Android app shells (Capacitor).** `mobile/ios` and `mobile/android` wrap the
  `client/` bundle in a native app that connects to a server you run. First run asks for the
  server's address (checked against `/api/health` and `/api/auth/config`, kept on the device,
  never built into the bundle); it can be changed under Settings → Profile → Server. All of it
  is guarded behind the `window.Capacitor` global, so the web app and the container image are
  unchanged. `pnpm --filter client build:mobile` builds the bundle into `client/dist`, and the
  manual `mobile-build.yml` workflow builds a debug APK and an unsigned Simulator `.app`. Not
  store-ready: see "Mobile app" in the README. Companion Portal sign-in is not available in the
  app yet.

### Changed
- **The native shells do not show controls they cannot run.** Export JSON, the calendar `.ics` export,
  the push switch, New account and invite codes are hidden in the iOS and Android apps.
- **Manrope is bundled.** The font ships in the bundle instead of loading from Google Fonts, so the web
  app makes no third-party font request, and the Content-Security-Policy no longer allows Google Fonts.
- **The web manifest uses the app's background colour** (`#041620`), as `index.html` does.
- **Android versions come from the build.** `versionCode` and `versionName` read `-PappVersionCode` and
  `-PappVersionName`, with `1` and `1.0` as defaults.
- **Android backups are off** (`allowBackup="false"`), so the sign-in session is not restored onto
  another device.
- **App shells: live updates by polling.** An `EventSource` in the app cannot carry the session
  cookie and the server allows no foreign origin, so in every shipped configuration the stream
  failed and retried forever. The shells now poll `GET /api/sync/changes` (every 15s while on
  screen, on resume or reconnect, and shortly after the app's own writes); browsers keep the
  stream. Needs a server newer than v4.2.2; an older one answers 404 and the app has no live
  updates, as before. Android `allowMixedContent` is gone, as it existed only for the stream.
- **App shells: password sign-in only.** The sign-in screen shows the username form and nothing
  else, `/signup` sends you to sign-in, and Settings no longer offers "Connect Google" or "Sign in
  with Companion Portal" (Companion Memory) in the app, nor does the onboarding wizard. All of them
  are redirects out and back with a cookie, which Capacitor sends to the system browser, so they
  could not finish in the app. A server that offers Portal sign-in alone gets an explanation
  instead of a button that cannot work. Browsers are unchanged.
- **App shells: pinch-to-zoom is on** for iOS and Android (`zoomEnabled`), the runtime
  `maximum-scale=1` the shell used to add is gone, and text fields are 16px or larger on touch
  devices so focusing one no longer zooms the page (WCAG 1.4.4). A test fails if any of it
  comes undone. On touch devices date and time inputs also drop iOS's native appearance, which
  ignored `width: 100%` and made the onboarding wizard's wake and bed times overflow a phone.
- **App shells: minimum OS raised to what the bundle needs.** iOS 16.4 (was 15) and Android
  System WebView 111 (was Capacitor's 60), the floor of Vite 8's default target and Tailwind 4.
  Below it the Android app shows a page saying to update WebView instead of opening unstyled.
- **The details sheet starts closed on phones.** At phone width it is a sheet over up to 62% of
  the screen; it now opens when something is selected and is not remembered. Desktop is
  unchanged.
- **iOS: privacy manifest and export-compliance key.** The app target has a
  `PrivacyInfo.xcprivacy` (no tracking, nothing collected, no required-reason APIs, checked by
  scanning the built binaries) and `Info.plist` declares `ITSAppUsesNonExemptEncryption` as
  `false`. Both are for the owner to confirm before a first upload.

## [4.2.2] — 2026-10-29

### Fixed
- **The Companion Portal button on the login and sign-up screens does a real navigation
  (#628).** Solid Router intercepts plain same-origin anchors, so the button resolved
  client-side to an unknown route and never reached `/api/auth/ciportal/start`. The links
  are marked `rel="external"`. This is what failed the publish workflow's Portal login
  smoke test.

## [4.2.1] — 2026-10-29

### Fixed
- **The container image builds again (#627).** The `@companionintelligence/*` packages
  resolve to `npm.pkg.github.com` and `.npmrc` is dockerignored, so `pnpm install` in the
  Dockerfile failed with `ERR_PNPM_TARBALL_URL_MISMATCH`. The install step now writes a
  throwaway user npmrc from a BuildKit secret (`--secret id=NODE_AUTH_TOKEN`) that never
  reaches a layer, and `docker-publish.yml` passes `GITHUB_TOKEN` as that secret.

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
