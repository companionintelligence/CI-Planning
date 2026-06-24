# Google Cloud setup — provisioning the standalone OAuth client

> **Scope.** This runbook is the operator guide for connecting Companion Planning to
> Google with its **own** OAuth flow (Authorization Code + PKCE/S256, run in-process).
> Tokens are encrypted at rest in the `connection_tokens` store — there is no macOS
> Keychain dependency and no external agent bridge. Architecture: [ARCHITECTURE.md §12](../ARCHITECTURE.md#12-mcp-integration).
> The README env table is the canonical list of variable names.
>
> Some route/flag names below are **assumed, in-flight contracts** from sibling work
> packages and are labelled inline where they appear; provisioning steps and env-var
> names reflect the as-built WP1 config (`server/src/lib/config.ts`).

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

Request exactly these — no more (least privilege):

| Scope | Sensitivity | Use |
|---|---|---|
| `https://www.googleapis.com/auth/calendar.events` | **Sensitive** | Read calendar events; write task blocks back (only when `CP_SYNC_WRITEBACK=true`). |
| `https://www.googleapis.com/auth/gmail.readonly` | **RESTRICTED** | Read message bodies for task extraction. |

These match `config.google.scopes` in `server/src/lib/config.ts` (calendar = `calendar.events`,
gmail = `gmail.readonly`).

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
3. Run the rotation (re-seals every row under the new key in one atomic, idempotent
   transaction; refuses downgrades). The historical key for any not-yet-rotated row must
   still be present as `CP_KEK_B64_V{n}` (the current version may also live in plain
   `CP_KEK_B64`). Rotation re-encrypts existing tokens — **no account needs to
   re-authenticate.**

---

## 6. Identity & revocation guarantees (operator-visible)

These two rules are enforced in the code; the runbook states them so operations never
contradict the implementation:

- **Identity comes from the token endpoint, not the front channel.** Account identity is
  taken from the `id_token` returned by the **token endpoint** (`CP_GOOGLE_TOKEN_URI`),
  not from any browser-supplied parameter. Treat the account label CP assigns as
  authoritative.
- **Revoke targets the token endpoint in the request body.** Disconnecting an account
  POSTs the token to `CP_GOOGLE_REVOKE_URI` **in the request body** (not the URL query),
  so the secret is never placed in a URL. After revocation CP drops the
  `connection_tokens` row.

---

## 7. The calendar MCP server (`CP_MCP_COMMAND`)

CP is an MCP **client** — it does not call Google directly. For each connected account it
spawns a Google **MCP server** child process and injects that account's OAuth access token
into the child via the `GOOGLE_ACCESS_TOKEN` env var (the only secret in the child's env).
**Live mode does nothing until `CP_MCP_COMMAND` points at a server**: left unset,
`GOOGLE_MODE=live` fails fast on the first sync with `McpUnavailable: No MCP command
configured`.

CP ships a calendar MCP server (`server/src/scripts/mcp-google-server.ts`) that fulfils the
4 calendar tools against the Google Calendar REST API. Point `CP_MCP_COMMAND` at it under
`tsx`, mirroring how the app itself runs (the server has no build step):

```
CP_MCP_COMMAND="node_modules/.bin/tsx src/scripts/mcp-google-server.ts"
```

Run the CP server process with the `server/` directory as its working directory so both
`node_modules/.bin/tsx` and the relative script path resolve.

- **Calendar-only by default.** The shipped server exposes only the 4 calendar tools. CP
  requires the Gmail tools only when `CP_GOOGLE_ENABLE_GMAIL=true`, so a calendar-only
  deployment connects cleanly. Gmail (the RESTRICTED scope) is rung 4 of the staged order
  below.
- **Primary calendar.** The server operates on the connected account's `primary` calendar.

---

## 8. Staged enablement order

Walk live mode up one rung at a time; verify at each step before advancing.

1. **Fixture (default).** `GOOGLE_MODE=fixture`. Fully offline; confirm the app and the
   sync reconciler behave on committed sample data.
2. **Live inbound, read-only.** Set `GOOGLE_MODE=live`, `CP_GOOGLE_CLIENT_ID`
   (+ secret for a Web client), `CP_KEK_B64`, a matching `CP_OAUTH_REDIRECT_URI`, and
   `CP_MCP_COMMAND` (§7). Keep `CP_SYNC_WRITEBACK` **off**. Connect an account via
   `GET /api/oauth/google/start` and confirm Calendar events mirror inbound as locked
   meeting blocks. Nothing is written back to Google.
3. **Enable write-back.** Set `CP_SYNC_WRITEBACK=true` once inbound is trusted; local block
   changes now push to Google (etag-guarded; remote wins on conflict).
4. **Add Gmail last.** Gmail's `gmail.readonly` is the RESTRICTED scope (see §3). Add it
   only after Calendar is solid and you've accepted the verification/CASA implications of
   going to Production (or the 100-user/7-day Testing limits).

`CP_SYNC_DISABLED=true` is a master kill switch at any rung. The boot guard refuses
`GOOGLE_MODE=live` without `CP_GOOGLE_CLIENT_ID` + a redirect URI, so a half-configured
live deploy fails fast rather than silently.

---

## See also

- [ARCHITECTURE.md §12 — MCP Integration](../ARCHITECTURE.md#12-mcp-integration)
- [ARCHITECTURE.md §16 — Security / Privacy Posture](../ARCHITECTURE.md#16-security--privacy-posture)
- [README — Environment variables](../README.md#environment-variables)
