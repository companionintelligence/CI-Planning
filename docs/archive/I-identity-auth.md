# I — Identity, auth & connector infrastructure (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md) (Track 3, Phase I; Locked Decisions D4/D5/D6). Depends on **B0** (`lib/context.ts`, `requireOwner`, owner-scoped SSE) and **R** (audit log, `lib/crypto` will log to it). This phase swaps B0's single-owner resolver for a real, verified token and **gates the entire cloud track (J, K, L)**. It is **verify-only**: Planning validates tokens minted elsewhere and holds a single scoped API key for the standalone image — it never mints CI-Server sessions.

## Goal
1. Turn `requireOwner` into **`requireAuth`** — a Koa middleware that accepts a **JWKS-verified Bearer JWT** (SSO mode) **or** a hashed **`x-api-key`** (standalone mode), resolves `ownerId`, and 401s otherwise — across every REST route **and** the SSE stream.
2. A **minimal** standalone API-key store (one scoped key: SHA-256 at rest, `scopes[]`, `expires_at`, `last_used_at`) — *not* a mirror of CI-Server's session/CSRF/refresh machinery.
3. An **encrypted connection-token store** (AES-256-GCM) isolated in a `lib/crypto` shim, ready for the connectors in J.
4. **Rate-limiting** on auth/key validation, and a written **threat model** as a gating deliverable.

## Non-goals
- **Minting tokens / sessions / CSRF / refresh rotation.** Planning is a resource server (D4/D5). CI-Server owns identity, login, and OAuth (`CloudOAuthProxyService`).
- **Multi-seat UX, invites, role/permission UI.** Owner-scoping exists (B0); this phase authenticates, it does not build team management.
- **Reverse-engineering CI-Server internals (D6).** We depend only on a **published, versioned contract**: a JWKS URL + documented claims. The *only* sanctioned coupling is matching CI-Server's connection-token encryption algorithm (confirmed at build time).
- **Connector OAuth flows themselves** — those are Phase J. This phase ships the *encrypted store* they will write to, not the flows.

## Current state (what exists today)
- **Every route is unauthenticated.** `server/src/app.ts` mounts `cors({ origin: '*' })` → `bodyParser()` → `mountRoutes(app)` (`server/src/routes/index.ts`) with no auth middleware anywhere. `mountRoutes` wires `sse, tasks, blocks, possibles, tags, jobs, prefs, schedule, summary, llm`.
- **B0 (prereq) introduces** `server/src/lib/context.ts` (`AsyncLocalStorage`, `RequestContext { ownerId: number }`, `SYSTEM_OWNER`, `currentOwnerId()`, `runWithOwner()`) and a `requireOwner` middleware that resolves single-owner → `SYSTEM_OWNER`. **This phase swaps that resolver for a real token resolver** and renames the mounted middleware to `requireAuth`.
- **SSE is `server/src/routes/sse.ts`** — `GET /api/events`; B0 makes `clients` a `Map<PassThrough, ownerId>` and `broadcast(ownerId, …)`. The connect handler currently sets no identity beyond what B0's context provides; this phase must authenticate the stream **before** `clients.set(...)`.
- **Owner reads** go through `currentOwnerId()` after B0 (the 7 literals — `routes/prefs.ts:12,24`, `routes/tasks.ts:20,77`, `routes/possibles.ts:40`, `engine/scheduler.ts:40` — are replaced there). This phase changes only *who* the owner is, not the call sites.
- **Config is `server/src/lib/config.ts`** — a plain `Config` interface read from `process.env` (PORT, DB_PATH, OLLAMA_*). No secrets, no auth keys yet.
- **DB:** `server/src/db/index.ts` opens better-sqlite3 + Drizzle; B0 replaces `runSetup` with `runMigrations`. **All new tables here are new numbered migrations through the B0 runner.** No `server/src/db/migrations/` dir exists yet (B0 creates it).
- **Connectors:** `server/src/mcp/google.ts` is fixture/live with a `TODO(phase-2)` to load OAuth tokens "from the Keychain" — there is no token store. This phase provides the encrypted store that replaces that TODO (consumed in J).
- **Tests:** `server/test/helpers.ts` (`startTestServer`, `resetDb`, `api()`) hit the app with **no auth headers** — this is the suite that must keep passing with a test owner injected. Container: `tests/container/screenshot.spec.ts` (Playwright smoke) and `tests/container/capture-listing.mjs` drive the running app over HTTP and currently send no key.

## Design

### 1. SSO mode — verify-only JWKS resource server (D5)
Planning validates a CI-Server-minted JWT against the **published JWKS endpoint** (asymmetric **RS256/EdDSA**). It never holds a signing secret and cannot mint. Use `jose` (`createRemoteJWKSet` + `jwtVerify`) — battle-tested, handles key rotation and caching; do **not** hand-roll JWT parsing.

```ts
// server/src/lib/auth/jwks.ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';

const JWKS = config.auth.jwksUrl
  ? createRemoteJWKSet(new URL(config.auth.jwksUrl), { cooldownDuration: 30_000 })
  : null;

export interface VerifiedClaims { ownerId: number; scopes: string[]; }

export async function verifyBearer(token: string): Promise<VerifiedClaims> {
  if (!JWKS) throw httpError(401, 'sso not configured');
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: config.auth.issuer,            // documented contract value
    audience: config.auth.audience,        // 'companion-planning'
    algorithms: ['RS256', 'EdDSA'],        // never 'none', never HS*
  });
  return mapClaims(payload);               // see below — fail closed on missing claims
}
```

- **Documented claims (the versioned contract, D6):** `sub` → owner identity, `aud` must equal `config.auth.audience`, `iss` must equal `config.auth.issuer`, `scope`/`scopes` → string[]. `mapClaims` rejects (401) any token missing `sub`/`aud`/`iss` or with an unexpected `aud`. The contract version is pinned in config (`auth.contractVersion`) and asserted; a mismatch logs and fails closed.
- **`sub` → `ownerId`:** owners table (B0) gains an `external_subject TEXT UNIQUE` column (new migration) mapping the JWT `sub` to the local integer `ownerId`. First valid token for an unknown `sub` either provisions an owner row or 403s, per `auth.autoProvision` flag (default off in standalone, on in SSO/Hub). Algorithm allow-list is explicit — **never** accept `alg: none` or any `HS*` (that would imply a shared secret we refuse to hold).

### 2. Minimal standalone API-key mode (D4)
One scoped key for the public Docker image. **Not** a session system.

```ts
// migration 0010_api_keys.ts (through the B0 runner)
db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,              -- UUIDv7
  owner_id     INTEGER NOT NULL REFERENCES owners(id),
  prefix       TEXT NOT NULL,                 -- first 5 chars, for lookup + display
  key_hash     TEXT NOT NULL,                 -- SHA-256 hex of the full key; never the key
  scopes       TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  expires_at   TEXT,                          -- ISO; NULL = non-expiring
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);`);
```

```ts
// server/src/lib/auth/apiKey.ts
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '../ids.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function issueApiKey(ownerId: number, scopes: string[], ttlDays?: number) {
  const raw = randomBytes(32).toString('hex');          // 64 hex chars
  const key = `cpk_${raw}`;                              // shown ONCE
  const prefix = key.slice(0, 5);                        // 'cpk_' + 1 → 5-char lookup
  const expires_at = ttlDays ? new Date(Date.now() + ttlDays * 864e5).toISOString() : null;
  db.insert(apiKeys).values({ id: uuidv7(), ownerId, prefix,
    keyHash: sha256(key), scopes: JSON.stringify(scopes), expiresAt: expires_at }).run();
  return key;                                            // caller surfaces once; never re-derivable
}

export function verifyApiKey(presented: string): VerifiedClaims {
  const prefix = presented.slice(0, 5);
  const rows = db.select().from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt))).all();
  const want = Buffer.from(sha256(presented));
  const row = rows.find(r => timingSafeEqual(Buffer.from(r.keyHash), want));  // constant-time
  if (!row) throw httpError(401, 'invalid api key');
  if (row.expiresAt && row.expiresAt < new Date().toISOString()) throw httpError(401, 'expired');
  db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiKeys.id, row.id)).run();
  return { ownerId: row.ownerId, scopes: JSON.parse(row.scopes) };
}
```

- Full key shown **once** at issuance (CLI `pnpm key:issue --scopes …` and/or a Settings panel); only `prefix` + `key_hash` persist. Prefix narrows the candidate set; the SHA-256 compare is **`timingSafeEqual`** over equal-length hex (no early-return on mismatch). Expired / revoked / over-scope → 401/403. `last_used_at` updated on every accepted call (best-effort; failure to update never blocks the request).

### 3. The `requireAuth` middleware
Replaces B0's `requireOwner` at the mount point. JWKS-Bearer **or** `x-api-key`, then `runWithOwner` so every downstream `currentOwnerId()` (B0) resolves to the authenticated owner.

```ts
// server/src/lib/auth/requireAuth.ts
import { runWithOwner } from '../context.js';
import { rateLimitAuth } from './rateLimit.js';

export function requireAuth(): Koa.Middleware {
  return async (ctx, next) => {
    await rateLimitAuth(ctx);                                  // trips before any crypto work
    const bearer = ctx.get('authorization').replace(/^Bearer\s+/i, '');
    const apiKey = ctx.get('x-api-key');
    let claims: VerifiedClaims;
    try {
      if (bearer) claims = await verifyBearer(bearer);         // SSO
      else if (apiKey) claims = verifyApiKey(apiKey);          // standalone
      else { ctx.status = 401; ctx.body = { error: 'unauthenticated' }; return; }
    } catch (e) { ctx.status = (e as any).status ?? 401; ctx.body = { error: 'unauthenticated' }; return; }
    if (!hasScope(claims.scopes, ctx)) { ctx.status = 403; ctx.body = { error: 'forbidden' }; return; }
    await runWithOwner(claims.ownerId, () => next());          // sets ownerId for the request
  };
}
```

- Mounted in `app.ts` **after** `bodyParser()` and **before** `mountRoutes` — every router (including `sseRouter`) sits behind it. A tiny allow-list (e.g. `GET /api/health`, static assets, `/api/auth/config`) is exempted inside the middleware by path prefix; **everything `/api/*` else is gated**.
- **SSE:** because `sseRouter` mounts behind `requireAuth`, the stream is authenticated *before* the handler runs; B0's connect handler then captures `currentOwnerId()` and does `clients.set(stream, ownerId)`. Browsers can't set `Authorization` on `EventSource`, so accept the key/JWT via a short-lived query param **or** require the SSE client to use `fetch`-based streaming with headers; the chosen mechanism is documented and tested (a stream with no/invalid credential gets 401, never a silent open).
- `hasScope` checks a route→scope map (read routes need `planning:read`, mutations `planning:write`); SSO tokens carry scopes from claims, the standalone key from its `scopes[]`.

### 4. Encrypted connection-token store (AES-256-GCM)
For connector tokens (consumed in J). Isolated in one shim so the crypto lives in exactly one place.

```ts
// migration 0011_connection_tokens.ts
db.exec(`CREATE TABLE IF NOT EXISTS connection_tokens (
  id          TEXT PRIMARY KEY,               -- UUIDv7
  owner_id    INTEGER NOT NULL REFERENCES owners(id),
  provider    TEXT NOT NULL,                  -- 'google' | 'outlook' | …
  account     TEXT NOT NULL,
  iv          BLOB NOT NULL,                  -- 12-byte GCM nonce, per-record
  auth_tag    BLOB NOT NULL,                  -- 16-byte GCM tag
  ciphertext  BLOB NOT NULL,                  -- enc(JSON { access, refresh, expiry })
  key_version INTEGER NOT NULL DEFAULT 1,     -- for KEK rotation
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, provider, account)
);`);
```

```ts
// server/src/lib/crypto/index.ts  — the ONLY place that touches the KEK
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const KEK = loadKek();                            // 32 bytes from env CP_KEK_B64 or Hub keystore
export function seal(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEK, iv);
  const ciphertext = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv, ciphertext, authTag: c.getAuthTag() };
}
export function open({ iv, ciphertext, authTag }: Sealed) {
  const d = createDecipheriv('aes-256-gcm', KEK, iv);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');  // throws on tamper
}
```

- **KEK** from `CP_KEK_B64` (env) or the Hub keystore; the app refuses to start in SSO/connector mode if it is absent or not 32 bytes. Per-record 12-byte IV; the GCM tag authenticates — `open` throws on any tamper. `key_version` supports KEK rotation (re-seal on read after rotation).
- **D6 coupling — the one unavoidable seam:** CI-Server's exact connection-token algorithm/params (GCM vs CBC, key derivation) are **confirmed at build time** against the published contract and matched here. If they ever diverge, only `lib/crypto` changes. Confirming this is an explicit task in PR 4, not an assumption.

### 5. Rate-limiting
CI-Server has none on `/authenticate` — this is our explicit addition (D4 note). A small fixed-window/token-bucket limiter keyed by client IP **and** key-prefix, applied to JWKS-Bearer and `x-api-key` validation. In-process Map for single-node (the only deployment now); the limiter lives behind a one-function interface so a Redis backend can drop in for multi-node later. On trip → **429** with `Retry-After`, **before** any signature/hash work (so it also blunts a hash-grinding attack). A separate, tighter limit guards key-issuance and any local-login endpoint.

### 6. Config
Extend `server/src/lib/config.ts`'s `Config` with an `auth` block; defaults keep dev/test on a permissive test-owner path so the existing suite runs unchanged.

```ts
auth: {
  mode: (process.env.AUTH_MODE as 'sso' | 'standalone' | 'test') ?? 'test',
  jwksUrl: process.env.AUTH_JWKS_URL,        // required when mode==='sso'
  issuer: process.env.AUTH_ISSUER,
  audience: process.env.AUTH_AUDIENCE ?? 'companion-planning',
  contractVersion: process.env.AUTH_CONTRACT_VERSION ?? '1',
  autoProvision: process.env.AUTH_AUTO_PROVISION === 'true',
  kekB64: process.env.CP_KEK_B64,            // required for connector store
  rateLimit: { windowMs: 60_000, max: 60, issueMax: 5 },
}
```

- **`mode: 'test'`** (default in Vitest) injects a fixed test owner so `helpers.ts` keeps working with no headers — the test-owner path is config-gated and **rejected at boot if `NODE_ENV==='production'`** (fail closed; production must be `sso` or `standalone`).
- `sso` requires `jwksUrl`/`issuer`; `standalone` requires at least one non-revoked `api_keys` row; connector features require `kekB64`. Each requirement is asserted at startup with a clear error.
- UUIDv7 helper (`lib/ids.ts`) and zod DTOs for the issue/revoke endpoints are added here; **all secret comparisons use `crypto.timingSafeEqual`**.

## Tests
- **Existing suite, test-owner injected:** full Vitest (`server/test/**`) and the container Playwright smoke pass with `AUTH_MODE=test` — `helpers.ts` sends no headers and still gets owner-scoped 200s. No test rewrites for the happy path.
- **No-token → 401 matrix:** parametrized over **every** mounted route in `routes/index.ts` (tasks, blocks, possibles, tags, jobs, prefs, schedule, summary, llm) **and** `GET /api/events` — each returns 401 with no credential; the allow-listed health/config paths return 200.
- **SSO mode:** a fixture JWT signed by a **test JWKS** (local key pair, served via a stub JWKS endpoint) authenticates; wrong `aud`, wrong `iss`, `alg: none`, `HS256`, expired, and tampered-signature tokens each 401.
- **API key:** stored as SHA-256 (assert no plaintext/`cpk_` substring anywhere in `api_keys`); a valid key authenticates; expired → 401; revoked → 401; over-scope (write route, read-only key) → 403; `last_used_at` advances after a successful call.
- **Owner isolation across REST *and* SSE:** owner A's key/JWT can't read or mutate owner B's tasks (404/403); two SSE streams on different owners — `broadcast(A, …)` reaches A's stream only, never B's (extends B0's isolation test through the real auth path).
- **Rate-limit:** N+1 rapid validations trip a 429 with `Retry-After`; the limiter counts *before* signature/hash work (assert via a spy that verify isn't called past the cap).
- **Crypto shim:** `seal`→`open` round-trips; a flipped ciphertext/tag byte makes `open` throw; distinct IV per `seal`; decrypt under wrong KEK throws.
- **Container:** `screenshot.spec.ts` and `capture-listing.mjs` get a **test API key** via env (`APP_API_KEY` → `x-api-key` header / EventSource query param); the bypass strategy is explicit, not a disabled guard.

## Acceptance criteria
1. **Planning verifies but cannot mint** — no signing secret in the codebase or config; SSO path uses JWKS + asymmetric algs only (D5); `alg:none`/`HS*` rejected.
2. **One guard, two credentials** — `requireAuth` accepts JWKS-Bearer **or** `x-api-key`, sets `ownerId` via B0's `lib/context.ts`, 401s otherwise, on every REST route **and** the SSE stream.
3. **Secrets never plaintext** — API keys SHA-256 at rest, connection tokens AES-256-GCM; all secret compares `timingSafeEqual`; UUIDv7 ids; zod-validated DTOs.
4. **Auth endpoints rate-limited** — validation and issuance trip documented limits (429 + `Retry-After`).
5. **Owner isolation proven on REST *and* SSE.**
6. **Threat model reviewed** — written, covering token replay/expiry, JWKS rotation & endpoint compromise, key-hash grinding, KEK exposure, SSE credential leakage via query param, and standalone-key theft; it gates the cloud track.
7. Existing suite green with the test owner; container smoke + `capture-listing.mjs` pass with a test key.

## Risks / notes
- **D6 coupling is the sharpest edge.** The connection-token algorithm must match CI-Server's exactly or tokens written by one won't open in the other. Confirm against the **published, versioned** contract at build time; keep it in `lib/crypto` only; never reverse-engineer from a running CI-Server binary.
- **JWKS endpoint availability/rotation.** A down or compromised JWKS endpoint breaks SSO auth — cache keys (`jose` cooldown), fail closed on verify errors, and alert. Pin issuer/audience so a rotated-but-valid key for the wrong service is still rejected.
- **SSE + headers.** `EventSource` can't send `Authorization`; the query-param/`fetch`-stream credential path must avoid leaking the token in logs/referrers — log redaction for `?token=` and short-lived credentials are required, and explicitly tested.
- **Test-owner footgun.** `AUTH_MODE=test` must be impossible in production — hard-fail at boot under `NODE_ENV=production`. A grep gate (no `AUTH_MODE=test` in prod config/Dockerfile) backs this up.
- **Rate-limit ordering.** Limit before crypto, or the limiter itself becomes a CPU-amplification vector under a hash-grinding flood.
- **argon2id, not bcrypt.** If local passwords are kept at all (optional, and skippable for single-user standalone), use **argon2id**; do not introduce bcrypt. Passwords are out of the critical path — prefer the API key.
- **No down-migrations** (B0 rule) — the new tables are additive (expand); a botched rollout is fixed forward, not reversed.

## Effort
**L** — ~1.5–2 weeks. The middleware, key store, and crypto shim are each modest; the cost is the *matrix* of negative tests across every route + SSE, the SSO fixture/JWKS test rig, the D6 algorithm confirmation, and the written threat model + security review that gates the track.

## Suggested PR breakdown
1. **API-key store + `requireAuth` (standalone path):** `auth/apiKey.ts`, `auth/requireAuth.ts`, `lib/ids.ts`, migration `0010_api_keys`, config `auth` block, `AUTH_MODE=test` owner injection, mount in `app.ts`. Ship the no-token→401 matrix + api-key tests + container test-key wiring. *No SSO yet — fully shippable for the public image.*
2. **SSO verify-only path:** `auth/jwks.ts` (`jose`), `external_subject` owner migration, claim mapping/provisioning, SSO fixture-JWKS test rig, alg/aud/iss negative tests.
3. **Rate-limiting:** `auth/rateLimit.ts`, wire into `requireAuth`, ordering + trip tests.
4. **Encrypted connection-token store:** `lib/crypto/index.ts`, migration `0011_connection_tokens`, KEK loading/boot-assertion, **D6 algorithm confirmation against the published contract**, crypto round-trip/tamper tests. (Connectors that *use* it are Phase J.)
5. **Threat model + security review** (the gating deliverable): `docs/threat-model-I.md`, sign-off before the cloud track opens.

Keeping the standalone path (PR 1) first means the public Docker image gets a real auth surface before the SSO/connector machinery lands.
