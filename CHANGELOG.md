# Changelog

All notable changes to Companion Planning. Releases are git tags (`v4.1.0` was the last
cut before this file existed). The container image is published by dispatching
`docker-publish.yml` on the tag's ref (see [docs/CI.md](docs/CI.md)) and reports the
version at `GET /api/health` (`release`).

## [Unreleased]

### Changed
- **The weekly plan-loop job's log now names the rules the checker flagged most often.** The Jobs view line for
  `calibrate_plan_loop` ends each stage with, for example, "most flagged: priority_inversion (9 of 21
  revision(s)), overlap (4 of 21 revision(s))", or "no rule flagged". The revision log behind it was written on
  every run and never read; this is its first reader. Nothing about how plans are made changes, and the list is
  not stored, so Settings → Learning does not show it yet.
- **The weekly dismissal job's log now says the noise rate.** The Jobs view line for `calibrate_dismissals` ends
  with how many of the suggestions you decided on in the last 7 days you dismissed, for example "noise rate 42%
  (21 of 50 decided dismissed, last 7 days)", or "noise rate not measured" when nothing was decided. It is the
  same reading the job already stored for Settings → Learning.
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
  correction you make changes no prompt until the next Monday `calibrate_classification` run (or the first
  start after it, if the server was down), and a field
  needs at least 2 corrections first.
- **The Describe-it line shows the AI your most common category corrections again, for the models that can use
  them.** The prompt carries up to 3 of the corrections you make most often, last, just before your text; with
  fewer than 2 corrections it is exactly what it was. It is sent only when the model answering is one measured
  to use it: `gemma3n:e4b` (the default quality model, which quick add asks), `qwen2.5:3b` and `gemma3:4b`. On
  any other model quick add leaves it out, because in the same test `qwen2.5:0.5b`, `gemma3:1b` and
  `llama3.2:3b` all answered worse with it (one answered a number for the category, one lost its valid
  direction, one answered nothing). Names in `QUICK_ADD_HINT_MODELS` (comma separated) add models. In a test
  with an invented owner, run twice, the three that can use it ended 2 to 3 of 12 held-out titles ahead
  and kept their natural titles; most of that came by the third correction, more corrections did not add to
  it, and none learned the owner's exercise rule. With the guard on, the other three models were flat,
  as they were before the hint, instead of worse. Learning is still weekly: the Monday `calibrate_classification` run builds what the prompt
  shows, and a field needs at least 2 corrections first. The who-it's-for part was not measured, and the Add
  dialog does not record those picks, so on a default install it stays empty. See
  `docs/quick-add-hint-learning-curve-2026-11.md` and `docs/quickadd-hint-guard-2026-11.md`.
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
- **Describe-it asks your quality model, not the fast one.** Quick add and the Add dialog's Describe-it line
  filled in a category, priority, minutes and the rest from the fast model (`qwen2.5:0.5b` by default). On
  the 12 titles with an obvious category it named the right category in 20 of 60 answers and returned 3 of
  the 9 fields it was asked for, so the dialog came pre-filled with a category that was mostly wrong. It
  now asks the quality model (`gemma3n:e4b` by default, which a default install already pulls): 60 of 60
  right and all 9 fields on every answer, in a test with an invented owner and 42 titles. The price is
  speed. Through the app's own route the preview took a median 1.4 to 1.8 seconds, against 0.09 with
  the fast model, and the first one after the model had been unloaded about 5 seconds (Ollama unloads an
  idle model after 5 minutes unless `OLLAMA_KEEP_ALIVE` says otherwise). On an Ollama server that holds
  only two models at once, quick add, the fast model and the embedding model take turns in the slots: the
  other two were reloaded on most calls in the test (the fast model's calls took 1.5 seconds instead of
  0.09), and once quick add's own model was pushed out and the next preview paid 5.4 seconds. Nothing
  changes for installs that pin `OLLAMA_FAST` and `OLLAMA_QUALITY` to the same model. If the quality
  model is not installed the app uses the largest installed model for it, and quick add then runs on
  that one; that was not measured. Only quick add moved: the fast model still does everything else it did.
  See `docs/quickadd-quality-tier-2026-11.md`.
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
- **Skipped, cancelled and missed blocks no longer count as accepted placements.** Placement learning treated
  an unmoved auto block as accepted once its time had passed, even if the block had been skipped (by you, or by
  the sweep that skips blocks that ended unfinished), cancelled with its task, or marked missed. That made the
  survival reading look better than it was and diluted the corrections the hour bands are built from. These
  blocks now count as neither accepted nor corrected, as a block that has been deleted already did. A move you
  made still counts. The next Monday `calibrate_placement` run uses the corrected rule over the same 90 days.
- **The dismissal pass keeps the similarity data it already has when the model is unreachable.** Each weekly
  `calibrate_dismissals` run rebuilt its examples and embedded every one again, so a run that found Ollama down
  replaced a working index with empty vectors until a later run found it up. It now reuses the vector already
  stored for each dismissal, as the classification pass does: an outage costs only the examples added since, and
  a normal run embeds only the new ones. A changed embedding model is not noticed straight away; old vectors stay
  until their dismissals age out, as in the classification pass.
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
- **Learning passes that were missed while the server was off now run once, about a minute after the next
  start.** The scheduler never re-fires a time that passed while the server was down, so a restart, a
  redeploy or a self-hosted machine that was off through Monday's block (03:50 to 04:50) skipped that
  week's passes, and a correction made the day before waited a further week. Seven jobs are now made up:
  `calibrate_estimates` (nightly) and the six Monday passes (`calibrate_triality`,
  `calibrate_classification`, `calibrate_dismissals`, `calibrate_plan_loop`, `snapshot_balance` and
  `calibrate_placement`). Each runs at most once, one after another, however many runs it missed, and
  `snapshot_balance` freezes only the latest closed week. A job whose next scheduled time is 10 minutes away
  or less waits for it. A job with no recorded run counts as never run, so a first start runs all seven once,
  over empty data. A run that ended in an error is not retried; a run cut short by a restart is tried again at
  the next start, and after two cut-short runs the job waits for its next scheduled time. A disabled job is not
  made up. The Jobs view starts the log of a made-up run
  with "Caught up", for example "Caught up (missed 2026-11-02 04:10)". The server keeps one last-run time per
  job, not one per account, so a run by any account counts for the whole server: if one account presses
  **Run now** after the missed time, the other accounts wait for the next scheduled time, as before. The other
  jobs are not made up. `reset_routines`, `review_day`, `auto_schedule`, `nightly_grooming` and
  `advance_objectives` would change today's tasks and blocks, or move the next cadence, if they ran late; the
  jobs that run every few minutes or hours do their missed work at the next run anyway; the rest of the
  nightly set is left out for now, so a server that is off every night still loses it. The Learning tiles
  still say "early on Monday"; read that as usually the first start after it.
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
