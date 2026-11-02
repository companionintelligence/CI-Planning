# Error reporting (Sentry)

Companion Planning reports crashes to [Sentry](https://sentry.io). It is
**opt-out**: on any build configured with a DSN, reporting is **on by default**, and
the user turns it off with the **Share crash reports** toggle in the app store (or
`CI_TELEMETRY=off` directly).

Two statements are both true here and easy to conflate:

- **Configured with a DSN → reporting is on** unless the user turns it off. That is
  the shipped appliance: release images carry a DSN.
- **No DSN → nothing initialises**, and neither the server nor the browser bundle
  makes an outbound connection. That is a source checkout, a local `pnpm dev`, or any
  build made without `SENTRY_DSN` / `VITE_SENTRY_DSN`. It is the absence of
  configuration, not a privacy setting.

So "opt-out" describes what a user of the appliance experiences. It does not mean a
DSN-less build quietly reports — it cannot.

The env contract and the scrubbing rules are shared with the rest of the first-party
fleet — CI-Server is the reference implementation
(`docs/operations/error-reporting.md` there), and CI-Import-Tools follows the same
one. If you change the posture here, change it there too.

## Turning it off

Three controls, in precedence order — the first that applies wins:

| # | Control | Effect |
|---|---|---|
| 1 | `CI_LOCAL_ONLY=true` | Local-only mode means zero phone-home. Beats everything, including a baked-in DSN. |
| 2 | **Share crash reports** toggle in the app store, or `CI_TELEMETRY=off` | The marketplace toggle sets exactly `CI_TELEMETRY` on the container. Also `false`, `0`, `no`, `disabled`. |
| 3 | Run/build with no DSN | Not a user-facing setting — with no DSN there is nothing initialised to disable. |

```bash
CI_TELEMETRY=off docker compose up -d
# or, on an appliance in local-only mode:
CI_LOCAL_ONLY=true docker compose up -d
```

Neither 1 nor 2 needs a rebuild, and both cover **both halves** of the app: the
browser asks `GET /api/config/telemetry` before it initialises, so a switch set on the
container reaches the bundle too. An unset `CI_TELEMETRY` means "the DSN decides", not
"off".

## Privacy posture

This app holds the user's calendar, their task list and their weekly reflections, so
reporting is deliberately narrower than a default Sentry install:

| Setting | Value | Why |
|---|---|---|
| `sendDefaultPii` | `false` | No IPs, cookies, or request bodies. |
| `tracesSampleRate` | `0` | Errors only. Traces would ship request shapes we have no consent to collect. |
| Session replay | not installed | Would record the user's own calendar and reflections on screen. |
| Profiling | not installed | Same reason, plus it buys nothing for an errors-only posture. |
| `includeServerName` | `false` | Otherwise every event carries `os.hostname()`. |
| `beforeSend` | scrubber | Redacts credentials, home paths and URLs; drops cookies/body/query string. |

`sendDefaultPii: false` is a deliberate divergence from CI-Hub's current
`sendDefaultPii: true`, which is tracked as gap #7 in CI-Engineering's
[security-trust-and-ops](https://github.com/companionintelligence/CI-Engineering/blob/main/architecture/subsystems/security-trust-and-ops.md).
We do not repeat it.

> **`sendDefaultPii: false` gates much less than its name suggests.** In
> `@sentry/core` 10.69.0 the flag maps (via `defaultPiiToCollectionOptions`) to a
> **denylist**, not to "off". With PII disabled the SDK still attaches request headers
> — only `["forwarded", "-ip", "remote-", "via", "-user"]` are denied, so
> `authorization` and `x-api-key` are not — still attaches `request.url` (its own
> source comments *"URL is always included"*), still captures stack-frame locals
> (`stackFrameVariables: true`), and still stamps the machine hostname into
> `server_name`. **The scrubber, not the flag, is what actually closes those.** If you
> are reviewing this posture, review `scrub.ts`.

Two kill switches disable reporting even when a DSN is baked into an image, so an
operator can turn it off without a rebuild:

| Variable | Effect |
|---|---|
| `CI_TELEMETRY=off` | Explicit opt-out (also `false`, `0`, `no`, `disabled` — case-insensitive). |
| `CI_LOCAL_ONLY=true` | Local-only mode means zero phone-home (also `1`, `yes`, `on`, `enabled`; case-insensitive). |

`CI_LOCAL_ONLY` takes precedence over `CI_TELEMETRY`, which takes precedence over the
DSN. The losing reasons are still resolved and exposed as `disabledReason`
(`local-only` / `opt-out` / `no-dsn`), and anything other than `no-dsn` is logged once
at boot — so an operator can see *which* switch is holding reporting off rather than
guessing.

### Both switches reach the browser too

The browser's DSN is inlined by Vite at **build** time, so a shipped bundle cannot see
`CI_TELEMETRY` or `CI_LOCAL_ONLY` — they are runtime env on the container. Left at
that, the CI-Marketplace **"Share crash reports"** toggle (which sets `CI_TELEMETRY`)
would switch off the server half and leave the browser reporting.

So the browser asks. Before `Sentry.init` it calls
**`GET /api/config/telemetry`** — unauthenticated, `no-store`, and returning exactly
`{ enabled: boolean, disabledReason: 'local-only' | 'opt-out' | null }`, never the DSN
or any other configuration. The check **fails closed**: an error, a non-2xx, a
malformed body or a timeout (3 s) all leave reporting off, because "cannot confirm
permission" is not permission.

Two consequences worth knowing:

- A build-time DSN alone is never sufficient to start reporting. The server has to
  agree, on every page load.
- There is a short window at startup — first paint until the verdict lands — in which a
  thrown error is not reported. Reporting something we have not been given permission
  to send is the worse failure, so the window stays.

## What gets scrubbed

`server/src/lib/telemetry/scrub.ts` and its browser twin
`client/src/lib/telemetry-scrub.ts` run as `beforeSend` on every event and apply the
same rules:

**Content**

- Bearer tokens, `api_key=` / `api-key:` / `password:` / `token:` style pairs, Tailscale
  `tskey-…`, and credentials in connection URLs (`postgres://user:pw@host`) →
  `[Filtered]`
- Home directories (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) → `~`, since
  they leak the account name
- Object keys matching
  `password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_ ]?key|signature|hub[-_]user`
  → `[Filtered]`, at any depth. Note `api[-_ ]?key` rather than a bare `api_key`: the
  header this app authenticates with is `x-api-key`, which the hyphen-less spelling
  misses entirely. `signature` and `hub[-_]user` cover the CI-Hub Traefik forward-auth
  triple (`X-CI-Hub-User`, `-Timestamp`, `-Signature`), which arrives on every request:
  the end-anchored person-key rule below catches only the bare `x-ci-hub-user`
- Object keys naming a **person** —
  `(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-` → `[Filtered]`.
  These carry no credential, so no *value* pattern would ever match them: the key is the
  only signal there is. It matters here because the app runs behind the CI-Hub Traefik
  proxy and the SDK captures the headers that **arrived**, not the ones application code
  reads — a proxy-injected `x-ci-hub-user` reaches the event even though nothing in this
  repo looks at it. The anchoring is deliberate: `user-agent` and opaque row ids
  (`owner_id`, `user_id`) survive, being diagnostic signal rather than identity
- Strings over 8 KB truncated, so a stray blob can't smuggle plan contents out inside
  an exception message
- Recursion is depth-guarded at 8, so a cyclic payload can't stall the reporting path

> **Every walker consults the key.** All three entry points that iterate a key/value map
> — `scrubValue`, `scrubHeaders`, `scrubBreadcrumbData` — run the key check themselves.
> This is not incidental: the CI-Hermes port found a bug in CI-Server's browser copy
> where the breadcrumb walker passed each *value* to the value-scrubber individually, so
> the key check never ran and a crumb carrying `data.token = "abc123456"` shipped intact.
> A bare secret matches no pattern; only the key gives it away. `keyFilteringCases()` in
> the shared fixtures pins all three walkers in both packages, against a value chosen to
> match nothing, so the assertion can only pass via the key check.

**Fields**

| Field | Treatment | Why it needs treatment |
|---|---|---|
| `request.url` | query + hash stripped | Attached unconditionally, and on Node it is path **+ query** — this is where the search terms actually are. Filtering `query_string` alone redacts nothing. |
| `request.query_string` | `[Filtered]` | — |
| `request.cookies`, `request.data` | deleted | Session cookie; task/plan text the user wrote. |
| `request.headers` | key filter, plus URL treatment for `Referer`/`Referrer` | Headers still ship with PII off. `Referer` is the full previous URL — in the browser, `document.referrer` under the default policy. |
| `server_name` | deleted (and `includeServerName: false`) | The machine hostname. |
| `exception…stacktrace.frames[]` | `filename`, `abs_path`, `module`, `context_line`, `pre_context`, `post_context` scrubbed; `vars` walked | Absolute paths and captured locals — `stackFrameVariables` stays on with PII off. |
| `breadcrumbs[].message` / `.data` | scrubbed; `url`/`from`/`to` get URL treatment | Not just navigation: fetch/xhr crumbs carry `data.url` **with** the query string, console crumbs carry raw `data.arguments`. |
| `extra` | walked | — |

The browser additionally drops chunk-load and `ResizeObserver` noise, which says
nothing about a real defect.

**On the twin files.** The two scrubbers are duplicates, not a shared module: they live
in separate pnpm packages with different bundlers, and a third workspace package for
~100 lines was not worth it. The cost of that choice is drift, so both suites run one
shared fixture set (`client/src/lib/telemetry-fixtures.ts`) through their own copy —
see `server/test/telemetry-parity.test.ts`. A rule tightened on one side and forgotten
on the other fails CI. Same arrangement CI-Server uses for its Python twins.

This is separate from, and not a replacement for, `server/src/lib/logger.ts`'s own
redaction of log `meta`. The two have different payload shapes; they are not meant to
disagree about what counts as a secret.

## Sentry projects

The `companion-intelligence` org uses one project per marketplace app id (existing:
`ci-memory`, `ci-import-tools`, `hub-backend`, `hub-frontend`, `hub-desktop`). This
app's id is `ci-planning`, so both halves report into one project and are told apart
by the `component` tag:

| Component | `component` tag | Platform | DSN variable |
|---|---|---|---|
| `server/` (Koa) | `ci-planning-server` | `node` | `SENTRY_DSN` |
| `client/` (SolidJS) | `ci-planning-client` | `javascript` | `VITE_SENTRY_DSN` (**build time**) |

`@sentry/browser` is used on the client rather than `@sentry/solid`: the Solid
package's value is router *tracing* instrumentation, and tracing is exactly what this
posture switches off.

## Enabling it

```bash
# .env — every one of these is optional; unset means no reporting at all
SENTRY_DSN=https://<key>@o<org>.ingest.us.sentry.io/<id>
SENTRY_ENV=production          # else CI_PLANNING_ENVIRONMENT, else NODE_ENV, else "development"
CI_PLANNING_VERSION=4.2.2      # release becomes ci-planning-server@4.2.2
```

The browser DSN is a **build-time** value — Vite inlines `import.meta.env.*` into the
bundle, so it must be present when `pnpm --filter client build` runs, not at container
start. In Docker it is a build arg:

```bash
docker build \
  --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN \
  --build-arg VITE_SENTRY_DSN=https://<key>@o<org>.ingest.us.sentry.io/<id> \
  --build-arg VITE_SENTRY_RELEASE=ci-planning-client@4.2.2 \
  -t ci-planning .
```

(The `--secret` is not about Sentry: the Dockerfile's install step needs a GitHub Packages
token for the private `@companionintelligence/*` packages, and fails without one.)

The Dockerfile also takes the server half as build args — `SENTRY_DSN`, `SENTRY_RELEASE` and
`CI_PLANNING_VERSION` — and bakes them into the image as `ENV`. Released images are built
that way, so a marketplace install reports without the operator setting anything; the kill
switches [above](#turning-it-off) still win. A value baked in this way can no longer be
overridden from `/data/.env`, because Node's `--env-file-if-exists` only fills keys the
process does not already define.

Once a DSN is configured, reporting is on without any further step. See
[Turning it off](#turning-it-off) for how a user or operator switches it back off —
no rebuild required, and it covers both halves.

## Environment variables

| Var | Side | Default | Purpose |
|---|---|---|---|
| `SENTRY_DSN` | server, runtime | (unset) | Enables server reporting. Unset ⇒ nothing initialises. |
| `VITE_SENTRY_DSN` | client, **build** | (unset) | Enables browser reporting. Baked into the bundle by `vite build`. |
| `CI_TELEMETRY` | server, runtime | (unset) | `off`/`false`/`0`/`no`/`disabled` ⇒ reporting off regardless of the DSN. |
| `CI_LOCAL_ONLY` | server, runtime | (unset) | `true`/`1`/`yes`/`on`/`enabled` ⇒ zero phone-home, beats everything. |
| `SENTRY_ENV` | server, runtime | (unset) | Sentry `environment`. Falls back to `CI_PLANNING_ENVIRONMENT`, then `NODE_ENV`, then `development`. |
| `CI_PLANNING_ENVIRONMENT` | server, runtime | (unset) | Second choice for `environment`. |
| `CI_PLANNING_VERSION` | server, runtime | (unset) | Derives `release` as `ci-planning-server@<version>` when `SENTRY_RELEASE` is unset. |
| `SENTRY_RELEASE` | server, runtime | (unset) | Explicit release string; wins over the derived one. |
| `VITE_SENTRY_RELEASE` | client, **build** | (unset) | Browser release string. |
| `VITE_CI_PLANNING_ENVIRONMENT` | client, **build** | Vite `MODE` | Browser `environment`. |

## Verifying

To confirm reporting is genuinely inert, start the server with no `SENTRY_DSN` and
check that nothing reaches `ingest.sentry.io`. The boot log stays silent in that case
(the default needs no explanation); with `CI_TELEMETRY=off` or `CI_LOCAL_ONLY=true` it
logs one line naming the reason.

Check the browser gate directly:

```bash
curl -s localhost:3848/api/config/telemetry
# {"enabled":true,"disabledReason":null}      — reporting permitted
# {"enabled":false,"disabledReason":"opt-out"} — CI_TELEMETRY=off is set
```

Confirm the DSN-less bundle really is inert — the SDK should not merely be idle, it
should be **absent**:

```bash
pnpm build && grep -c sentry server/public/assets/*.js   # expect 0
```

The gate and the scrubbers are unit-tested end to end:

```bash
pnpm --filter server test telemetry    # gate matrix, scrubber, flush bound, /api/config/telemetry
pnpm --filter client test telemetry    # browser scrubber + shared-fixture parity
```

Once a DSN is configured:

```bash
sentry issue list companion-intelligence/ci-planning --query "is:unresolved"
```

## Where it hooks in

| Path | Role |
|---|---|
| `server/src/lib/telemetry/settings.ts` | Resolves the reporting gate from env — DSN + kill switches (pure, env-injected), plus `telemetryPermission()` for the browser gate |
| `server/src/lib/telemetry/scrub.ts` | The `beforeSend` payload scrubber |
| `server/src/lib/telemetry/timeout.ts` | `withTimeout` — the real wall-clock bound on the flush |
| `server/src/lib/telemetry/index.ts` | `Sentry.init`, `captureException`, bounded `flushTelemetry` |
| `server/src/routes/telemetry-config.ts` | `GET /api/config/telemetry` — the browser's runtime gate |
| `server/src/index.ts` | Initialises telemetry **before** `./boot.js`; captures + flushes a fatal boot failure before `process.exit(1)` |
| `server/src/boot.ts` | SIGTERM/SIGINT shutdown flushes before `process.exit(0)` |
| `server/src/app.ts` | Koa error middleware captures 5xx only (a thrown 4xx is the API working as designed) |
| `client/src/lib/telemetry.ts` | Browser gate + init |
| `client/src/lib/telemetry-scrub.ts` | Browser scrubber (twin of the server's) |
| `client/src/lib/telemetry-fixtures.ts` | The shared fixture set both parity suites run |
| `client/src/main.tsx` | Starts `initTelemetry()` before the root render |
| `client/src/App.tsx` | Root `ErrorBoundary` captures — a caught error never reaches `window.onerror` |

Uncaught exceptions and unhandled rejections are left to the SDK's own
`OnUncaughtException` / `OnUnhandledRejection` integrations: this app registers no
crash handlers of its own, and the SDK's capture *and flush* before the process dies.

**Exit paths.** Where the app itself calls `process.exit` on an error or shutdown path,
it awaits `flushTelemetry()` first — the transport is asynchronous, so exiting straight
after a capture drops the report. Two details make that safe rather than merely
well-intentioned:

- **The bound is real.** `Sentry.close(ms)` is not a wall-clock timeout — it only limits
  how long the transport waits, and still resolves on a later event-loop turn, so a
  handler behind queued synchronous work can overrun by an arbitrary amount. The flush
  is raced against an actual (`unref`'d) timer in `timeout.ts`.
- **Reporting-off costs nothing.** When telemetry is disabled — whether switched off
  or simply never configured with a DSN — those paths exit **synchronously**, exactly
  as they did before this feature existed.
  Awaiting even an already-resolved promise defers the exit by a turn, and crash and
  `docker stop` timing must not change for deployments that never send anything.

## Not wired up yet

- **No source maps are uploaded.** `docker-publish.yml` (dispatched by hand — see
  [docs/CI.md](../CI.md)) supplies both DSNs from the repository `SENTRY_DSN` secret — the
  server's as a runtime `ENV`, the client's as a `VITE_SENTRY_DSN` build arg — and sets
  the releases to `ci-planning-server@<commit sha>` and `ci-planning-client@<commit sha>`,
  so a published image reports and the opt-out default documented above has something to
  act on. Its app smoke-test containers set `CI_TELEMETRY=off` so they do not file events
  into the production project. It still runs no
  `sentry sourcemaps upload`, so browser stack traces arrive minified and are hard to
  read. CI-Hub's `desktop-release.yml` has the pattern; it needs a `SENTRY_AUTH_TOKEN`
  secret, which this repo does not have yet.
- **In-app consent UI.** Reporting is an operator-level switch. The CI-Marketplace
  "Share crash reports" toggle drives `CI_TELEMETRY` and now reaches both halves, but
  there is no per-user control inside the app itself — the same gap tracked for CI-Hub
  in
  [security-trust-and-ops](https://github.com/companionintelligence/CI-Engineering/blob/main/architecture/subsystems/security-trust-and-ops.md)
  (P2).
- **Startup window in the browser.** Errors thrown between first paint and the
  `/api/config/telemetry` verdict are not reported. Buffering them would mean holding
  events we may turn out not to have permission to send, so this is deliberate.
- **Release health.** The Node SDK's default `ProcessSession` integration sends a
  session envelope per process when a DSN *is* configured. It carries release,
  environment and status — no PII — and matches CI-Server's behaviour, so it is left
  on for fleet consistency rather than being a deliberate feature.
