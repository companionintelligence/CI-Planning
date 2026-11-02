# Changelog

All notable changes to Companion Planning. Releases are git tags (`v4.1.0` was the last
cut before this file existed). The container image is published by dispatching
`docker-publish.yml` on the tag's ref (see [docs/CI.md](docs/CI.md)) and reports the
version at `GET /api/health` (`release`).

## [Unreleased]

### Changed
- **A new app icon:** a calendar with a check mark on the brand teal, for iOS, Android and the web. The desktop
  app gets it with its own release.
- **The iOS app is iPhone-only for now.** It has not been tested on iPad.
- **iOS allows plain http to `.lan` and `.home.arpa` addresses**, as the app already allows for `.local` names and
  IP addresses. Other names still need https.
- **Companion Portal sign-in brings you back to the page you asked for**, as Companion Memory does. When the
  app sends you to the login screen it remembers where you were going (same-origin paths only, for ten
  minutes), and the Portal round trip, the first-time account confirmation and the username sign-in all
  return you there. Before, every sign-in landed on the home page.
- **Changing the suggested category in the Add dialog now counts as a correction.** When the AI picks a
  category from the Describe-it line and you press Add, the app records its pick and what you saved. If
  you changed it (a different order counts), the correction is closed at once; if you kept it, it waits
  24 hours, then counts as accepted. Nothing is recorded if you never press Add, or if the title or the
  category names no longer match what the AI saw. This covers new tasks and habits, not Time Blocks or
  edits. Two related changes: an edit that does not change a task's categories no longer counts as an
  answer, and a category you clear is kept in the log but not learned from. Learning is still weekly: a
  correction you make changes no prompt until the next Monday `calibrate_classification` run, and a field
  needs at least 2 corrections first. The examples built from corrections reach a prompt only where they
  already did: Companion Memory's fill-in (off unless `MEMORY_MODE` is set) and the Monday run's own
  scoring. The Describe-it line does not read them.
- **Describe-it reads a one-word category answer.** The smallest default AI model, `qwen2.5:0.5b`,
  answers the category question with one word (`"leisure"`) where the prompt asks for a list, and
  `gemma3:1b` does on about 4 calls in 5. Describe-it kept lists only, so on those models it never
  suggested a category, the Add dialog had no pick to record, and no correction could be learned. It now
  takes a single word as one category when it is exactly one of your categories, ignoring case; several
  words written as one string still name nothing. The prompt is unchanged. In a test with an invented
  owner and 42 titles, the share of answers that name one of the owner's categories went from 0% to 80%
  on `qwen2.5:0.5b` and from 21% to 91% on `gemma3:1b`, and `gemma3n:e4b`'s answers did not change. That
  counts answers, not good answers: on the 12 titles with an obvious category, `qwen2.5:0.5b` named it
  in 20 of 60 answers (it said `leisure` for 6 in 10 of all of them), `gemma3:1b` in 49 of 60 and
  `gemma3n:e4b` in 60 of 60, so on the smallest model most suggestions will need your correction.
  Learning is still weekly: the Monday `calibrate_classification` run folds corrections in, and a field
  needs at least 2 first. See `docs/classification-shape-fix-2026-11.md`.
- **AI works through your CI Hub when the Hub is not running Ollama.** On a Hub whose AI runs on vLLM or
  Lemonade, Planning uses the Hub's OpenAI-compatible endpoint for chat, and for embeddings when one is named.
  An Ollama address always wins when one is set.
- **The first-run connect step shows your Companion Memory and AI.** It says whether Companion Memory is connected
  or configured for this server, and whether an AI model is ready. Connecting stays in Settings.
- **A Companion Portal sign-in by someone without an account here says so.** The sign-in screen explains that the
  account is not set up on this server, instead of showing a bare error.
- **The app shows its own mark everywhere.** The navigation, the mobile top bar and the sign-in screens showed a
  generic chip icon. They now show the calendar mark from the app icon.
- **The web app opens on the mark, not a blank page.** The app's mark on its dark background shows from the first
  paint and while it checks your sign-in. Before, the page was blank and then a bare spinner.
- **The iOS and Android launch screens show the app's mark** on its dark background. Before, the framework's
  placeholder showed while the app started.
- **The app installs with a maskable icon**, so Android can crop it to the launcher's shape without clipping the mark.
- **The Tasks page offers Add a task when it is empty**, as well as connecting a source.
- **Phone tabs scroll sideways on one line.** The tabs on Tasks, Balance and Settings wrapped into a second row
  that pushed the content down.
- **Open-time windows name their directions.** Each window shows work, home or community, where it showed a
  single letter.
- **A new account's Today is quieter.** Until there are tasks or blocks, the header drops the open-time windows and
  the capacity bar, and shows the day with the connect prompt.
- **Loading shows placeholder bars** on the open-time card, the Tasks archive and the balance metrics, instead of a
  line of text.
- **The desktop details drawer has a collapse button.** It folds the drawer away and keeps the selection, so
  reopening brings the same item back. The close button still clears the selection.

### Fixed
- **The name field no longer opens as "System".** A new owner is seeded with that placeholder, and the first-run
  wizard and the profile showed it as the owner's name. Both now open empty and ask for one, and Save stays off
  until you type a name.
- **The Hub's Ollama address is read.** The CI Hub writes `APP_OLLAMA_URL` for the app; Planning now reads it, so an
  Ollama on the Hub is found without also setting `OLLAMA_URL`.
- **Estimate calibration no longer learns from the schedule's own plan.** The close ritual sent its
  pre-filled duration (the block span, capped at the block end, or else the estimate) as the actual
  minutes even when you never touched the field, so the estimate-bias ratio sat near 1.0 and a block
  that overran was invisible. The ritual now sends minutes only when you edit the field, and says so
  under it. A timed run keeps its measured value. Tasks closed earlier may still carry a pre-filled
  figure. The same change fixes the duration field swallowing your first edit: the pre-fill was written
  back over the number you typed, so a single edit read as the pre-fill.
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
- **Accessibility checks run in the test suite.** axe-core checks the login screen and the boot screen, so a rule
  that breaks in jsdom fails CI. Colour contrast needs a real browser and is not checked yet.
- **`pnpm snapshot` works from the repo root.** The backup script only existed in `server/`, but
  `ops/litestream.yml` and the Settings backup warning already told people to run `pnpm snapshot`.
  The root now has the shortcut, like `seed` and `migrate`.
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
- **Settings → Learning.** A new Settings tab shows what the weekly learning passes have measured: how often
  the model's category and motivation guesses match your corrections, how many of the suggestions you decide
  on you dismiss, how often Auto's placements are kept, and how often AI day ordering passes its own check.
  Each figure shows how many cases are behind it, never shows a week with nothing measured as 0%, and says
  what it does not prove. The first three have a button that clears what was learned; your history is kept
  and Monday's pass can learn it again. The fourth only measures. No server change.

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
- **`AUTH_RATE_MAX` is gone.** It was parsed but nothing read it, and there was never a global
  per-IP request limit; only `AUTH_RATE_WINDOW_MS` and `AUTH_RATE_ISSUE_MAX` (sign-in, sign-up,
  password reset and the Portal start) have any effect. Setting `AUTH_RATE_MAX` is now ignored, as
  it was before. `server/.env.example` also no longer calls `CP_MCP_COMMAND` required: unset, it
  runs the bundled Calendar server.
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
