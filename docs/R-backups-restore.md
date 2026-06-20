# R — Backups, restore & export/import (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **B0** (migration runner + `lib/context.ts` owner scoping) and precedes the Multi-User & Cloud track (I/J/K/L) — recoverability and an audit foundation must exist before auth and multi-device land.

## Goal
1. **Durability for hardware we sell.** Scheduled SQLite snapshots and/or **Litestream** continuous replication of the single DB file, plus a **one-command restore** that yields a byte-identical database.
2. **Portability for "UnCloud Your Life."** Owner-scoped `GET /api/export` (full JSON) and `POST /api/import` (validated, owner-scoped), surfaced in a Settings "Back up / restore / export" panel.
3. **An audit foundation.** An append-only `audit_log` that every mutating route writes to — lightweight now, load-bearing before auth/multi-device (I/L).

## Non-goals
- **No off-host backup transport.** No S3/B2/cloud target wiring; Litestream's replica path is a local dir or a generic-storage URL configured by ops. The cloud-sync of replicas is the operator's job.
- **No cross-owner export.** Export/import are always scoped to `currentOwnerId()`; no admin "export everything" path until Phase I gives us a real multi-owner identity.
- **No point-in-time UI.** Restore is a documented CLI/ops operation, not an in-app "restore to 3pm Tuesday" button. The app exposes *export/import*, not snapshot rollback.
- **No schema migration on import.** Import targets the **current** schema version; importing an older export is out of scope (note it; don't build it).

## Current state (what exists today)
- **Single DB file at `DB_PATH`.** `server/src/lib/config.ts` resolves `config.dbPath` from `process.env.DB_PATH` (Docker sets `/data/companion.db`; local dev falls back to `~/Library/Application Support/CompanionPlanning/companion.db`) and `mkdirSync(dirname(dbPath), { recursive: true })` ensures the dir exists. `Dockerfile` sets `DB_PATH=/data/companion.db` and `mkdir -p /data`.
- **WAL is on.** `server/src/db/setup.ts` `runSetup()` runs `PRAGMA journal_mode = WAL` and `foreign_keys = ON` before creating tables. `server/src/db/index.ts` opens one `BetterSqlite3(config.dbPath)` handle and wraps it in Drizzle. (B0 moves this to `runMigrations`.)
- **No backup, no replication, no audit.** Nothing snapshots the DB; Litestream replication and the "never Syncthing the `.db`" rule are sketched only as future work (this phase). There is no `audit_log` table and no `/api/export` or `/api/import`.
- **Mutating routes don't record anything.** Every write goes straight through Drizzle and then `broadcast(...)` (e.g. `server/src/routes/tasks.ts`: `broadcast('task:created', out)` after `db.insert(tasks)`). Mutating routers today: `tasks.ts`, `blocks.ts`, `possibles.ts`, `tags.ts`, `prefs.ts`, `schedule.ts`, `jobs.ts`, `summary.ts`. (B0 changes `broadcast` to `broadcast(ownerId, event, data)`.)
- **Settings panel** does not exist on the client; prefs are edited via `routes/prefs.ts` only.

## Design

### 1. Snapshot + Litestream replication (never a naive file copy)
A live WAL-mode DB has uncheckpointed pages in `-wal`; copying `companion.db` alone yields a torn snapshot. Use the **SQLite online-backup API** (consistent across a live writer) or `VACUUM INTO` — never `fs.copyFile`.

```ts
// server/src/lib/backup.ts
import BetterSqlite3 from 'better-sqlite3';
import { config } from './config.js';

/** Consistent, checkpoint-correct snapshot of the live DB to `dest`. */
export async function snapshot(dest: string): Promise<void> {
  const src = new BetterSqlite3(config.dbPath, { readonly: true });
  try {
    await src.backup(dest);          // better-sqlite3 online-backup API; safe with a live writer
  } finally {
    src.close();
  }
  // `dest` is a single self-contained file (no -wal/-shm to ship alongside).
}
```

- **Scheduled snapshots:** a croner job (alongside the existing `scheduled_jobs`) calls `snapshot()` to `${dirname(DB_PATH)}/backups/companion-<utc-iso>.db`, retaining the last N. `VACUUM INTO 'dest'` is the equivalent one-liner if we prefer a compacted copy.
- **Litestream (continuous, recommended for Core Server):** ops-managed sidecar/service replicating `DB_PATH` to a local replica dir or generic-storage URL. Document config in `ops/litestream.yml`; Litestream owns its own checkpointing — the app does nothing special beyond keeping WAL on (already true).
- **The rule (documented in README + Settings panel):** *replicate the `.db`, never Syncthing the `.db` file.* Syncthing covers `.md`/exports only; concurrent block-level sync of a live SQLite file corrupts it. This is a hard warning, not a suggestion.

### 2. Restore (one command, byte-identical)
Restore is an **offline** operation: stop the server, replace the file, restart. No in-process restore endpoint (a running writer holding the handle makes atomic swap unsafe).

```sh
# from a snapshot
cp backups/companion-<utc-iso>.db "$DB_PATH"     # snapshot files are self-contained
# from Litestream
litestream restore -o "$DB_PATH" <replica-url>
```

- A thin `pnpm restore <source>` script (`server/src/scripts/restore.ts`) refuses to run if the server holds the DB (checks for a live lock), copies the source onto `DB_PATH`, then runs `runMigrations()` (B0) so a restored older DB lands on the current schema.
- **Byte-identical guarantee** holds because the snapshot was taken via the backup API (fully checkpointed, no dangling `-wal`); restoring it and reopening produces the same page content.

### 3. Export / import API (owner-scoped JSON)
A full, owner-scoped JSON dump and its inverse. Both resolve the owner via `currentOwnerId()` (B0) — never a query param.

```ts
// server/src/routes/backup.ts  (mounted in routes/index.ts)
// GET /api/export  → { version, exported_at, owner_id, tasks, time_blocks, tags, task_tags,
//                      possible_tasks, scheduling_prefs, daily_summaries, ... } (snake_case via toApi)
router.get('/api/export', async (ctx) => {
  const ownerId = currentOwnerId();
  ctx.body = buildExport(ownerId);                 // owner-scoped SELECTs across owned tables
  ctx.set('Content-Disposition', `attachment; filename="companion-export-${ownerId}.json"`);
});

// POST /api/import  → validated, owner-scoped, transactional
router.post('/api/import', async (ctx) => {
  const ownerId = currentOwnerId();
  const parsed = ImportSchema.safeParse(ctx.request.body);     // zod/manual validate shape + version
  if (!parsed.success) ctx.throw(400, 'malformed export');
  if (parsed.data.owner_id !== ownerId) ctx.throw(403, 'foreign-owner data');  // reject cross-owner
  const result = sqlite.transaction(() => importOwnerData(ownerId, parsed.data))();
  writeAudit({ ownerId, actor: 'owner', action: 'import', entity: `tasks:${result.tasks}` });
  broadcast(ownerId, 'data:imported', result);     // B0 owner-scoped broadcast
  ctx.body = result;
});
```

- **Stable ids round-trip.** Export carries each row's integer PK; import inserts with explicit ids (`INSERT … (id, …)`) into an empty owner partition so `export → wipe-owner → import` reproduces the same ids. FK-bearing tables (`task_tags`, `time_blocks.task_id`, `possible_tasks.promoted_task_id`) import in dependency order inside the one transaction.
- **Validation** rejects malformed JSON, missing `version`, wrong-type fields, and any `owner_id` that isn't the caller's. Import is **all-or-nothing** (single `sqlite.transaction`).
- **Mode:** default is replace-owner-partition (delete the caller's owned rows, then insert) so import is idempotent; a `?mode=merge` variant is out of scope for R.

### 4. The `audit_log` (append-only; new migration via the B0 runner)
A new numbered migration through the B0 runner — **never** an ad-hoc `CREATE TABLE IF NOT EXISTS` in `setup.ts`.

```ts
// server/src/db/migrations/0007_audit_log.ts   (next free number at build time)
export const id = '0007_audit_log';
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id  INTEGER NOT NULL REFERENCES owners(id),
      actor     TEXT NOT NULL,            -- 'owner' | 'system' | 'agent'
      action    TEXT NOT NULL,            -- 'create' | 'update' | 'delete' | 'import' | ...
      entity    TEXT NOT NULL,            -- 'task:42' | 'block:9' | 'import' | ...
      at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))  -- UTC ISO text
    );
    CREATE INDEX IF NOT EXISTS idx_audit_owner_at ON audit_log(owner_id, at);
  `);
}
```

- **Append-only by convention** (no UPDATE/DELETE routes; ids monotonic). Add the matching Drizzle table to `db/schema.ts`.
- A tiny helper every mutating route calls **after** its write succeeds:

```ts
// server/src/lib/audit.ts
export function writeAudit(e: { ownerId: number; actor: string; action: string; entity: string }): void {
  sqlite.prepare(
    `INSERT INTO audit_log (owner_id, actor, action, entity) VALUES (@ownerId, @actor, @action, @entity)`
  ).run(e);   // `at` defaults to UTC ISO via the column default
}
```

- **Every mutating route writes one row.** Wire `writeAudit(...)` next to each existing `broadcast(...)` callsite in `tasks.ts`, `blocks.ts`, `possibles.ts`, `tags.ts`, `prefs.ts`, `schedule.ts`, `jobs.ts`, `summary.ts`. `actor` is `'owner'` for request-driven writes, `'system'` for cron-job writes (which already run inside `runWithOwner(SYSTEM_OWNER, …)` per B0). A CI grep gate asserts no mutating handler ships without an `writeAudit`.

## Tests
- **`backup.test.ts` — snapshot → wipe → restore is byte-identical.** Seed a DB, `snapshot()` it, wipe/replace the original, restore, reopen → every owned row equals the original; a content hash of `SELECT *` across tables matches. Covers a snapshot taken while a writer is mid-transaction (no torn `-wal`).
- **`export-import.test.ts` — round-trip with stable ids.** `GET /api/export` → wipe owner partition → `POST /api/import` → re-export → deep-equal, **including integer PKs** and FK links (`task_tags`, `time_blocks.task_id`).
- **Import rejects bad input.** Malformed JSON / missing `version` → 400; an export whose `owner_id` ≠ caller → 403; partial-failure payload leaves the DB unchanged (transaction rollback verified).
- **`audit.test.ts` — every mutation logs.** Each mutating route (create/update/delete a task, move a block, edit prefs, import) writes exactly one `audit_log` row with the right `owner_id`/`actor`/`action`/`entity`; `at` is UTC ISO (`…Z`).
- **Owner isolation.** Owner B's `audit_log` and export never include owner A's rows (uses the B0 single-owner context flipped to a second test owner).
- **Standing suites** (Vitest + container Playwright) stay green; snapshot/restore scripts run headless in CI against a fixture DB.

## Acceptance criteria
1. A restored DB is **indistinguishable** from the original (byte/content-hash equal), produced via the backup API or `VACUUM INTO` — not a raw file copy.
2. Litestream (or scheduled snapshots) replicates `DB_PATH`; restore is a documented **one command**; README + Settings panel both state "replicate the `.db`, never Syncthing it."
3. `GET /api/export` / `POST /api/import` are **lossless, owner-scoped, stable-id**; import is transactional and rejects malformed or foreign-owner data.
4. A Settings "Back up / restore / export" panel triggers export download, import upload, and shows backup status.
5. `audit_log` exists via a **numbered B0 migration**; **every** mutating route writes an audit row (grep gate green).

## Risks / notes
- **Naive copy = corruption.** A plain `cp companion.db` during a write loses uncheckpointed WAL pages. The backup API / `VACUUM INTO` is mandatory; encode it in code, not docs.
- **Syncthing + live `.db` = corruption.** Block-level sync of an open SQLite file is the classic foot-gun. Repeat the warning in README, Settings, and `ops/litestream.yml` comments.
- **Import id collisions.** Re-importing into a non-empty owner partition collides on explicit PKs — hence replace-owner-partition default; document that merge mode is deferred.
- **Export size.** Full JSON is fine at single-user scale; if `daily_summaries`/`audit_log` grow large, stream the response rather than buffering. Audit rows are the fastest-growing table — fine for R, but Phase I should add a retention/rotation policy.
- **Restore must re-migrate.** A restored older snapshot has to pass through `runMigrations()` (B0) before serving, or the schema won't match the running code.

## Effort
**S–M** — roughly 3–4 days. Snapshot/restore + the `audit_log` migration and `writeAudit` sweep are small and mechanical; the export/import round-trip (stable ids, FK ordering, validation) and the Settings panel are the bulk.

## Suggested PR breakdown
1. **Audit foundation:** `0007_audit_log` migration + Drizzle table, `lib/audit.ts`, wire `writeAudit` into every mutating route, grep gate + `audit.test.ts`. (No user-visible change; lands first because I/L depend on it.)
2. **Snapshot + restore:** `lib/backup.ts` (online-backup API), scheduled-snapshot job, `pnpm restore` script, README/ops Litestream docs + the Syncthing rule, `backup.test.ts`.
3. **Export/import + Settings panel:** `routes/backup.ts` (`/api/export`, `/api/import`), validation, `export-import.test.ts`, and the SolidJS "Back up / restore / export" panel.

Three small diffs keep the audit sweep (touches many files) separate from the new endpoints, and the client panel separate from the server contract.
