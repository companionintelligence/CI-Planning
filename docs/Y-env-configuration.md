# Y — Environment configuration audit — planning doc

**Status:** Existing-gap cleanup **DONE** (2026-07-01, branch `claude/y-env-config`) — `server/.env.example` now documents every variable the server reads, grouped by concern; verified by an independent audit workflow (0 discrepancies). **Depends on:** nothing to start; revisited after **U/V** finalize their new variables (**T adds none**).

## Correction on scope, first

You asked about "ollama viteTest and puppiteer." Checked all three against the actual repo:

- **Ollama** — real, already configured (`OLLAMA_URL`, `OLLAMA_SMALL`, `OLLAMA_MEDIUM`, `OLLAMA_EMBED` in `server/src/lib/config.ts` and `server/.env.example`). Nothing broken here; just needs to stay documented as new phases add AI-adjacent config.
- **"viteTest"** — this is **Vitest**, and it's real and fully wired: `client/package.json` (`"test": "vitest run"`) and presumably a matching server-side script. No env-var gaps found specific to it beyond what's already documented (Q's hygiene doc already notes `TZ=UTC` is required for deterministic test runs).
- **"Puppeteer"** — **does not exist in this codebase.** Checked `server/package.json` and the whole repo — no Puppeteer dependency anywhere. The actual container/screenshot testing tool is **Playwright** (`tests/container/screenshot.spec.ts`, `capture-listing.mjs`, referenced in `Q-schema-hygiene.md`'s CI description: *"Build, screenshot-test, publish"*). **If you specifically want Puppeteer introduced for a new purpose, tell me what — otherwise this doc treats your "puppiteer" env-config ask as "the existing Playwright container-test setup," which already works and mainly needs documenting, not building.**

## Goal

Two things, both real gaps found in the audit below: (1) `server/.env.example` is significantly out of date relative to what `config.ts` actually reads, and (2) once T/U/V ship, they'll add a batch of new variables that need to land in the same place, documented the same way, from day one rather than accumulating undocumented `process.env` reads the way the current file already has.

## Current gap (verified — real, not hypothetical)

`server/.env.example` today mentions only: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (the only **active/uncommented** vars), plus the four `OLLAMA_*` vars, `PORT`, and `DB_PATH` — but those last six are present **only as commented-out examples** (`# OLLAMA_URL=…`, `# PORT=3848`, `# DB_PATH=`), not live settings (verified 2026-07-01). So a deployer who copies the file gets three real VAPID lines and six commented hints — everything else `config.ts` reads is absent entirely.

`server/src/lib/config.ts` actually reads, and `.env.example` currently says nothing about:

```
SNAPSHOT_RETAIN
AUTH_MODE, AUTH_JWKS_URL, AUTH_ISSUER, AUTH_AUDIENCE, AUTH_CONTRACT_VERSION,
  AUTH_AUTO_PROVISION, AUTH_RATE_WINDOW_MS, AUTH_RATE_MAX, AUTH_RATE_ISSUE_MAX
CP_KEK_B64, CP_KEK_VERSION
CP_GOOGLE_CLIENT_ID, CP_GOOGLE_CLIENT_SECRET, CP_GOOGLE_AUTH_URI, CP_GOOGLE_TOKEN_URI,
  CP_GOOGLE_REVOKE_URI, CP_OAUTH_REDIRECT_URI, CP_GOOGLE_ENABLE_GMAIL,
  CP_MCP_COMMAND, CP_MCP_TIMEOUT_MS, CP_MCP_RETRIES
GOOGLE_MODE
CP_SYNC_WRITEBACK, CP_SYNC_DISABLED
PUBLIC_BASE_URL
```

That's the `config.ts` subset alone. A full audit (2026-07-01) found the **real read surface is ~37 variables**, including several read *outside* `config.ts` that a config.ts-only pass misses: `LOG_LEVEL` (`lib/logger.ts`), `CP_KEK_B64_V{n}` (`lib/crypto`, KEK rotation), `CP_GOOGLE_JWKS_URI` (`routes/oauth.ts`), `CP_GOOGLE_ACCOUNT` (`mcp/google.ts`), `CP_MCP_BREAKER_THRESHOLD`/`CP_MCP_BREAKER_COOLDOWN_MS` (`mcp/client.ts`), `CP_FIXTURES_DIR` (test-only), and `TZ`. **This existing-gap cleanup is now DONE** (branch `claude/y-env-config`): `server/.env.example` documents every one, grouped by concern, with defaults and required-when notes; `PATH` and the internally-injected `GOOGLE_ACCESS_TOKEN` are intentionally excluded as non-deployer plumbing. It was the single fastest, lowest-risk deliverable in this plan (pure documentation, zero behavior change).

## New variables T-V will add (drafted in each phase doc; consolidated here for one clean `.env.example` pass at the end)

| Var | From phase | Purpose |
|---|---|---|
| `AUTH_MODE=local` (new enum value, not new var) | U | Disables OIDC, enables local login |
| `AUTH_DEFAULT_USERNAME` | U | Seeded local admin account |
| `AUTH_DEFAULT_PASSWORD` | U | Required if `AUTH_MODE=local` and no users exist — boot-fails if unset |
| (email-sending vars — exact names depend on V's self-send-vs-Hub decision) | V | SMTP/provider credentials, or a Hub API endpoint/key |
| (Hub OIDC values, likely reusing existing `AUTH_JWKS_URL`/`AUTH_ISSUER`) | U | Pointed at hub.companionintelligence.com specifically |

## Proposed structure for the updated `.env.example`

Group by concern, matching `config.ts`'s own section comments (it already groups reasonably — VAPID, Ollama, then a flat "optional overrides" catch-all at the end that should instead become one section per concern: Auth, Google connector, Sync, KEK, and now th