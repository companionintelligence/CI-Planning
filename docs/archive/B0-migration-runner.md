# B0 — Migration runner + owner-scoped data model (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). This is the first phase after A and the foundation every later schema phase depends on. It adds **no authentication** — single-owner mode injects owner 1.

## Goal
1. A real, ordered, version-tracked **migration runner** (forward-only) that replaces the ad-hoc `CREATE TABLE IF NOT EXISTS` + try/catch `ALTER` approach and the cross-branch schema drift it causes.
2. An **owner-scoped data model** — request identity via `AsyncLocalStorage`, no hardcoded `ownerId = 1` in business logic, and owner-scoped SSE — so multi-tenant later is a flip, not a rewrite.

**Non-goals (deferred to Phase I):** tokens/JWT/JWKS, sessions, API keys, CSRF, login. The owner resolver returns `SYSTEM_OWNER` for now.

## Current state (what we replace)
- `server/src/db/setup.ts` → `runSetup(db)`: one `CREATE TABLE IF NOT EXISTS …` block, then `migrateColumns()` (best-effort `ALTER TABLE … ADD COLUMN` in try/catch), then `seedDefaults()`.
- No ordering, no applied-version record, no safe path for non-additive changes or data backfills.
- Symptom already in the tree: a comment in `setup.ts` asks contributors to keep the `daily_summaries` block "byte-identical across branches" — that's the absence of a migration runner showing through.
- `server/src/routes/sse.ts` → `broadcast()` writes to a global `Set<PassThrough>`; **every** client receives **every** event.
- Seven `ownerId = 1` / `?? 1` literals across `engine/scheduler.ts`, `routes/prefs.ts`, `routes/tasks.ts`, `routes/possibles.ts`.

## Design

### 1. Migration format — TypeScript, not raw SQL
SQLite needs data backfills and table-rebuilds that pure `.sql` files can't express cleanly, and we already mix JS into setup (e.g. `serverTimezone()`), so migrations are TS modules:

```ts
// server/src/db/migrations/0001_baseline.ts
import type { Database } from 'better-sqlite3';
export const id = '0001_baseline';
export function up(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS owners (...);  /* the current schema, verbatim */`);
}
```

- **Forward-only**, no `down()` (see Risks — reversibility is a lie on SQLite).
- Every historical migration is written **idempotently** (`IF NOT EXISTS`, addColumn-if-missing) so re-applying on an already-upgraded 0.2 DB is safe. This is what lets us adopt existing databases without a fragile detection step.
- Ordered by filename prefix; collected into one **explicit array** (no glob / dynamic import — order must be deterministic and bundler-safe):

```ts
// server/src/db/migrations/index.ts
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_seed_defaults.js';
// … append new migrations here, in order
export const MIGRATIONS = [m0001, m0002, /* … */] as const;
```

### 2. Tracking table + runner

```ts
// server/src/db/migrate.ts
import type { Database } from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index.js';
import { logger } from '../lib/logger.js';

export function runMigrations(db: Database): { applied: string[] } {
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checksum   TEXT
  );`);
  const done = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id)
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    const tx = db.transaction(() => {
      m.up(db);                                              // synchronous (better-sqlite3)
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
    });
    tx();
    applied.push(m.id);
    logger.info('migration applied', { id: m.id });
  }
  db.pragma(`user_version = ${MIGRATIONS.length}`);          // fast cross-check
  return { applied };
}
```

- Each migration runs in **its own transaction**; a failure aborts that migration only and leaves earlier ones applied (resumable).
- `PRAGMA foreign_keys` stays ON normally; a migration doing a table-rebuild toggles it OFF inside its own body and restores it (see `rebuildTable` helper).

### 3. Baseline & adoption (the only tricky part)
`0001_baseline` emits the **current** schema with `IF NOT EXISTS`. Two cases:
- **Fresh DB:** tables created, `0001` recorded. Clean.
- **Existing 0.2 DB (tables already present, no `schema_migrations`):** `0001.up` is a no-op (everything `IF NOT EXISTS`), and we record `0001` (+ every later idempotent migration whose change is already present) as applied. Because each historical migration is idempotent, simply running the loop on a populated DB is safe and self-adopting — no column-detection heuristics required.

Fold the existing `migrateColumns()` ALTERs and `seedDefaults()` into numbered migrations (`0001` baseline schema, `0002` seed owner + jobs via `INSERT OR IGNORE`, plus the historical `addCol` calls as their own idempotent migrations). Delete `setup.ts` once `db/index.ts` calls `runMigrations`.

### 4. Wire-in
- `server/src/db/index.ts`: replace `runSetup(sqlite)` with `runMigrations(sqlite)`.
- `pnpm migrate`: a thin script (`server/src/scripts/migrate.ts`) that opens the DB and runs the runner — for ops/CI without booting the server. Add to `package.json`.

### 5. Owner scoping
```ts
// server/src/lib/context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
export interface RequestContext { ownerId: number; }
const als = new AsyncLocalStorage<RequestContext>();
export const SYSTEM_OWNER = 1;
export const runWithOwner = <T>(ownerId: number, fn: () => T): T => als.run({ ownerId }, fn);
export const currentOwnerId = (): number => als.getStore()?.ownerId ?? SYSTEM_OWNER;
```
- **`requireOwner` Koa middleware:** resolves the owner (single-owner → `SYSTEM_OWNER`; Phase I swaps in a verified-token resolver) and wraps the downstream handler in `runWithOwner`. Mount before the routers in `app.ts`.
- **Cron jobs** run their bodies inside `runWithOwner(SYSTEM_OWNER, …)`.
- Replace the 7 literals with `currentOwnerId()`. Leave the value in seeds/migrations/`SYSTEM_OWNER` as-is.

### 6. Owner-scoped SSE
```ts
// routes/sse.ts
const clients = new Map<PassThrough, number>();           // stream -> ownerId
export function broadcast(ownerId: number, event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [c, owner] of clients) if (owner === ownerId) c.write(msg);
}
```
- The `/api/events` handler captures `currentOwnerId()` at connect and registers `clients.set(stream, ownerId)`.
- Every `broadcast(...)` callsite (tasks, blocks, possibles, schedule, jobs) passes the affected owner. System/cron events target the owner(s) they affect.

### 7. `rebuildTable` helper (for non-additive changes later)
SQLite can't drop/rename/retype a column in place pre-3.35 and only partially after. Provide one helper now so future migrations don't reinvent the 12-step dance:
```ts
export function rebuildTable(db, { table, createNewSql, columns /* shared old→new */ }) {
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(createNewSql);                                 // <table>_new
    db.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table};`);
    db.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
    // recreate indexes/triggers here
  });
  tx();
  db.pragma('foreign_keys = ON');
}
```

## Tests
- **`migrate.test.ts`**
  - Fresh DB → all migrations apply; `schema_migrations` has N rows; `user_version === N`.
  - **Re-run is a no-op** (`applied` empty; row counts unchanged).
  - **Upgrade:** build a fixture "0.2-shaped" DB (tables + sample rows, no `schema_migrations`) → runner adopts it, **preserves every row**, marks migrations applied, idempotent on a second run.
  - Each table-rebuild migration: row count + a sampled key→value preserved across the rebuild.
- **`context.test.ts`:** `currentOwnerId()` returns the ALS owner inside `runWithOwner`, `SYSTEM_OWNER` outside.
- **SSE isolation:** two streams registered with different owners; `broadcast(ownerA, …)` is received by A, **not** by B.
- **Grep gate (CI):** no `owner_id = 1` / `ownerId, 1` / `?? 1` owner literal in `server/src/routes` or `server/src/engine` (allow `lib/context.ts`, `db/migrations`, seeds).
- **Standing suites:** full Vitest + container Playwright pass unchanged — the single-owner context makes them auth-free.

## Acceptance criteria
1. `pnpm migrate` is version-tracked and idempotent; **fresh install and upgrade-from-0.2 both boot with all data intact.**
2. Adding a column/table is a new migration file — no more hand-synced `CREATE IF NOT EXISTS` blocks or cross-branch "keep byte-identical" comments.
3. All business-logic owner reads/writes go through `currentOwnerId()`; grep gate green.
4. `broadcast` is owner-scoped with a passing isolation test.
5. Whole existing suite green; **zero auth surface added.**

## Risks / notes
- **SQLite ALTER is weak.** No real `DROP`/`RENAME COLUMN` before 3.35, and complex changes still need the table-rebuild dance — hence forward-only / expand-contract, and the `rebuildTable` helper. Do not promise reversible migrations.
- **better-sqlite3 is synchronous** — migration `up()` must be sync (no `await`). Fine; it's how the codebase already uses the driver.
- **Don't dynamic-import migrations** — keep the explicit ordered array so bundling and order are deterministic.
- **Checksum column** lets CI warn when a migration body changed after being applied (a footgun). Warn, don't hard-fail — the idempotent baseline adoption legitimately re-touches `0001`.
- **FK pragma** must be restored after any rebuild migration, or later inserts silently skip enforcement.

## Effort
**S** — roughly 2–3 days including tests and the owner-scoping sweep. Most of the work is the careful baseline-adoption migration and the SSE/owner refactor; the runner itself is ~40 lines.

## Suggested PR breakdown
1. **Runner + baseline migrations** (no behavior change): `migrate.ts`, `migrations/`, `pnpm migrate`, fold in `migrateColumns`/`seedDefaults`, swap `db/index.ts`. Ship with `migrate.test.ts`.
2. **Owner context + scoping:** `lib/context.ts`, `requireOwner`, replace the 7 literals, owner-scoped `broadcast`, isolation tests, grep gate.

Keeping them separate keeps each diff small and the regression net obvious.
