# Google Cloud setup — provisioning the standalone OAuth client

> **Scope.** This runbook is the operator guide for connecting Companion Planning to
> Google with its **own** OAuth flow (Authorization Code + PKCE/S256, run in-process).
> Tokens are encrypted at rest in the `connection_tokens` store — there is no macOS
> Keychain dependency and no external agent bridge. Architecture: [ARCHITECTURE.md §10](../ARCHITECTURE.md#10-google-connector).
> The README env table is the canonical list of variable names.
>
> Route, flag and variable names below match the code (`server/src/lib/config.ts`,
> `server/src/routes/oauth.ts`).
>
> There are two ways to hand the OAuth client to the app: the `CP_GOOGLE_*` environment
> variables this runbook walks through, or an admin pasting the client id and secret into
> **Settings → Connections** at runtime (no restart, no secret in a file). The in-app path
> needs `CP_KEK_B64` (§5) to seal the secret and is read-only whenever `GOOGLE_MODE` is set
> in the environment (`server/src/services/google-config.ts`).

## 0. Prerequisites

- A Google account and access to the [Google Cloud Console](https://console.cloud.google.com/).
- `openssl` on the host (for KEK generation).
- Decide your reachability model up front — it determines the OAuth client **type**:
  - **Local-first / loopback** (default `PUBLIC_BASE_URL=http://localhost:3848`): use a
    **Desktop / installed** client.
  - **Remote over Tailscale HTTPS** (`https://<host>.<tailnet>.ts.net`): use a **Web**
    client with a client secret.

---

## 1. Create the GCP project

1. Cloud Console → top project picker → **New Project**. Name it (e.g.
   `companion-planning`) and create it.
2. Select the new project so subsequent steps land in it.
3. **APIs & Services → Library**, enable:
   - **Google Calendar API**
   - **Gmail API**

---

## 2. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen.**
2. **User type:** *External* (a personal Google account cannot use *Internal* outside a
   Workspace org).
3. Fill app name, support email, developer contact.
4. **Publishing status — Testing vs Production:**
   - Leave the app in **Testing** for personal / single-user use. This is the simplest path
     and avoids Google's verification review.
   - **Unverified-app caveats while in Testing:**
     - You must add each Google account that will connect under **Test users** (max **100**
       test users).
     - Refresh tokens issued to a Testing app **expire after 7 days**. You will be forced
       to re-run the OAuth flow weekly. To get long-lived refresh tokens you must move the
       app to **Production**, which (because of the scopes below) triggers Google's OAuth
       **verification** review.

---

## 3. Scopes

The app requests exactly these — no more (least privilege):

| Scope | Sensitivity | Use |
|---|---|---|
| `openid`, `email` | Always requested | Identity: the callback resolves the connected account from the `id_token`'s `email` claim, and Google only returns an `id_token` when `openid` is requested. |
| `https://www.googleapis.com/auth/calendar.events` | **Sensitive** | Read calendar events; write task blocks back (only when `CP_SYNC_WRITEBACK=true`). Always requested. |
| `https://www.googleapis.com/auth/gmail.readonly` | **RESTRICTED** | Read message bodies for task extraction. Requested only when `CP_GOOGLE_ENABLE_GMAIL=true`. |

These match `config.google.scopes` in `server/src/lib/config.ts` (identity = `openid` +
`email`, calendar = `calendar.events`, gmail = `gmail.readonly`) and `buildGoogleScopes()` in
`server/src/mcp/gmail-flag.ts`, which adds the Gmail scope only when the flag is set.

> ⚠ **Restricted-scope warning.** `gmail.readonly` is a **RESTRICTED** scope. To publish
> the app to Production with Gmail enabled, Google requires full **OAuth verification**
> *and* an annual third-party **CASA** (Cloud Application Security Assessment) — a paid,
> time-consuming security review. For single-user local-first use, prefer to stay in
> **Testing** (accepting the 100-test-user / 7-day-refresh-token limits above), or enable
> **Calendar only first** and add Gmail last (see §7).

---

## 4. Create the OAuth client + register the redirect URI

The **redirect-config rule**: Google only redirects to a URI that is registered on the
client *byte-for-byte*. CP's redirect URI is `CP_OAUTH_REDIRECT_URI`, which defaults to
`${PUBLIC_BASE_URL}/api/oauth/google/callback`. Whatever you register here **must equal**
the value CP will send.

### 4a. Local-first (Desktop / installed client, loopback)

1. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
2. **Application type: Desktop app.** A Desktop/installed client uses a **loopback
   redirect** and does **not** require a client secret for PKCE — this is the right choice
   for `http://localhost`/`127.0.0.1`.
3. Note the **Client ID** → set `CP_GOOGLE_CLIENT_ID`.
4. Leave `PUBLIC_BASE_URL` at its default (`http://localhost:3848`) so
   `CP_OAUTH_REDIRECT_URI` resolves to `http://localhost:3848/api/oauth/google/callback`.

### 4b. Remote over Tailscale HTTPS (Web client + secret)

1. Create an OAuth client ID of type **Web application**.
2. Under **Authorized redirect URIs**, add **exactly**
   `https://<host>.<tailnet>.ts.net/api/oauth/google/callback`.
3. Set `PUBLIC_BASE_URL=https://<host>.<tailnet>.ts.net` (or set `CP_OAUTH_REDIRECT_URI`
   explicitly to the same value you registered).
4. Note **Client ID** and **Client secret** → `CP_GOOGLE_CLIENT_ID` /
   `CP_GOOGLE_CLIENT_SECRET`. **Never commit the secret.**

> If `CP_OAUTH_REDIRECT_URI` and the registered URI disagree by even a trailing slash,
> Google returns `redirect_uri_mismatch` and the flow fails closed.

---

## 5. Generate the KEK (`CP_KEK_B64`)

Stored tokens are AES-256-GCM encrypted; the key is a **32-byte** value passed as base64.

```bash
openssl rand -base64 32
```

Set the output as `CP_KEK_B64`. It must decode to exactly 32 bytes or the token store
refuses to operate. **Never commit it.** Losing it makes every stored token
unrecoverable (you simply re-run OAuth).

### KEK rotation

Keys are versioned; rows record the `key_version` they were sealed under.

1. Generate a new key and expose it under the next version, e.g. `CP_KEK_B64_V2`.
2. Set `CP_KEK_VERSION=2` so fresh seals use the new version.
3. Run the rotation: `rotateKek(newVersion)` in `server/src/lib/crypto/index.ts` re-seals
   every `connection_tokens` row under the new key in one atomic, idempotent transaction
   and refuses downgrades. **Nothing in the app calls it yet** — there is no CLI, route or
   job for it (only `server/test/crypto.test.ts` exercises it) — so a rotation means
   calling that function yourself against the database. The historical key for any
   not-yet-rotated row must still be present as `CP_KEK_B64_V{n}` (the current version may
   also live in plain `CP_KEK_B64`). Rotation re-encrypts existing tokens — **no account
   needs to re-authenticate.**
4. The rotation covers `connection_tokens` only. A client secret saved in **Settings →
   Connections** is opened with the key version it was sealed under, so keep that
   `CP_KEK_B64_V{n}` available, or save the client in Settings again after switching
   versions (a save seals under the current version).

---

## 6. Identity & revocation guarantees (operator-visible)

These two rules are enforced in the code; the runbook states them so operations never
contradict the implementation:

- **Identity comes from the token endpoint, not the front channel.** Account identity is
  taken from the `id_token` returned by the **token endpoint** (`CP_GOOGLE_TOKEN_URI`),
  not from any browser-supplied parameter. The `id_token`'s signature is verified
  against Google's published keys at `CP_GOOGLE_JWKS_URI` before its identity claim is
  trusted. Treat the account label CP assigns as authoritative.
- **Revoke sends the token in the request body.** Disconnecting an account POSTs the
  token to `CP_GOOGLE_REVOKE_URI` **in the request body** (not the URL query), so the
  secret is never placed in a URL. The revoke is best-effort — a failure is logged and
  swallowed — and CP then drops the `connection_tokens` row either way.

---

## 7. The calendar MCP server (`CP_MCP_COMMAND`)

CP is an MCP **client** — it does not call Google directly. For each connected account it
spawns a Google **MCP server** child process and injects that account's OAuth access token
into the child via the `GOOGLE_ACCESS_TOKEN` env var (the only secret in the child's env).
CP ships a calendar MCP server (`server/src/scripts/mcp-google-server.ts`) that fulfils the
4 calendar tools (`calendar_list_events`, `calendar_create_event`, `calendar_update_event`,
`calendar_delete_event`) against the Google Calendar REST API, and `CP_MCP_COMMAND` defaults
to running it under `tsx`, mirroring how the app itself runs (the server has no build step):

```
CP_MCP_COMMAND="node_modules/.bin/tsx src/scripts/mcp-google-server.ts"
```

Live mode therefore works without setting it. Set `CP_MCP_COMMAND` only to point at a
different MCP server; an empty value fails the first sync with `McpUnavailable: No MCP
command configured`.

Run the CP server process with the `server/` directory as its working directory so both
`node_modules/.bin/tsx` and the relative script path resolve (the Dockerfile, the systemd
unit and `pnpm --filter server` all do).

- **Calendar-only by default.** The shipped server exposes only the 4 calendar tools. CP
  requires the Gmail tools only when `CP_GOOGLE_ENABLE_GMAIL=true`, so a calendar-only
  deployment connects cleanly. Gmail (the RESTRICTED scope) is rung 4 of the staged order
  below.
- **Primary calendar.** The server operates on the connected account's `primary` calendar.
- **Account key.** The live client currently binds its MCP session to a single account
  key, `CP_GOOGLE_ACCOUNT` (default `primary`), until in-app multi-account selection lands.

---

## 8. Staged enablement order

Walk live mode up one rung at a time; verify at each step before advancing.

1. **Fixture (opt-in).** `GOOGLE_MODE=fixture`. Fully offline; confirm the app and the
   sync reconciler behave on committed sample data. An unset `GOOGLE_MODE` is *off* — no
   Google integration at all — not fixture, and under `NODE_ENV=production` the server
   refuses to boot in fixture mode unless `CP_ALLOW_FIXTURE=true`.
2. **Live inbound, read-only.** Set `GOOGLE_MODE=live`, `CP_GOOGLE_CLIENT_ID`
   (+ secret for a Web client), `CP_KEK_B64` and a matching `CP_OAUTH_REDIRECT_URI`
   (or leave `GOOGLE_MODE` unset and save the client in **Settings → Connections**
   instead). Keep `CP_SYNC_WRITEBACK` **off**. Connect an account from **Settings →
   Connections** — its button calls `GET /api/oauth/google/start`, which returns the Google
   authorize URL — and confirm Calendar events mirror inbound as locked meeting blocks.
   Nothing is written back to Google.
3. **Enable write-back.** Set `CP_SYNC_WRITEBACK=true` once inbound is trusted; local block
   changes now push to Google (etag-guarded; remote wins on conflict).
4. **Add Gmail last.** Gmail's `gmail.readonly` is the RESTRICTED scope (see §3). Add it
   only after Calendar is solid and you've accepted the verification/CASA implications of
   going to Production (or the 100-user/7-day Testing limits). Turn it on with
   `CP_GOOGLE_ENABLE_GMAIL=true` and reconnect the account: the scope is requested at
   connect time.

`CP_SYNC_DISABLED=true` is a master kill switch at any rung. The boot guard refuses
`GOOGLE_MODE=live` without `CP_GOOGLE_CLIENT_ID` + a redirect URI, so a half-configured
live deploy fails fast rather than silently.

---

## See also

- [ARCHITECTURE.md §10 — Google connector](../ARCHITECTURE.md#10-google-connector)
- [ARCHITECTURE.md §9 — Authentication & security](../ARCHITECTURE.md#9-authentication--security)
- [README — Environment variables](../README.md#environment-variables)
