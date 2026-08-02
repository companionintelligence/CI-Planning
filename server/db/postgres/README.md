# Postgres port (`planning` schema)

CI-Planning's store is moving from SQLite (better-sqlite3 + Drizzle) to Postgres with
the stack CI-Server uses: **TypeORM entities + dbmate raw-SQL migrations + pgvector**.
Koa stays; this is a database refactor, not an application rewrite.

**This is the foundation, not the finished migration.** The schema, the connection
layer and the ORM are in place and verified; the ~46k LOC of call sites still run on
SQLite. See [What remains](#what-remains).

## Layout

| Path | What |
|---|---|
| `db/postgres/migrations/` | dbmate migrations (`-- migrate:up` / `-- migrate:down`), CI-Server's format |
| `src/db/pg.ts` | Postgres access layer shaped like the better-sqlite3 handle it replaces |
| `src/db/datasource.ts` | TypeORM DataSource (`synchronize: false` — dbmate owns DDL) |
| `src/db/entities/` | 56 generated entities, one per table |

## Where the data lives

`planning` is a **schema**, not a database, so it sits beside CI-Server's `ci.*` in one
database. Cross-schema reads and FKs into `ci.*` are therefore available later without
another migration — but `owners` stays CI-Planning's own tenant table, still linked to
CI-Portal by `external_subject`. Identity is deliberately **not** merged into `ci.users`;
that would re-key every tenant-scoped table and change what the `SYSTEM_OWNER` sentinel
and OIDC auto-provisioning mean. Each repo keeps its own migration history.

## Running it

```bash
docker compose up -d postgres
```

Then apply the migrations with [dbmate](https://github.com/amacneil/dbmate), the same
runner CI-Server uses:

```bash
dbmate --migrations-dir server/db/postgres/migrations --url "$DATABASE_URL" up
```

`DATABASE_URL` unset ⇒ the app still uses SQLite. The two backends coexist on purpose so
call sites can move file by file rather than in one cutover.

## Schema decisions

The baseline collapses all 147 SQLite migrations into one file. This database is new —
there is no history here to replay, and 147 incremental steps would be 147 chances to
diverge. The SQLite migrations stay as the historical record for the old store.

**Types are ported conservatively, and that is deliberate:**

| SQLite | Postgres | Why not the "better" type |
|---|---|---|
| `TEXT` | `TEXT` | The app compares ISO timestamps **as strings** throughout (`completed_at > ?`, `start < from`) and `JSON.parse`s its own TEXT blobs. `timestamptz`/`jsonb` would return `Date` and object values and break ~46k LOC that treats them as strings. |
| `INTEGER` | `INTEGER` | 0/1 flags are written `x ? 1 : 0` and read `!!row.x`. `BOOLEAN` rejects the integer literal on write at every one of those sites. |
| `REAL` | `DOUBLE PRECISION` | — |

Retyping to `timestamptz`/`jsonb`/`boolean` is a worthwhile follow-up, but it is a
behavioural change to thousands of call sites and belongs in its own PR with its own
tests — not smuggled into a store swap.

Defaults reproduce SQLite's **exact byte format**, not merely its meaning:
`CURRENT_TIMESTAMP` yields `YYYY-MM-DD HH:MM:SS` (UTC, no zone marker), which
`lib/tz.ts`'s `sqliteUtcToISO` parses by shape. Both spellings were verified
byte-identical against SQLite.

`uuid7()` is a **database function** (`20260802000300`) because 386 call sites say
`VALUES (uuid7(), …)`. Time-ordering is load-bearing — dedupe and the flight plan rely on
`ORDER BY id` being chronological. It matches the JS `newId()` exactly, including that
neither is strictly monotonic *within* a millisecond (both use a random tail).

pgvector replaces sqlite-vec. No column stores a vector: dedupe builds a **transient**
KNN index per run, so the extension must exist but the schema carries no `vector` type.

## Verified

Against a real Postgres 17 + pgvector:

- All four migrations apply cleanly from scratch.
- Structural parity with the SQLite source: **56 tables, 505 columns, 81 foreign keys,
  3 CHECK constraints, 135 indexes** (65 explicit + 14 unique + 56 primary keys).
- `get`/`all`/`run` keep better-sqlite3 semantics, including `.get()` → `undefined` on a
  miss and `{ changes }` on write.
- Transactions commit, roll back, and nest via SAVEPOINT (an inner failure does not
  poison the outer transaction).
- Foreign keys, CHECK constraints and partial unique indexes all enforce.
- All 56 entities map to tables and columns that exist (checked against
  `information_schema`, not just compiled).

```bash
docker run -d --name cip-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=planning \
  -p 55432:5432 pgvector/pgvector:pg17
PG_TEST_URL=postgres://postgres:pw@localhost:55432/planning pnpm --filter server test
```

The Postgres tests **skip** when `PG_TEST_URL` is unset, so the suite stays green
without a database — CI should set it.

## What remains

The schema was the small half. The application still talks to SQLite, and the dominant
cost is that **better-sqlite3 is synchronous and `pg` is not**: every call site becomes
`await`, every enclosing function becomes `async`, and that ripples through callers.

Measured across `server/src` (excluding the superseded SQLite migrations):

| Work | Count |
|---|---|
| `sqlite.prepare` call sites | **386** across **74 files** |
| `sqlite.transaction` blocks | 43 |
| `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` | 43 |
| `INSERT OR REPLACE` → `ON CONFLICT … DO UPDATE` | 3 |
| `strftime(` → `to_char`/`date_trunc` | 20 |
| `julianday` / `datetime(` → interval arithmetic | 4 |
| `lastInsertRowid` → `RETURNING id` | 2 |
| Test suite touching the DB | ~46k LOC, 2604 tests |

`RETURNING` (52 sites) and `ON CONFLICT` (27) already work in Postgres unchanged.

`src/db/pg.ts` exists to make that port mechanical rather than a redesign:

- **`?` placeholders are rewritten to `$1..$n`** (literal- and comment-aware), so SQL
  text does not change.
- **Transactions use AsyncLocalStorage**, so `pg.prepare` inside a transaction callback —
  even several calls deep — automatically uses that transaction's client. The 43 existing
  transaction bodies keep their contents; only `sqlite.transaction(fn)()` →
  `await pg.transaction(fn)` changes.

A call site therefore ports as:

```ts
// before
const row = sqlite.prepare(`SELECT … WHERE owner_id = ?`).get(owner);
// after
const row = await pg.prepare(`SELECT … WHERE owner_id = ?`).get(owner);
```

### Sequencing: the code ports file-by-file, the RUNTIME cutover cannot

An earlier draft of this file suggested shipping the port service by service. That is
wrong, and the schema says so: **42 of 56 tables carry a foreign key to `owners`**, and
only two (`app_config`, `auth_states`) have no foreign key in either direction. A row
written to Postgres cannot reference an owner that still lives in SQLite, so the data
cannot straddle both stores — which means there is no useful intermediate release where
some services read Postgres and the rest read SQLite.

```sql
-- 42 of 56
SELECT count(DISTINCT tc.table_name) FROM information_schema.table_constraints tc
JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
WHERE tc.table_schema='planning' AND tc.constraint_type='FOREIGN KEY' AND ccu.table_name='owners';
```

So the shape is: **port file-by-file in ONE branch, cut over in ONE release.**

1. ~~Boot + migrations~~ — done: the app runs dbmate-compatible migrations at startup
   when `DATABASE_URL` is set, and is inert without it.
2. ~~Flip the test harness to Postgres~~ — **superseded**. The harness is not the only
   coupling: the tests themselves hold **1,150 raw `sqlite.*` uses across 183 of 224
   files**, for setup and assertions. Flipping `helpers.ts` alone would leave those
   files reading a database the app no longer writes.

   Instead `src/db/store.ts` splits the work in two, so neither half is done blind:

   **Pass A — async migration, SQLite underneath.** Move all ~1,536 call sites (386 in
   src, 1,150 in tests) to `await store.prepare(…)`. The store has not changed, so the
   suite stays GREEN at every commit and each file is independently reviewable.

   **Pass B — the cutover.** Set `STORE_BACKEND=postgres`. One change, and 2,600 tests
   immediately report every dialect difference (`INSERT OR IGNORE`, `strftime`, …).

   `test/store-conformance.test.ts` runs ONE suite against BOTH backends, pinning the
   semantics call sites actually depend on — `.get()` → `undefined` (not `null`) on a
   miss, `{ changes }` on a write, rollback discarding work, a nested failure not
   poisoning the outer transaction. Those are the ways the two could silently disagree
   and turn a green pass A into a broken pass B. (Verified it bites: injecting a
   `null`-on-miss divergence into the SQLite backend fails the suite.)
3. Port call sites file-by-file, commit-by-commit, per pass A above. Leaf-first still
   helps for review size; it just is not shippable separately.

   **Pass A findings so far** (each one is a decision the mechanical edit would have
   got wrong):

   - `writeAudit` **stays** fire-and-forget, with an explicit `flushAudits()` for readers.
     Awaiting it at all 125 sites was tried and reverted: it turns 125 edits into ~59
     service functions becoming async, cascading to ~300 caller sites — the whole service
     and resolver layer async-ified in one unreviewable commit. It is not justified,
     because `audit_log` is **write-only in production** (the only readers are the backup
     export, owner deletion, and tests). The 29 assertions that read it right after the
     mutation call `await flushAudits()` first, which restores the ordering the
     synchronous SQLite write used to give for free. 29 test edits instead of ~300.
   - The facade's SQLite backend is installed by `src/db/index.ts` on import, NOT only by
     boot.ts or the test harness. Many test files import a service directly and load
     neither, and would otherwise hit "store not initialised" — a module-ordering trap
     rather than a real error.
   - **Scripted async-ification is not safe at this scale.** Automated edits produced
     `async if (…)`, `const x = async (expr)`, and a `flushAudits()` inserted inside a
     multi-line `return (…)`. TypeScript caught those three, but the class of mistake is
     one that can also typecheck — prefer per-file edits verified by the suite.
   - `better-sqlite3`'s `.get()`/`.all()`/`.run()` need an explicit `unknown[]` binding
     generic to accept a variadic spread; the default overload infers a fixed-arity tuple
     and rejects the zero-parameter case.
   - `tsc` covers `src` only (`tsconfig.json` includes `src/**/*`), so test call sites are
     NOT typechecked. Vitest's oxc transform does reject `await` in a non-async function,
     which makes running the suite — not typechecking — the reliable signal for the test
     half of the cascade.
4. The dialect rewrites above, mechanically.
5. Delete `better-sqlite3`, `sqlite-vec`, Drizzle and the 147 SQLite migrations in the
   same release as the cutover.
6. A one-shot data exporter for existing installs (SQLite → Postgres), which is what
   makes the single cutover safe for deployed users.
7. **Then** the type-tightening pass (`timestamptz`, `jsonb`, `boolean`), separately.

Data migration for existing installs is a separate task and is not covered here.
