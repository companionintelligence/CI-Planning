# J — Two-way calendar sync (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). **Depends on I** (identity, encrypted token store, `requireAuth`/`lib/context.ts`) and **F** (the 2-D grid that renders the blocks this phase pushes and pulls). It turns the read-only fixture ingestion into real bidirectional sync — keyed on `external_id` + `etag`, **never embeddings**.

## Goal
1. A `connectors/` module on a **`BaseOAuth2Client`** pattern (Google first; Outlook/iCloud are the same shape), drawing tokens from Phase I's encrypted store.
2. **Outbound:** owner's task/auto blocks → external calendar events, created/updated/deleted within one cycle.
3. **Inbound:** external events → **read-only, locked `meeting` blocks** (the existing `'gcal'` mirror, generalized per-provider).
4. An **`external_events` mapping table** that is the single sync-identity record, so create→update→delete round-trips leave **no duplicates and no orphans**.

## Non-goals
- **No fuzzy/semantic matching for sync identity.** Identity is `(provider, account, external_id)` and freshness is `etag` — exact and deterministic. Embeddings stay confined to the ingest→task heuristic in `agents/groom.ts` (`dedupePossibles`); they never decide whether two calendar records are "the same."
- **No token minting or OAuth UI here** — that is Phase I. J consumes the token store; in Hub mode it does not even hold its own tokens (delegated to CI-Server).
- **No continuous re-plan** on inbound meetings — that is Phase K (which triggers off J's inbound writes).
- **No recurrence expansion of remote series** — pull each instance the provider returns; do not re-derive RRULE remotely (E owns local recurrence).

## Current state (what exists today)
- **`server/src/mcp/google.ts`** — `GoogleClient` with `mode: 'fixture' | 'live'`. `createFixtureGoogleClient()` reads `emails.json` / `calendar.json` from the fixtures dir (offline, deterministic). `createLiveGoogleClient()` is **scaffolded but a stub**: it logs a warning and returns the fixture client with `mode:'live'` (`TODO(phase-2)` to wire real MCP sessions + OAuth from the Keychain). `createGoogleClient()` honors `GOOGLE_MODE`.
- **`server/src/jobs/index.ts`** — croner jobs `ingest_gmail`/`ingest_gcal` (and `nightly_grooming`, `auto_schedule`) run via `runJob(kind)`, which records a `job_runs` row and broadcasts `job:started`/`job:run` over SSE. **One-way only:** `ingest_gcal` pulls; nothing pushes.
- **`server/src/agents/ingest.ts`** — `upsertMeetingBlock()` already mirrors a `CalendarEvent` into `time_blocks` as a `block_kind='meeting'`, `is_locked=1`, `is_auto=0`, `source_kind='gcal'` row, **idempotent on `source_ref = event.id`**. This is the inbound seed J generalizes — but it has **no `etag`**, so it can detect "seen" but not "changed," and it cannot delete a mirror when the remote event is gone.
- **`server/src/db/schema.ts`** — `time_blocks` carries `sourceKind`/`sourceRef`, `isLocked`, `isAuto`, `blockKind`. There is **no provider/account/etag** column and **no mapping table**. Blocks are owner-scoped only transitively (via `taskId`); meeting mirrors have `taskId = NULL`.
- **`server/src/routes/blocks.ts`** — `GET/POST /api/blocks`, `PATCH /api/blocks/:id`, `DELETE /api/blocks/:id`. Outbound sync hooks these mutations.
- **`server/src/agents/groom.ts`** — `dedupePossibles()` uses Ollama embeddings + cosine over `possible_tasks`. **For the ingest heuristic only.** It is the explicit anti-pattern for sync identity: do not reuse it.

## Design

### 1. `connectors/` module + `BaseOAuth2Client`
New `server/src/connectors/`. `BaseOAuth2Client` is an abstract Koa-free class holding the provider-agnostic mechanics; one subclass per provider maps to the normalized `CalendarEvent` from `mcp/google.ts`.

```ts
// server/src/connectors/base.ts
import { decryptToken } from '../lib/crypto.js';   // Phase I shim (AES-256-GCM)
export interface RemoteEvent {
  externalId: string;
  etag: string;                    // provider's opaque version tag
  title: string; start: string; end: string;   // UTC ISO text
  status: 'confirmed' | 'cancelled';
}
export abstract class BaseOAuth2Client {
  constructor(protected readonly account: ConnectorAccount) {}      // provider+account+token ref
  protected async accessToken(): Promise<string> {
    return decryptToken(await this.tokenStore.get(this.account));   // Phase I; refresh handled there
  }
  abstract listEvents(opts: { from: string; to: string }): Promise<RemoteEvent[]>;
  abstract createEvent(b: BlockDraft): Promise<{ externalId: string; etag: string }>;
  abstract updateEvent(externalId: string, etag: string, b: BlockDraft): Promise<{ etag: string }>;
  abstract deleteEvent(externalId: string, etag: string): Promise<void>;
}
```

- **Fixture mode is preserved unchanged and offline.** `createGoogleClient()` keeps gating on `GOOGLE_MODE`; a `FixtureConnector` implements the same interface against `calendar.json`, with `createEvent/update/delete` writing to an in-memory map (no network). With no connector account configured, J is a no-op — degrade gracefully.
- All timestamps are **UTC ISO text** (matches the codebase); local↔wall-clock conversion stays in `lib/tz.ts`, never in connectors.

### 2. The `external_events` mapping table (new numbered migration)
One row per (block ⇄ remote event) link — the **only** sync-identity record. New schema lands as a **new numbered migration through the B0 runner** (`server/src/db/migrations/00NN_external_events.ts`, appended to the explicit `MIGRATIONS` array — never an ad-hoc `CREATE TABLE IF NOT EXISTS`).

```ts
db.exec(`CREATE TABLE IF NOT EXISTS external_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES owners(id),
  provider     TEXT    NOT NULL,                      -- 'google' | 'outlook' | 'icloud'
  account      TEXT    NOT NULL,                      -- which connected calendar account
  external_id  TEXT    NOT NULL,                      -- provider event id (immutable)
  block_id     INTEGER REFERENCES time_blocks(id) ON DELETE CASCADE,
  etag         TEXT    NOT NULL,                      -- last-synced version
  direction    TEXT    NOT NULL,                      -- 'outbound' | 'inbound'
  last_synced_at TEXT  NOT NULL,                      -- UTC ISO
  UNIQUE (provider, account, external_id)
);`);
db.exec(`CREATE INDEX IF NOT EXISTS ix_external_events_block ON external_events(block_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS ix_external_events_owner ON external_events(owner_id, provider, account);`);
```

- `UNIQUE (provider, account, external_id)` is what makes a re-pull an upsert, not a duplicate. `block_id` `ON DELETE CASCADE` means deleting the local block drops the link row; the sync pass then deletes the remote (see §3).
- `etag` is the **whole** conflict story (§4). `owner_id` is set from `currentOwnerId()` — never a literal.

### 3. Outbound + inbound sync
A single `syncConnectors()` reconciler, invoked by a new `sync_calendar` croner job in `jobs/index.ts` (sibling to `ingest_gcal`, same `runJob` plumbing + SSE `job:run`), run inside `runWithOwner(SYSTEM_OWNER, …)` per connected owner.

**Outbound** (local task/auto blocks → remote). Source set: owner's `time_blocks` where `is_auto=1` or user-created task blocks, excluding `block_kind='meeting'` (those are inbound mirrors — never echo them back).

```ts
for (const block of outboundBlocks(ownerId)) {
  const link = getLink(block.id);                 // external_events by block_id
  if (!link)            await create(block);       // → INSERT external_events(external_id, etag, 'outbound')
  else if (block.updatedAt > link.last_synced_at)  // local edit since last sync
                        await update(block, link); // → UPDATE etag
}
for (const link of orphanLinks(ownerId))           // link row whose block was deleted (cascade already ran
  await client.deleteEvent(link.external_id, link.etag);   //   on hard-delete; soft-delete handled the same)
```
Local **delete removes the remote mirror**: the `DELETE /api/blocks/:id` route (or a soft-delete tombstone) drives the orphan-link path so the next cycle calls `deleteEvent`.

**Inbound** (remote → read-only locked meeting blocks), generalizing `upsertMeetingBlock()`:
```ts
for (const ev of await client.listEvents({ from, to })) {
  const link = getLinkByExternal(provider, account, ev.externalId);
  if (ev.status === 'cancelled') { if (link) deleteBlockAndLink(link); continue; }
  if (!link)               insertMeetingBlock(ev);          // is_locked=1, is_auto=0, block_kind='meeting'
  else if (ev.etag !== link.etag) updateMeetingBlock(link, ev);  // remote changed
  // else: unchanged → skip (deterministic no-op)
}
```
Inbound blocks stay **locked/read-only** so F's drag/resize and K's reflow never move them, exactly as the current `'gcal'` mirror does.

### 4. Conflict resolution by etag
**Identity = `external_id`; freshness = `etag`. Nothing else.**
- **Inbound:** `ev.etag === link.etag` ⇒ no-op. Differ ⇒ remote wins (these blocks are read-only locally; there is no local edit to lose).
- **Outbound update** uses an **optimistic concurrency precondition** (`If-Match: link.etag`). If the provider returns `412 Precondition Failed`, the remote changed under us:
  - remote events we own are **server-authoritative locally** → re-pull, overwrite the local block, store the new `etag`. Deterministic, no merge, no embeddings.
- A `412` is never resolved by guessing similarity; it is resolved by re-reading the authoritative record and adopting its `etag`. This is the whole reason sync identity is exact: **a sync layer must converge to the same state regardless of order**, which embeddings (non-deterministic, threshold-dependent) cannot guarantee.

### 5. Hub-vs-standalone OAuth
Mirrors Phase I's two deployment modes — **one credential store per appliance**, never two.

- **Hub mode (primary):** Planning holds **no** OAuth tokens. `BaseOAuth2Client.accessToken()` delegates to **CI-Server's `connections` / `CloudOAuthProxyService`** — Planning asks the proxy for a fresh access token for `(provider, account)`; refresh, consent, and revocation live on CI-Server. This is the single identity + token store on the box.
- **Standalone mode (public image):** Planning has its **own** connector store — the encrypted-token table from Phase I (`lib/crypto` AES-256-GCM, KEK from env/Hub keystore). It runs its own OAuth redirect; `accessToken()` reads and decrypts locally.
- **Agent-bridge fallback:** where the OAuth proxy is unreachable but an agent context exists, the connector authenticates to CI-Server with a **scoped `x-api-key`** (Phase I's `randomBytes(32)`-hex key, SHA-256 at rest, `scopes[]` limited to calendar) and proxies the calendar call through the bridge. Bounded, explicit, and degrades to fixture/offline if even that is down.

```ts
// selection happens once, at connector construction
const tokenSource = isHubMode()
  ? new CloudProxyTokenSource(ciServerConnections)        // delegate
  : new LocalEncryptedTokenSource(lib_crypto);            // standalone
// agent-bridge wraps either when proxy/network is degraded but x-api-key is present
```

## Tests
- **Fixture mode unchanged & offline:** existing `ingest_gcal` suite green; `FixtureConnector` does create/update/delete against the in-memory map with **no network** (assert no fetch).
- **Round-trip, no duplicates:** create a task block → one remote event + one `external_events` row; edit it → same `external_id`, new `etag`, still one row; delete it → remote `deleteEvent` called, link row gone. **Zero duplicate `external_id`s** asserted via the `UNIQUE` constraint.
- **Local delete removes remote mirror:** `DELETE /api/blocks/:id` → next cycle calls `deleteEvent(external_id, etag)`; remote map empty.
- **Etag conflict resolves deterministically:** seed a link, mutate the remote `etag` out-of-band, run outbound update → provider returns `412` → reconciler re-pulls and adopts the new `etag`; **final state identical regardless of run order** (run the same conflict twice, assert equal end state).
- **No dupes/orphans after 3 cycles:** create+update mixed inbound/outbound set, run `syncConnectors()` three times → `external_events` row count stable, no `block_id` pointing at a missing block, no remote event without a link.
- **Owner isolation:** owner A's blocks never push to owner B's account; `external_events` rows filtered by `currentOwnerId()` (reuses B0/I isolation harness).
- **Inbound stays locked:** mirrored meeting block has `is_locked=1`; a `PATCH /api/blocks/:id` move is rejected (carried from F).

## Acceptance criteria
1. A planned/auto block reaches the real calendar **within one sync cycle**; editing or deleting it propagates the same cycle.
2. New external meetings appear as **read-only locked `meeting` blocks**; cancelled remote events remove their mirror.
3. Sync identity is `(provider, account, external_id)` + `etag` **only** — grep gate: no `embed(`/`cosine(`/`mcp/ollama` import under `server/src/connectors/`.
4. Conflict resolution is deterministic: same inputs ⇒ same end state, independent of order; **no dupes or orphans after 3 cycles**.
5. **Fixture mode still works offline**, unchanged; no connector configured ⇒ J is a silent no-op.
6. Hub mode holds no tokens locally (delegates to CI-Server); standalone uses Phase I's encrypted store; agent-bridge `x-api-key` path exercised.

## Risks / notes
- **etag semantics vary by provider.** Google returns an `ETag`; Outlook uses `@odata.etag`; iCloud/CalDAV uses CalDAV `ETag` headers. Normalize to one opaque string in each subclass; the reconciler treats it as compare-only.
- **Cancelled vs deleted.** Google emits `status:'cancelled'` tombstones on sync tokens; iCloud may just drop the event. Inbound must handle both "saw a cancelled marker" and "event vanished from the window" as delete-the-mirror — bound the pull window so a vanished event is detectable.
- **Clock/etag races on outbound.** Always send `If-Match`; never blind-`PUT`. A missing precondition would silently clobber a concurrent organizer edit — the one place a non-deterministic overwrite could creep in.
- **Do not reuse `dedupePossibles`.** It is embedding-based and threshold-tuned — correct for the ingest heuristic, wrong (non-deterministic) for sync. Keep the wall between them; the grep gate enforces it.
- **Token coupling lives in one place.** Hub-mode token retrieval is the single point of CI-Server coupling (via the published connections contract from Phase I) — keep it behind the `tokenSource` seam so standalone and tests swap it cleanly.
- **better-sqlite3 is synchronous; network is not.** The reconciler is `async`; DB writes per event stay synchronous inside a per-event transaction so a mid-cycle crash leaves no half-linked row.

## Effort
**L** — roughly 1–1.5 weeks. The connector abstraction + Google subclass and the reconciler are the bulk; the `external_events` migration and fixture connector are small. Most care goes into the etag conflict matrix and the orphan/cancel edge cases, not line count.

## Suggested PR breakdown
1. **Mapping table + reconciler skeleton (inbound only).** `00NN_external_events.ts` migration, `external_events` upsert, generalize `upsertMeetingBlock` to write `etag` + a link row, `sync_calendar` job pulling via the **fixture** connector. Ships the inbound round-trip and the "no dupes after 3 cycles" test — zero network.
2. **`BaseOAuth2Client` + Google live connector + outbound.** Real `listEvents/create/update/delete`, outbound push from block mutations, `If-Match`/`412` conflict path, delete-removes-mirror. Ships the etag-conflict and round-trip tests against a mocked provider.
3. **Hub/standalone token sources + agent-bridge.** `CloudProxyTokenSource`, `LocalEncryptedTokenSource` (Phase I `lib/crypto`), scoped `x-api-key` fallback, owner-isolation tests. Wires the credential store per mode without touching the reconciler.

Keeping inbound (PR 1) ahead of live outbound (PR 2) lets the deterministic round-trip tests land and gate before any real network call exists.
