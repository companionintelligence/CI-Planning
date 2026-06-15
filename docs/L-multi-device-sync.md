# L — Multi-device sync & offline writes (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **B0** (migration runner, `lib/context.ts` owner scoping, owner-scoped `broadcast`), **I** (identity — owner resolved from a real token, not the single-owner sentinel), and **H** (service worker — the offline shell this write path plugs into). Implements **Locked Decision D3**: op-log + **field-level** merge with **monotonic completions** — explicitly **not** whole-record last-writer-wins, which v1's contradicted-itself by promising "no lost completions" on top of LWW.

## Goal
1. A **PWA offline write path**: edits made while disconnected are queued locally and applied on reconnect, with the UI updating optimistically and never losing the user's work.
2. **Field-level convergence** across a single owner's devices: two devices editing *different* fields of one task both land, instead of one clobbering the other.
3. **Monotonic completions**: once a task is completed, a concurrent *non-completion* edit (rename, re-tag, reschedule) can **never** silently un-complete it. This is the one correctness rule v1 violated.

## Non-goals
- **Multi-owner / multi-tenant sync.** Scoped to one `ownerId`, many devices (D1). Cross-owner sharing is out.
- **CRDT text co-editing.** Fields are last-writer-wins *per field* (with the completion exception); we do not merge character-level edits inside `notes`/`description`.
- **A second source of truth.** SQLite stays authoritative (Principle: server-authoritative). The client op-log is a durable outbox, not a peer database; the server's applied state always wins on read.
- **Offline *reads* of arbitrary ranges.** H already caches the app shell + last-fetched data; this phase adds the *write* path and reconciliation, not a full offline query engine.
- **Conflict-free deletes of in-flight relationships** (tag rows, dependencies) — those replay as discrete ops, last-writer-wins per relationship.

## Current state (what exists today)
- **Client is fetch-and-refetch, online-only.** `client/src/lib/api.ts` is a thin `fetch` wrapper (`request()`); every mutation (`api.tasks.update`, `api.blocks.update`, …) is a direct `PATCH`/`POST` that throws if the network is down — there is no queue, no retry, no local persistence.
- **Stores refetch on SSE.** `client/src/stores/index.ts` holds SolidJS `createResource`s (`tasks`, `blocks`, `possibles`, …); SSE events (`on('task:updated', () => refetchTasks())` in `client/src/lib/sse.ts`) just trigger a full refetch. Optimism is implicit and lost on any failure.
- **SSE has no catch-up.** `client/src/lib/sse.ts` opens `EventSource('/api/events')` and on `error` closes + reconnects after 5s — but the server replays **nothing**, so events emitted during the gap are lost and the client only recovers via the next user-triggered refetch.
- **Server PATCH is whole-row overwrite, no versioning.** `server/src/routes/tasks.ts` PATCH builds a partial `update` object and does `db.update(tasks).set(update).where(eq(tasks.id, id))` — last write wins on the whole row, no version check, no conflict detection. Completion is just `update.status = 'done'; update.completedAt = now` (line ~136). `server/src/routes/blocks.ts` PATCH is the same shape.
- **`broadcast` is owner-scoped post-B0** (`server/src/routes/sse.ts` → `broadcast(ownerId, event, data)`), but still fire-and-forget into live streams only; no event log, no `Last-Event-ID` handling.
- **Schema has no version/op columns.** `server/src/db/schema.ts`: `tasks`, `timeBlocks`, etc. have `createdAt`/`completedAt` but **no `version`, no `updatedAt`, no per-field timestamps, no changelog**. There is no ops table.

## Design

### 1. Client offline op-log (IndexedDB)
A single durable outbox keyed by client-generated op id. Every mutation writes an op **before** hitting the network; the op is deleted only after the server acks it.

```ts
// client/src/lib/oplog.ts  (IndexedDB via a tiny wrapper; one store: "ops")
export interface Op {
  opId: string;          // uuidv7 (monotonic, client-generated) — also the idempotency key
  entity: 'task' | 'block';
  entityId: number;      // server id; negative temp id for offline-created entities
  fields: Record<string, unknown>;  // ONLY the fields this edit touched (snake_case, API shape)
  baseVersion: number;   // entity.version the client last saw (0 for offline-create)
  clientTs: string;      // UTC ISO, device clock — tiebreak only, never authoritative
  status: 'pending' | 'inflight' | 'acked';
}
export async function enqueue(op: Omit<Op, 'status'>): Promise<void>;
export async function pending(): Promise<Op[]>;   // ordered by opId (uuidv7 → causal-ish)
export async function ack(opId: string): Promise<void>;
```

- **Field-scoped ops, not snapshots.** An op carries *only* the changed fields, so two devices' ops touch disjoint columns and merge cleanly server-side (§3). A "rename" op never carries `status`, so it can never participate in a completion decision.
- `entityId < 0` marks an **offline-created** entity; the server assigns a real id on first apply and returns an id-map (§2) the client rewrites into queued ops.

### 2. Optimistic writes + replay-on-reconnect
The store layer wraps each mutation: apply locally, enqueue, then attempt to flush.

```ts
// client/src/stores/mutations.ts
export async function patchTask(id: number, fields: Partial<Task>) {
  applyLocal('task', id, fields);                 // optimistic: reconcile() into the resource
  const op = { opId: uuidv7(), entity: 'task', entityId: id,
               fields, baseVersion: versionOf(id), clientTs: nowUTC() };
  await enqueue(op);
  void flush();                                    // best-effort; no-op while offline
}
```

- **Flush** drains `pending()` oldest-first to `POST /api/sync` (§3, batch endpoint), marking ops `inflight`, then `ack`ing on success. Triggered on: app start, `online` event, SSE reconnect, and after each local mutation.
- **Offline detection** is failure-driven, not `navigator.onLine`-trusting: a network throw re-queues the op `pending` and backs off; an HTTP 4xx (validation/conflict) surfaces (§6) rather than retrying forever.
- **Optimistic state is reconciled, never trusted over the server.** When the authoritative record arrives (sync response or SSE, §5), the resource is overwritten with server state; any still-pending op for that entity is re-applied on top so the user's un-acked edits don't visually vanish mid-flight.

### 3. Server apply: monotonic per-record version + field-level merge
New columns on every owned, syncable table (`tasks`, `time_blocks`) via **new numbered migrations through the B0 runner** (e.g. `00NN_sync_versioning.ts`), never `setup.ts`:

```sql
ALTER TABLE tasks ADD COLUMN version    INTEGER NOT NULL DEFAULT 1;   -- bumps on every applied change
ALTER TABLE tasks ADD COLUMN updated_at TEXT;                          -- UTC ISO, server clock
-- per-field server-clock stamps for field-level LWW (JSON: { field: isoTs }) :
ALTER TABLE tasks ADD COLUMN field_ts   TEXT;                          -- mode:'json'
```

A `POST /api/sync` endpoint applies a batch of ops in one transaction, owner-scoped via `currentOwnerId()` (B0):

```ts
// server/src/sync/apply.ts  (better-sqlite3 sync tx)
function applyOp(db, op): AppliedResult {
  const row = getOwned(op.entity, op.entityId, currentOwnerId());   // 404 if not this owner's
  const merged: Record<string, unknown> = {};
  const fieldTs = { ...(row.field_ts ?? {}) };
  for (const [field, value] of Object.entries(op.fields)) {
    // FIELD-LEVEL last-writer-wins: keep the value whose stamp is newer per FIELD,
    // not per ROW. Concurrent edits to different fields therefore both survive.
    if (op.clientTs >= (fieldTs[field] ?? '')) {
      merged[field] = applyMonotonic(field, row, value);             // §4 guards `status`/`completed_at`
      fieldTs[field] = op.clientTs;
    } // else: a newer write to THIS field already landed — drop just this field
  }
  const version = row.version + 1;                                   // monotonic per record
  db.update(...).set({ ...merged, field_ts: fieldTs, version, updated_at: nowUTC() })
    .where(eq(id, op.entityId));
  return { entityId: op.entityId, version, applied: merged };
}
```

- **Version is monotonic per record** and advances once per applied op; it is the value clients send as `baseVersion` next time and the cursor SSE catch-up keys on. It is **not** an optimistic-lock reject — a stale `baseVersion` triggers *merge*, not 409 (true conflicts surface via §6, not by rejecting writes).
- **Whole-record LWW is explicitly banned.** The merge is per field via `field_ts`; that is the entire point of D3.

### 4. The monotonic-completion rule
Completion is a one-way ratchet that field-level LWW alone cannot guarantee (a later non-completion edit could carry no `status` yet still, under naive row-merge, resurrect an old row). `applyMonotonic` enforces:

```ts
function applyMonotonic(field, row, value) {
  if (field === 'status') {
    // never transition done -> open via a merge; only an explicit later completion
    // (or an explicit, intentional reopen op) may move OFF 'done'.
    if (row.status === 'done' && value !== 'done' && !value /* op.reopen flag */) return 'done';
  }
  if (field === 'completed_at') {
    // once set, keep the EARLIEST completion timestamp; a concurrent edit can't null it.
    if (row.completed_at && (value == null || value > row.completed_at)) return row.completed_at;
  }
  return value;
}
```

- A `complete` op sets `status='done'` **and** `completed_at`; both fields are stamped, so a *concurrent* rename op (which carries neither) leaves them untouched — the task stays done. This is the invariant v1's LWW broke.
- **Reopen is explicit only.** Un-completing requires an op that deliberately carries the reopen intent; it is never an incidental side effect of editing another field.

### 5. SSE catch-up after disconnect
Make `broadcast` log-backed so a reconnecting client recovers missed events instead of waiting for a user refetch.

- New owner-scoped append-only table (B0 migration): `sync_events(seq INTEGER PK AUTOINCREMENT, owner_id, entity, entity_id, version, event, payload TEXT, at TEXT)`. Every successful apply (and every existing `broadcast` callsite) writes one row, then emits the SSE frame with `id: <seq>`.
- `server/src/routes/sse.ts`: on connect, read the `Last-Event-ID` header (the browser `EventSource` sends it automatically on reconnect). If present, replay `SELECT … WHERE owner_id = ? AND seq > ? ORDER BY seq` before streaming live, so the gap is filled exactly once and in order. Bound the replay (cap rows / fall back to a "resync" event that tells the client to refetch all resources) so a long-offline device can't request an unbounded backlog.
- `client/src/lib/sse.ts`: stop swallowing the cursor — the named-event listeners already parse `e.data`; persist `e.lastEventId` and let the browser resend it. On reconnect, run `flush()` (push local ops) **before** trusting catch-up frames, so the client's own edits are server-acked and won't arrive as surprising "remote" changes.

### 6. Conflict surfacing
Most concurrency converges silently (different fields → both kept; same field → newer wins). A **genuine** conflict — the *same field* edited on two devices with overlapping intent where the loser's value is dropped — raises a banner rather than vanishing:

- The sync response includes, per op, `dropped: string[]` (fields whose value lost to a newer `field_ts`). If a dropped field's value differs from what the user still sees locally, the store pushes a toast/banner ("Your change to *title* was superseded by another device") via the existing `showToast`/toast signal in `stores/index.ts`, offering "keep mine" (re-enqueue as a fresh op with `now()` stamp) or "dismiss".
- Completion is **never** surfaced as a lost-write conflict — by §4 it cannot lose — so the banner is reserved for real, user-visible divergence, not for the case the spec exists to prevent.

## Tests
- **Offline replay (`oplog.test.ts`, client):** create + edit + complete a task while `fetch` is stubbed to reject; assert 3 ops persist in IndexedDB; restore network, `flush()`; all three land server-side and the ops store drains.
- **Field-level convergence (server `apply.test.ts`):** start from `version:1`; apply op A `{title:'X'}` and op B `{notes:'Y'}` with interleaved/equal stamps → final row has **both** `X` and `Y`, `version:3`, neither dropped.
- **Monotonic completion (the headline test):** task is `done`; apply a concurrent non-completion op `{title:'renamed'}` carrying no `status` → row stays `status:'done'`, `completed_at` unchanged, title updated. Then the reverse order (rename op applied *after* a completion op with an older base) → still `done`. **No completion is ever lost.**
- **Same-field LWW + conflict surface:** two ops both set `title` with different stamps → newer wins, response reports the older as `dropped`, banner test asserts a toast fires.
- **SSE catch-up (server + client):** open stream, disconnect, mutate via another client, reconnect with `Last-Event-ID: <seq>` → exactly the missed events replay in order, no duplicates, then live resumes.
- **Standing suites:** existing Vitest + container Playwright stay green; B0 owner-isolation holds (a second owner's `sync_events` never reach owner 1's stream).

## Acceptance criteria
1. Edits made offline appear on the server after reconnect with **no data loss**; the op-log drains to empty.
2. Two devices editing **different fields** of one task converge with both edits intact (field-level merge, not whole-record LWW).
3. A completion is **never** silently undone by a concurrent non-completion edit — proven by test, in both apply orders.
4. SSE catch-up replays exactly the events missed during a disconnect, exactly once, in order; live streaming resumes after.
5. Genuine same-field conflicts surface a banner; completions never do.
6. All sync state is owner-scoped via `currentOwnerId()`; all new columns/tables ship as numbered B0 migrations (no `setup.ts`); timestamps are UTC ISO text.

## Risks / notes
- **Device clocks are unreliable.** `clientTs` is a *tiebreak* for same-field LWW, never authoritative; correctness (completion monotonicity, version ordering) rests on server state and per-record `version`, not on trusting client time. A wildly skewed clock can only mis-order *same-field* writes, never resurrect a completion.
- **uuidv7 op ids** give causal-ish ordering and double as idempotency keys, so a retried flush after a dropped ack can't double-apply.
- **Temp-id rewrite is the fiddly bit.** Offline-created entities use negative ids until first apply; the id-map must rewrite every *queued* op referencing them (and any optimistic UI state) atomically, or a follow-up edit targets a non-existent row.
- **Unbounded catch-up.** A device offline for weeks shouldn't replay thousands of events — cap the `sync_events` replay window and fall back to a full resync signal. Prune `sync_events` on a bounded retention (cron, owner-scoped) so the table doesn't grow forever.
- **`notes`/`description` are whole-field LWW**, so two devices typing into the same long field still lose one side's text (surfaced as a conflict, not merged). Character-level merge is a deliberate non-goal.
- **Depends on I being real:** before I, `ownerId` is the single-owner sentinel and "multi-device" is multiple browsers as one owner — fine for testing, but the isolation guarantees only matter once tokens resolve distinct owners.

## Effort
**L** — the schema/version/merge core is modest, but the op-log durability, temp-id rewrite, replay-on-reconnect choreography, SSE catch-up with `Last-Event-ID`, and the conflict UI together make this a large, test-heavy phase. Budget meaningful time for the cross-device integration tests, which are the only way to trust the monotonic-completion guarantee.

## Suggested PR breakdown
1. **Server versioning + field-level apply** (no client change): migrations for `version`/`updated_at`/`field_ts`, `sync/apply.ts`, `POST /api/sync`, `applyMonotonic`. Ship with `apply.test.ts` covering field merge + monotonic completion. Existing PATCH routes delegate to the same apply path so online edits get versioned too.
2. **SSE catch-up:** `sync_events` table + log-on-broadcast, `Last-Event-ID` replay in `routes/sse.ts`, client cursor handling + flush-before-trust in `lib/sse.ts`. Catch-up test.
3. **Client op-log + optimistic writes:** `lib/oplog.ts` (IndexedDB), `stores/mutations.ts`, wrap `api` mutations, replay-on-reconnect, temp-id rewrite. Offline-replay test.
4. **Conflict surfacing:** `dropped` in the sync response, banner/toast wiring, keep-mine re-enqueue. Conflict test.

Sequencing 1→2→3→4 keeps each diff reviewable: the server can be correct and versioned before any client behavior changes, and the offline UX lands last on a proven apply path.
