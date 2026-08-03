# Error reporting (Sentry)

Companion Planning can report crashes to [Sentry](https://sentry.io). It is **opt-in
and off by default**: with no DSN configured, no Sentry code initialises and neither
the server nor the browser bundle makes an outbound connection.

The env contract and the scrubbing rules are shared with the rest of the first-party
fleet — CI-Server is the reference implementation
(`docs/operations/error-reporting.md` there), and CI-Import-Tools follows the same
one. If you change the posture here, change it there too.

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
| `CI_LOCAL_ONLY=true` | Local-only mode means zero phone-home (also `1`, `yes`, `on`). |

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
  `password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_ ]?key`
  → `[Filtered]`, at any depth. Note `api[-_ ]?key` rather than a bare `api_key`: the
  header this app authenticates with is `x-api-key`, which the hyphen-less spelling
  misses entirely
- Strings over 8 KB truncated, so a stray blob can't smuggle plan contents out inside
  an exception message
- Recursion is depth-guarded at 8, so a cyclic payload can't stall the reporting path

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
CI_PLANNING_VERSION=0.3.0      # release becomes ci-planning-server@0.3.0
```

The browser DSN is a **build-time** value — Vite inlines `import.meta.env.*` into the
bundle, so it must be present when `pnpm --filter client build` runs, not at container
start. In Docker it is a build arg:

```bash
docker build \
  --build-arg VITE_SENTRY_DSN=https://<key>@o<org>.ingest.us.sentry.io/<id> \
  --build-arg VITE_SENTRY_RELEASE=ci-planning-client@0.3.0 \
  -t ci-planning .
```

Turning it off again, without rebuilding — this covers **both** halves, because the
browser consults `/api/config/telemetry` before it initialises:

```bash
CI_TELEMETRY=off docker compose up -d
# or, on an appliance in local-only mode:
CI_LOCAL_ONLY=true docker compose up -d
```

## Environment variables

| Var | Side | Default | Purpose |
|---|---|---|---|
| `SENTRY_DSN` | server, runtime | (unset) | Enables server reporting. Unset ⇒ nothing initialises. |
| `VITE_SENTRY_DSN` | client, **build** | (unset) | Enables browser reporting. Baked into the bundle by `vite build`. |
| `CI_TELEMETRY` | server, runtime | (unset) | `off`/`false`/`0`/`no`/`disabled` ⇒ reporting off regardless of the DSN. |
| `CI_LOCAL_ONLY` | server, runtime | (unset) | `true`/`1`/`yes`/`on` ⇒ zero phone-home, beats everything. |
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
| `server/src/lib/telemetry/settings.ts` | Resolves the opt-in gate from env (pure, env-injected), plus `telemetryPermission()` for the browser gate |
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
- **Reporting-off costs nothing.** When telemetry is disabled — the default — those
  paths exit **synchronously**, exactly as they did before this feature existed.
  Awaiting even an already-resolved promise defers the exit by a turn, and crash and
  `docker stop` timing must not change for deployments that never send anything.

## Not wired up yet

- **Source map upload in CI.** `docker-publish.yml` does not pass `VITE_SENTRY_DSN` /
  `VITE_SENTRY_RELEASE` or run `sentry sourcemaps upload`, so browser stack traces
  from a published image would be minified. CI-Hub's `desktop-release.yml` has the
  pattern to copy.
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
