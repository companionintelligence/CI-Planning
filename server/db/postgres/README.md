# Postgres port (`planning` schema)

CI-Planning's store is moving from SQLite (better-sqlite3 + Drizzle) to Postgres with
the stack CI-Server uses: **TypeORM entities + dbmate raw-SQL migrations + pgvector**.
Koa stays; this is a database refactor, not an application rewrite.

**This is the foundation, not the finished migration, and it is not a supported
deployment option.** The app runs on SQLite. Postgres is opt-in through `DATABASE_URL`
and `STORE_BACKEND` (`server/src/lib/config.ts`), and the compose service sits behind
`--profile postgres`. The schema, the connection layer, the ORM and the store facade are in
place, and Pass A (every `server/src` statement moved behind the facade) is done. The
Postgres schema itself has not followed SQLite since 2026-08-02: it lacks migrations
0148–0172, and the cutover has not happened. See [What remains](#what-remains).

## Layout

| Path | What |
|---|---|
| `db/postgres/migrations/` | dbmate migrations (`-- migrate:up` / `-- migrate:down`), CI-Server's format |
| `src/db/pg.ts` | Postgres access layer shaped like the better-sqlite3 handle it replaces |
| `src/db/migrate-pg.ts` | dbmate-compatible migration runner; `src/boot.ts` runs it at start-up when `DATABASE_URL` is set |
| `src/db/store.ts` | The async data facade both backends implement; `STORE_BACKEND` picks one |
| `src/db/datasource.ts` | TypeORM DataSource (`synchronize: false` — dbmate owns DDL) |
| `src/db/entities/` | 56 generated entities, one per table of the 2026-08-02 baseline |
| `test/pg-*.test.ts`, `test/store-conformance.test.ts` | The Postgres suites; they skip without `PG_TEST_URL` |

## Where the data lives

`planning` is a **schema**, not a database, so it sits beside CI-Server's `ci.*` in one
database. Cross-schema reads and FKs into `ci.*` are therefore available later without
another migration — but `owners` stays CI-Planning's own tenant table, still linked to
CI-Portal by `external_subject`. Identity is deliberately **not** merged into `ci.users`;
that would re-key every tenant-scoped table and change what the `SYSTEM_OWNER` sentinel
and OIDC auto-provisioning mean. Each repo keeps its own migration history.

## Running it

```bash
docker compose --profile postgres up -d postgres
```

The service is behind the `postgres` profile, so a plain `docker compose up` never starts
it, and it needs `POSTGRES_PASSWORD` in `.env`. It publishes no host port: uncomment
`ports:` on the `postgres` service in `docker-compose.yml` to reach it from the host, which
the commands below assume.

With `DATABASE_URL` set the app applies the migrations itself at boot (`src/boot.ts` →
`src/db/migrate-pg.ts`). To migrate ahead of a deploy instead, use
[dbmate](https://github.com/amacneil/dbmate), the same runner CI-Server uses; the boot-time
runner then finds nothing pending:

```bash
dbmate --migrations-dir server/db/postgres/migrations --url "$DATABASE_URL" up
```

`DATABASE_URL` unset ⇒ the app uses SQLite and touches no Postgres. `DATABASE_URL` set
migrates the `planning` schema at boot, but the app still reads and writes SQLite until
`STORE_BACKEND=postgres`, which is the cutover itself and is not safe yet (see
[What remains](#what-remains)). The two backends coexist on purpose so call sites could
move file by file rather than in one cutover.

## Schema decisions

The baseline collapses the first 147 SQLite migrations (`0001_baseline` …
`0147_ingest_windows`) into one file. This database is new — there is no history here to
replay, and 147 incremental steps would be 147 chances to diverge. The SQLite migrations
stay as the historical record for the old store.

**The baseline has not been regenerated since.** SQLite is at `0172_signup_codes`
(168 registered migrations at `3cfbbdf2`), and nothing from `0148` on is in `planning`:
18 tables (`classification_log`, `classification_exemplars`, `classification_accuracy`,
`people`, `person_emails`, `entity_people`, `possible_task_people`, `possible_outcome_log`,
`possible_dismissal_exemplars`, `possible_dismissal_rate`, `plan_loop_runs`,
`plan_revision_log`, `plan_loop_stats`, `balance_week_log`, `placement_log`,
`placement_preferences`, `placement_survival`, `signup_codes`) and the columns added to
existing ones. Two entities have been edited ahead of the SQL and now name columns the
baseline does not create — `tasks.completion_score` (the baseline still has
`completion_mood`) and `scheduling_prefs.balance_bias_enabled` — so
`test/pg-entities.test.ts` would fail against it if it ran. It is skipped without
`PG_TEST_URL`, which is why nothing has noticed. Catching up means new dbmate migrations
(or a re-cut baseline) plus regenerated entities.

**Types are ported conservatively, and that is deliberate:**

| SQLite | Postgres | Why not the "better" type |
|---|---|---|
| `TEXT` | `TEXT` | The app compares ISO timestamps **as strings** throughout (`completed_at > ?`, `start < from`) and `JSON.parse`s its own TEXT blobs. `timestamptz`/`jsonb` would return `Date` and object values and break the ~55k lines of `server/src` (and the tests) that treat them as strings. |
| `INTEGER` | `INTEGER` | 0/1 flags are written `x ? 1 : 0` and read `!!row.x`. `BOOLEAN` rejects the integer literal on write at every one of those sites. |
| `REAL` | `DOUBLE PRECISION` | — |

Retyping to `timestamptz`/`jsonb`/`boolean` is a worthwhile follow-up, but it is a
behavioural change to thousands of call sites and belongs in its own PR with its own
tests — not smuggled into a store swap.

Defaults reproduce SQLite's **exact byte format**, not merely its meaning:
`CURRENT_TIMESTAMP` yields `YYYY-MM-DD HH:MM:SS` (UTC, no zone marker), which
`lib/tz.ts`'s `sqliteUtcToISO` parses by shape. Both spellings were verified
byte-identical against SQLite.

`uuid7()` is a **database function** (`20260802000300`) because raw-SQL inserts mint their
ids with `VALUES (uuid7(), …)` (41 mentions across 25 files of `server/src` at
`3cfbbdf2`). Time-ordering is load-bearing — dedupe and the flight plan rely on
`ORDER BY id` being chronological. It matches the JS `newId()` exactly, including that
neither is strictly monotonic *within* a millisecond (both use a random tail).

pgvector replaces sqlite-vec. No column stores a vector: dedupe builds a **transient**
KNN index per run, so the extension must exist but the schema carries no `vector` type.

## Verified

When the baseline was cut (2026-08-02), against a real Postgres 17 + pgvector — these
results describe the 0147 schema, not today's SQLite one (see
[Schema decisions](#schema-decisions)), and were not re-run for this revision:

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

The schema was the small half. The dominant cost is that **better-sqlite3 is synchronous
and `pg` is not**: every call site becomes `await`, every enclosing function becomes
`async`, and that ripples through callers. That part is done for `server/src` (Pass A,
below). What is left is the dialect rewrites, the Drizzle call sites, the tests, catching
the Postgres schema up with SQLite, and the cutover itself.

Measured across `server/src` (excluding the SQLite migrations, comments stripped) at
`3cfbbdf2` on 2026-11-01, beside the figures from 2026-08-01 when this section was written:

| Work | Now | 2026-08-01 |
|---|---|---|
| Raw `sqlite.*` statements | **6** in 2 files (`agents/groom.ts`, the sqlite-vec residue; `db/index.ts`, the `vec_version()` probe) | **786** across **73 files** |
| Statements through the facade, `store().prepare/exec/transaction` | 1,042 across 116 files | — |
| Transaction blocks | 53 `store().transaction` | 43 `sqlite.transaction` |
| Drizzle query-builder calls (`db.select/insert/update/delete`), not behind the facade | 41 across 7 files | not counted |
| `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` | 43 | 43 |
| `INSERT OR REPLACE` → `ON CONFLICT … DO UPDATE` | 2 | 3 |
| `strftime(` → `to_char`/`date_trunc` | 20 | 20 |
| `julianday` / `datetime(` → interval arithmetic | 5 | 4 |
| `lastInsertRowid` → `RETURNING id` | 0 | 2 |
| Tests: raw `sqlite.*` calls | 2,049 across 223 of 283 files (62k lines in `server/test`) | ~1,150 across 183 of 224 files (~46k lines, 2604 tests) |

`RETURNING` (63 sites) and `ON CONFLICT` (31) already work in Postgres unchanged.

`src/db/pg.ts` exists to make that port mechanical rather than a redesign:

- **`?` placeholders are rewritten to `$1..$n`** (literal- and comment-aware), so SQL
  text does not change.
- **Transactions use AsyncLocalStorage**, so `pg.prepare` inside a transaction callback —
  even several calls deep — automatically uses that transaction's client. The existing
  transaction bodies keep their contents; only `sqlite.transaction(fn)()` →
  `await store().transaction(fn)` changes (53 call sites now).

A call site therefore ports as:

```ts
// before
const row = sqlite.prepare(`SELECT … WHERE owner_id = ?`).get(owner);
// after: through the facade, which runs on `pg.prepare` once STORE_BACKEND=postgres
const row = await store().prepare(`SELECT … WHERE owner_id = ?`).get(owner);
```

### Sequencing: the code ports file-by-file, the RUNTIME cutover cannot

An earlier draft of this file suggested shipping the port service by service. That is
wrong, and the schema says so: **42 of the baseline's 56 tables carry a foreign key to `owners`**, and
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
   when `DATABASE_URL` is set, and is inert without it (`src/boot.ts`).
2. ~~Flip the test harness to Postgres~~ — **superseded**. The harness is not the only
   coupling: the tests themselves hold **raw `sqlite.*` uses** (1,150 across 183 of 224
   files when this was written; 2,049 across 223 of 283 now), for setup and assertions.
   Flipping `helpers.ts` alone would leave those files reading a database the app no
   longer writes.

   Instead `src/db/store.ts` splits the work in two, so neither half is done blind:

   **Pass A — async migration, SQLite underneath.** Move all ~1,936 call sites (786 in
   src, ~1,150 in tests) to `await store.prepare(…)`. The store has not changed, so the
   suite stays GREEN at every commit and each file is independently reviewable.
   **Done for `server/src`** (#477, 2026-08-04, "Pass A complete"): the only raw
   `sqlite.*` statements left there are the two in the table above. The test files have not
   moved — they still set up and assert through `sqlite.*` directly.

   **Pass B — the cutover.** Set `STORE_BACKEND=postgres`. One change, and 2,600 tests
   immediately report every dialect difference (`INSERT OR IGNORE`, `strftime`, …).

   `test/store-conformance.test.ts` runs ONE suite against BOTH backends, pinning the
   semantics call sites actually depend on — `.get()` → `undefined` (not `null`) on a
   miss, `{ changes }` on a write, rollback discarding work, a nested failure not
   poisoning the outer transaction. Those are the ways the two could silently disagree
   and turn a green pass A into a broken pass B. (Verified it bites: injecting a
   `null`-on-miss divergence into the SQLite backend fails the suite.)
3. ~~Port call sites file-by-file, commit-by-commit, per pass A above.~~ Done for
   `server/src`. Leaf-first helped for review size; it was never shippable separately.

   **Pass A findings** (each one is a decision the mechanical edit would have got wrong):

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
   - **The statement count was undercounted at first.** `grep 'sqlite\.prepare'` misses
     the very common `sqlite\n  .prepare(` split across lines. The real figure is **786
     src statements, not 386** — a multi-line-aware count is the only trustworthy one.
   - **There are almost no leaves.** Picking files by statement count is the wrong
     heuristic. `services/category-prefs.ts` and `services/pattern-prefs.ts` look like
     leaves (3 exports, one visible statement each) but `getCategoryPrefs` /
     `getPatternPrefs` are read by the **autoplan engine**, so porting them drags in
     `engine/autoplan.ts`, `engine/review.ts`, `services/blocks.ts`, `jobs/index.ts` and
     four GraphQL resolver files. Sequence by TRANSITIVE CALLERS, not by file size, and
     expect the engine to be a hub that forces one large commit whenever it is reached.
   - **Scripted async-ification is not safe at this scale.** Automated edits produced
     `async if (…)`, `const x = async (expr)`, and a `flushAudits()` inserted inside a
     multi-line `return (…)`. Worse, an "await precedence" fixer rewrote
     `await this.session().listEvents(…)` into `(await this.session()).listEvents(…)` in
     `connectors/google.ts` — a file the batch never intended to touch, and a real
     semantic change (`session()` is synchronous; the promise comes from `listEvents`).
     TypeScript happened to catch each of these, but that is luck, not a guarantee.

     **Conclusion: do not script this.** Port per file, by hand, reading each call site,
     with the suite run after each file. The batch that produced the failures above was
     reverted wholesale rather than repaired.
   - `better-sqlite3`'s `.get()`/`.all()`/`.run()` need an explicit `unknown[]` binding
     generic to accept a variadic spread; the default overload infers a fixed-arity tuple
     and rejects the zero-parameter case.
   - `tsc` covers `src` only (`tsconfig.json` includes `src/**/*`), so test call sites are
     NOT typechecked. Vitest's oxc transform does reject `await` in a non-async function,
     which makes running the suite — not typechecking — the reliable signal for the test
     half of the cascade.
4. The dialect rewrites above, mechanically, plus the 41 Drizzle query-builder calls in 7
   files (`services/tasks.ts`, `services/blocks.ts`, `services/possibles.ts`,
   `services/prefs.ts`, `services/jobs.ts`, `routes/tasks.ts`, `routes/prefs.ts`), which
   bypass the facade and would still read SQLite after a `STORE_BACKEND=postgres` flip.
   Two known blockers sit in the schema: `sync_events.seq` is a bare `INTEGER PRIMARY KEY`
   in the baseline, which Postgres does not auto-assign (SQLite's rowid alias does), so
   every `sync_events` INSERT would fail NOT NULL — it needs
   `GENERATED BY DEFAULT AS IDENTITY`; and the baseline lacks SQLite migrations
   0148–0172 (see [Schema decisions](#schema-decisions)).
5. Delete `better-sqlite3`, `sqlite-vec`, Drizzle and the SQLite migrations in the
   same release as the cutover.
6. A one-shot data exporter for existing installs (SQLite → Postgres), which is what
   makes the single cutover safe for deployed users.
7. **Then** the type-tightening pass (`timestamptz`, `jsonb`, `boolean`), separately.

Data migration for existing installs is a separate task and is not covered here.
