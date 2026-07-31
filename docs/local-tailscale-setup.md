# Running Companion Planning on a home server, reachable over Tailscale

> Operator runbook for the "one box on the tailnet, used from laptop + phone" shape.
> Provisioning the Google client itself is [docs/google-cloud-setup.md](google-cloud-setup.md);
> this doc is the surrounding host setup. Written against the `beta-1` install
> (2026-07-30) — substitute your own hostname and tailnet.

## The shape

One process, one port. The Koa server serves both the API and the built PWA on
**3848**; `tailscale serve` terminates TLS in front of it and proxies to
`127.0.0.1:3848`. There is no separate client dev server in this mode — `pnpm dev`'s
Vite server on 5173 is for development only and is *not* what you expose.

```
phone / laptop ──HTTPS──> tailscale serve (:443, tailnet only) ──> 127.0.0.1:3848
                              │                                         │
                          Let's Encrypt cert                    Koa: /api/* + PWA
                          issued for *.ts.net                   SQLite (single file)
```

Serving on the **root** (`:443`, no port suffix) rather than a high port matters for two
reasons: Google's OAuth redirect registration is a byte-for-byte string match and a
port suffix is one more thing to get wrong, and iOS/Android "Add to Home Screen" wants
a clean origin.

## 1. Host setup

```bash
corepack enable
pnpm install
pnpm --filter client build     # emits into server/public/ — the server serves this
```

The client build is **not** automatic. Re-run it after any client change, or the
served PWA stays stale while the API moves on.

## 2. `server/.env`

`DB_PATH` **must** be set explicitly on Linux (only macOS and the Docker image have a
built-in default). Point it outside the checkout so the database survives branch
switches, worktree deletion, and `git clean`:

```bash
DB_PATH=/home/<you>/.local/share/companion-planning/companion.db
```

Set `PUBLIC_BASE_URL` to the externally reachable HTTPS origin, not localhost — it
derives the OAuth redirect URI and the base for password-reset links:

```bash
PUBLIC_BASE_URL=https://<host>.<tailnet>.ts.net
TRUST_PROXY=true    # honor X-Forwarded-Proto/-For from tailscale serve
```

`TRUST_PROXY` is what makes the app realize it is being reached over HTTPS. Without it
session cookies are not marked `Secure` and login rate-limiting buckets every remote
device under one proxy IP.

### Auth: pick deliberately

`AUTH_MODE=test` means **no login at all** — every request is auto-owned by the system
owner carrying `read`+`write`+`admin`. It is the default outside production and it is
correct for a laptop-only dev loop. It is *not* automatically correct once
`tailscale serve` is on, because **every device on the tailnet can then read and write
your data with no credential** — including other people's machines if you share a
tailnet. The alternatives:

| Mode | Set | Notes |
|---|---|---|
| `test` | `AUTH_MODE=test` | No login. Requires `NODE_ENV` ≠ `production` (boot guard refuses otherwise). |
| local login | `AUTH_MODE=sso`, `DISABLE_OIDC=true`, `SESSION_SECRET`, `AUTH_DEFAULT_USERNAME`/`_PASSWORD` | Username + password, argon2-hashed, signed session cookie. |
| CI-Portal SSO | `AUTH_MODE=sso`, `CIPORTAL_CLIENT_ID` | Needs a client registered with CI-Portal. |

If you stay on `test`, tighten the blast radius at the network layer instead — a
Tailscale ACL restricting `beta-1:443` to your own devices, e.g.:

```jsonc
{"action": "accept", "src": ["you@example.com"], "dst": ["beta-1:443"]}
```

And never put this behind `tailscale funnel`, which publishes to the open internet.
`tailscale serve` is tailnet-only; `funnel` is not.

## 3. Run it as a systemd user service

Do not leave the server in a terminal. A user unit gives you restart-on-failure,
start-at-boot, and `journalctl`. Installed copy lives at
`~/.config/systemd/user/companion-planning.service`; the template is
[ops/systemd/companion-planning.service](../ops/systemd/companion-planning.service).

```bash
cp ops/systemd/companion-planning.service ~/.config/systemd/user/
# edit WorkingDirectory + ExecStart to your checkout path
systemctl --user daemon-reload
systemctl --user enable --now companion-planning
journalctl --user -u companion-planning -f
```

Two details that bite:

- **`WorkingDirectory` must be `server/`.** `CP_MCP_COMMAND` is a *relative* path
  (`node_modules/.bin/tsx src/scripts/mcp-google-server.ts`), so the Calendar MCP child
  only resolves when the process cwd is `server/`.
- **`TimeoutStopSec` should be generous.** SQLite needs a clean shutdown to checkpoint
  the WAL; a hard kill mid-write leaves a large `-wal` alongside the database.

Run `loginctl enable-linger <user>` if you want the service up before anyone logs in.

## 4. Expose it over Tailscale

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3848
tailscale serve status
```

Check the mapping actually has a live backend — `tailscale serve status` happily lists
proxies whose target died months ago, and those return **502** with no other signal.
Before adding a mapping, confirm the port is free *and* that any existing entry you are
replacing is genuinely dead:

```bash
ss -tlnp | grep :3848
curl -s -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/
```

To back out: `tailscale serve --https=443 off`.

## 5. Install on the phone

With HTTPS live, the PWA is installable. Verify the two assets the install prompt
needs actually serve:

```bash
curl -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/manifest.webmanifest
curl -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/sw.js
```

Then, with Tailscale connected on the phone: open the URL, **Share → Add to Home
Screen** (iOS Safari) or **⋮ → Install app** (Android Chrome). Web Push works from the
installed PWA — the server auto-generates and persists a VAPID keypair on first boot
(sealed with `CP_KEK_B64` when set), so notifications survive restarts with no config.

On iOS, Web Push is only delivered to a PWA that was **added to the Home Screen** — it
does not work from a normal Safari tab.

## 6. Local LLM model selection

AI features (briefings, task extraction, grooming, auto-scheduling) need Ollama. The
built-in defaults (`qwen2.5:0.5b` / `gemma3n:e4b` / `nomic-embed-text`) are names most
installs do not have; when they are missing the app auto-selects from what you actually
have, ranking `completion` models by parameter count.

Auto-selection **excludes every model advertising the `thinking` capability**, because a
thinking model asked for `format:"json"` returns an empty string and each AI feature then
degrades silently to its deterministic fallback. That exclusion is correct but can leave a
thin menu: on a box stocked with modern models (qwen3, gemma4, nemotron) *all* of them may
be thinking models, and selection falls through to whatever non-thinking model remains —
possibly a small vision model. Audit what you actually got:

```bash
curl -s localhost:3848/api/integrations | python3 -m json.tool   # smallModel/mediumModel
curl -s localhost:11434/api/show -d '{"model":"<name>"}' | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["capabilities"])'
```

Pin explicitly once you know, using non-thinking instruct models:

```bash
OLLAMA_SMALL=qwen2.5:7b      # latency-sensitive: tagging, quick-add enrichment
OLLAMA_MEDIUM=qwen2.5:14b    # quality: briefings, grooming
OLLAMA_EMBED=mxbai-embed-large:latest
```

An env pin is used **verbatim even if the model is not installed**, so a typo here fails
every inference call. Cross-check against `ollama list`.

## 7. Google Calendar

Leave `GOOGLE_MODE` **unset**. Setting it pins the mode and makes the in-app screen
read-only; leaving it unset lets an admin paste the OAuth client into
**Settings → Connections** at runtime, which flips live mode on with no restart and no
secret in a file. That path needs `CP_KEK_B64` (32 bytes, base64) to seal the client
secret and tokens at rest.

Because the redirect is an HTTPS `ts.net` origin, you need a **Web** OAuth client (not
Desktop), and the registered redirect URI must equal `CP_OAUTH_REDIRECT_URI`
byte-for-byte. Confirm what the server will actually send before registering anything:

```bash
curl -s localhost:3848/api/google-config
# -> {"redirectUri":"https://<host>.<tailnet>.ts.net/api/oauth/google/callback", ...}
```

`kekAvailable: true` and `envPinned: false` in that response mean the in-app path is
ready. Walk up the rungs in [google-cloud-setup.md §8](google-cloud-setup.md) — inbound
read-only first, `CP_SYNC_WRITEBACK` second, Gmail last (it is a Google *restricted*
scope requiring verification and a paid CASA assessment).

## Operating notes

```bash
systemctl --user restart companion-planning     # after changing server/.env
journalctl --user -u companion-planning -f      # logs
pnpm --filter client build && systemctl --user restart companion-planning   # after client changes
```

Backups: the `snapshot_db` cron writes daily into `<DB_DIR>/backups/`
(`SNAPSHOT_RETAIN`, default 7). The database is a single SQLite file — copy it, but
copy `-wal` and `-shm` alongside it or stop the service first, or you will restore a
database missing everything since the last checkpoint.
