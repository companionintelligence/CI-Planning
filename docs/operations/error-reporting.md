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
| `beforeSend` | scrubber | Redacts credentials and home paths, drops cookies/body/query string. |

`sendDefaultPii: false` is a deliberate divergence from CI-Hub's current
`sendDefaultPii: true`, which is tracked as gap #7 in CI-Engineering's
[security-trust-and-ops](https://github.com/companionintelligence/CI-Engineering/blob/main/architecture/subsystems/security-trust-and-ops.md).
We do not repeat it.

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

## What gets scrubbed

`server/src/lib/telemetry/scrub.ts` runs as `beforeSend` on every event:

- Bearer tokens, `api_key=` / `password:` / `token:` style pairs, Tailscale
  `tskey-…`, and credentials in connection URLs (`postgres://user:pw@host`) →
  `[Filtered]`
- Home directories (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) → `~`, since
  they leak the account name
- Object keys matching
  `password|secret|token|authorization|cookie|jwt|apikey|api_key|dsn|pepper|private_key`
  → `[Filtered]`, at any depth
- Request cookies and bodies dropped; query strings filtered; headers scrubbed
- Strings over 8 KB truncated, so a stray blob can't smuggle plan contents out inside
  an exception message
- Recursion is depth-guarded at 8, so a cyclic payload can't stall the reporting path

The browser bundle (`client/src/lib/telemetry.ts`) additionally strips the query
string **and the hash** from every reported URL and from navigation breadcrumb
`from`/`to` — on this app those carry task text, search terms and the date the user is
looking at — and drops chunk-load and `ResizeObserver` noise, which says nothing about
a real defect.

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

Turning it off again, without rebuilding:

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

The gate and the scrubber are unit-tested end to end:

```bash
pnpm --filter server test telemetry    # 43 assertions: gate matrix + scrubber
pnpm --filter client test telemetry    # 16 assertions: URL/hash stripping + noise filter
```

Once a DSN is configured:

```bash
sentry issue list companion-intelligence/ci-planning --query "is:unresolved"
```

## Where it hooks in

| Path | Role |
|---|---|
| `server/src/lib/telemetry/settings.ts` | Resolves the opt-in gate from env (pure, env-injected) |
| `server/src/lib/telemetry/scrub.ts` | The `beforeSend` payload scrubber |
| `server/src/lib/telemetry/index.ts` | `Sentry.init`, `captureException`, bounded `flushTelemetry` |
| `server/src/index.ts` | Initialises telemetry **before** `./boot.js`; captures + flushes a fatal boot failure before `process.exit(1)` |
| `server/src/boot.ts` | SIGTERM/SIGINT shutdown flushes before `process.exit(0)` |
| `server/src/app.ts` | Koa error middleware captures 5xx only (a thrown 4xx is the API working as designed) |
| `client/src/lib/telemetry.ts` | Browser init + scrubber |
| `client/src/main.tsx` | Calls `initTelemetry()` before the root render |
| `client/src/App.tsx` | Root `ErrorBoundary` captures — a caught error never reaches `window.onerror` |

Uncaught exceptions and unhandled rejections are left to the SDK's own
`OnUncaughtException` / `OnUnhandledRejection` integrations: this app registers no
crash handlers of its own, and the SDK's capture *and flush* before the process dies.
Every place the app itself calls `process.exit` on an error or shutdown path awaits
`flushTelemetry()` first — the transport is asynchronous, so exiting straight after a
capture would drop the report.

## Not wired up yet

- **Source map upload in CI.** `docker-publish.yml` does not pass `VITE_SENTRY_DSN` /
  `VITE_SENTRY_RELEASE` or run `sentry sourcemaps upload`, so browser stack traces
  from a published image would be minified. CI-Hub's `desktop-release.yml` has the
  pattern to copy.
- **Consent UI.** Reporting is an operator-level switch, not a user-facing one — the
  same gap tracked for CI-Hub in
  [security-trust-and-ops](https://github.com/companionintelligence/CI-Engineering/blob/main/architecture/subsystems/security-trust-and-ops.md)
  (P2).
- **Release health.** The Node SDK's default `ProcessSession` integration sends a
  session envelope per process when a DSN *is* configured. It carries release,
  environment and status — no PII — and matches CI-Server's behaviour, so it is left
  on for fleet consistency rather than being a deliberate feature.
