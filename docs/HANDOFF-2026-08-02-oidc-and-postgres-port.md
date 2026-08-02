# Handoff — 2026-08-02 · OIDC hardening + the Postgres port

> ## Read this box first
>
> - **OIDC work is DONE and merged** — both repos. CI-Planning #455/#457, CI-Portal
>   #444/#447. Production SSO is no longer blocked: `CIPORTAL_CLIENT_ID` defaults to the
>   registered client `ci-planning`.
> - **Postgres port: the FOUNDATION is merged** (#458–#461). Schema, migration runner,
>   connection layer, ORM, and a backend-agnostic facade all exist and are verified
>   against a real Postgres 17.
> - **The app still runs on SQLite.** `DATABASE_URL` and `STORE_BACKEND` are opt-in and
>   inert by default. Nothing about the running system changed.
> - **Pass A (the call-site migration) is ~0.3% done** — 3 files of 101. The remaining
>   work is **2,592 statements across 299 files**, and §5 explains why it must be done by
>   hand.
> - **One PR open: #462** (writeAudit). Everything else is merged.
> - **My burn-down estimate was wrong twice, in the same direction.** See §4.1 before
>   trusting any number in an earlier commit message.

---

## 1. What shipped

### CI-Planning

| PR | What | State |
|---|---|---|
| #455 | Ingestion windows (`memory_window_days`, `email_lookback_days`), New Today precedence, `fill_order='new_today'`, CURRENT_TIMESTAMP parsing bug | merged |
| #457 | OIDC hardening: `aud` array + `azp`, `iat`/`nbf` + clock skew, discovery origin check, JWKS timeout, dead auth vars retired, `CIPORTAL_CLIENT_ID` default | merged |
| #458 | Postgres schema port — 4 dbmate migrations, 56 TypeORM entities, `pg.ts` | merged |
| #459 | Boot on Postgres — dbmate-compatible migration runner | merged |
| #460 | Backend-agnostic store facade + dual-backend conformance suite | merged |
| #461 | Pass A: auth credential path (`apiKey.ts`, `session.ts`) | merged |
| **#462** | **Pass A: `writeAudit` + pass-A findings** | **OPEN** |

### CI-Portal

| PR | What | State |
|---|---|---|
| #444 | Register `ci-planning` as a first-party public PKCE client | merged |
| #447 | Register the **memory-connector** callback path — #444 registered only sign-in, so a deployed Hub-tunnel install could log in but not connect Memory | merged |

---

## 2. OIDC — closed out

All five review findings are fixed and merged:

1. **JWKS fetch had no timeout** → `AbortSignal.timeout(5s)`, fail-closed (no keys ⇒ token
   rejected, never a skipped signature check).
2. **`aud` array + `azp`** → `aud` may be a string or array and must *contain* the
   client_id; multi-`aud` requires `azp` to name us. Without the `azp` check, a token
   minted for a *different* client at the same provider that merely lists us in `aud`
   would have verified and logged that user in.
3. **`iat`/`nbf` + clock skew** → all three temporal bounds enforced with 60s leeway.
4. **Discovery endpoints not origin-checked** → every URL from the document (including
   `issuer`) must sit on the origin we fetched from. Anchored on the *fetch* origin, not
   `doc.issuer`, which is provider-controlled and could be forged to match.
5. **Dead vars** → `AUTH_JWKS_URL` / `AUTH_ISSUER` / `AUTH_AUDIENCE` /
   `AUTH_CONTRACT_VERSION` removed. They were parsed into config and read by no code path
   — config that looks like a security control but enforces nothing.

Also fixed: the memory connector's subject binding was vacuous for local-login owners
(`external_subject` is NULL by construction). Now trust-on-first-use — the connection
records the `sub` it was made with and refuses a silent re-bind.

**Nothing OIDC-related is outstanding.**

---

## 3. Postgres port — what exists

Stack matches CI-Server: **TypeORM entities + dbmate raw-SQL migrations + pgvector**.
Koa stays. Tables live in a **`planning` schema** alongside `ci.*` in one database;
`owners` is deliberately NOT merged into `ci.users`.

```
server/db/postgres/migrations/   4 dbmate migrations (schema, pgvector, uuid7, baseline)
server/src/db/pg.ts              Postgres layer: ? → $n rewriting, ALS transactions
server/src/db/store.ts           backend-agnostic facade (THE migration seam)
server/src/db/datasource.ts      TypeORM DataSource, synchronize:false
server/src/db/entities/          56 generated entities
server/src/db/migrate-pg.ts      boot-time runner, dbmate-wire-compatible
```

Verified against real Postgres 17 + pgvector: 56 tables / 505 columns / 81 FKs / 135
indexes matching SQLite exactly; app boots, self-migrates, `/api/health` 200; restart
applies 0 migrations.

### 3.1 Read `server/db/postgres/README.md`

It carries the schema decisions (why types are ported conservatively, why the
`CURRENT_TIMESTAMP` byte format is preserved, why `uuid7()` is a DB function) and the
full findings list. **It is the primary reference — this handoff is the summary.**

---

## 4. Pass A — the call-site migration

The plan (from `store.ts`): move every call site to `await store.prepare(…)` **with
SQLite underneath** so the suite stays green, then flip `STORE_BACKEND=postgres` as one
change. The dual-backend conformance suite (`test/store-conformance.test.ts`) is what
makes that flip trustworthy — it pins `.get()` → `undefined` not `null`, `{ changes }`,
rollback, SAVEPOINT nesting. Verified it bites: injecting a `null`-on-miss divergence
fails it.

### 4.1 The real size — I under-reported twice

| Reported | Actual | Why it was wrong |
|---|---|---|
| 386 src statements | — | `grep 'sqlite.prepare'` misses `sqlite\n  .prepare(` |
| 786 src statements | — | file *selection* grep (`sqlite\.`) also missed multi-line |
| — | **914 src statements / 101 files** | multi-line-aware regex, files selected on the bare word `sqlite`, migrations excluded |
| ~1,150 test statements | **1,678 / 198 files** | same cause |
| ~1,936 total | **2,592 total across 299 files** | |

Reproduce:

```bash
python3 -c "
import re,subprocess,pathlib
fs=subprocess.run(['bash','-c','grep -rl sqlite --include=\"*.ts\" server/src --exclude-dir=migrations'],capture_output=True,text=True).stdout.split()
print(sum(len(re.findall(r'sqlite\s*\.\s*(?:prepare|exec|transaction)', pathlib.Path(f).read_text())) for f in fs))"
```

### 4.2 Done so far (3 files)

| File | Note |
|---|---|
| `lib/auth/apiKey.ts` | `issueApiKey`/`verifyApiKey` async; consumers already async |
| `lib/auth/session.ts` | `verifySession` etc. async; all 8 callers already async |
| `lib/audit.ts` | **stayed sync** — see §5.1 |

### 4.3 Biggest remaining files

```
60  services/tags.ts        31  services/patterns.ts       21  services/blocks.ts
48  services/objectives.ts  24  engine/auto-defense.ts     21  services/block-task-sync.ts
47  engine/autoplan.ts      22  agents/sync.ts
```

---

## 5. Findings — read before touching pass A

### 5.1 `writeAudit` stays fire-and-forget

Awaiting it at all 125 sites was tried and **reverted**: it turns into ~59 service
functions becoming async, cascading to ~300 caller sites — the whole service and
resolver layer in one unreviewable commit. Not justified, because **`audit_log` is
write-only in production** (only readers: backup export, owner deletion, tests).

Instead the promise is floated and `flushAudits()` restores ordering for the **29
assertions that read `audit_log` right after the mutation** — under Postgres those are a
real round trip and would race. 29 test edits instead of ~300 src edits.

### 5.2 There are almost no leaves

Sequencing by statement count is the **wrong heuristic**. `category-prefs.ts` and
`pattern-prefs.ts` look like leaves (3 exports, one visible statement) but
`getCategoryPrefs`/`getPatternPrefs` are read by the **autoplan engine** — porting them
pulled in `engine/autoplan.ts`, `engine/review.ts`, `services/blocks.ts`,
`jobs/index.ts` and four GraphQL resolvers, and was still growing when I stopped.

**Sequence by transitive callers.** Expect the engine to be a hub that forces one large
commit once reached.

### 5.3 Do NOT script the async migration

Demonstrated, not suspected. Across two attempts automation produced:

- `async if (…)` — control-flow keyword treated as a method
- `const x = async (expr)` — parenthesised expression treated as an arrow function
- `await flushAudits()` inserted inside a multi-line `return (…)`
- **`await this.session().listEvents(…)` → `(await this.session()).listEvents(…)`** in
  `connectors/google.ts` — a file the batch never intended to touch, and a genuine
  semantic change (`session()` is sync; the promise comes from `listEvents()`)

TypeScript caught each. **That is luck, not a guarantee** — the same class of edit can
typecheck cleanly and change behaviour silently. That batch was reverted wholesale.

### 5.4 `tsc` does not cover the tests

`tsconfig.json` includes `src/**/*` only. A test calling a now-async function silently
receives a Promise with no type error. Vitest's oxc transform *does* reject `await` in a
non-async function, so **running the suite — not typechecking — is the reliable signal**
for the test half of the cascade.

### 5.5 The facade must be installed at `db/index.ts`

Not only in `boot.ts`/the harness. Many tests import a service directly and load neither;
they hit `store not initialised` otherwise. `ingest-no-mirror.test.ts` failed exactly
that way.

---

## 6. Suggested next steps

1. **Merge #462.** Everything else is merged; it is the only thing outstanding.
2. **Decide whether to continue pass A at all** (§7).
3. If continuing: port **by hand, per file**, suite after each. Order by transitive
   callers — `services/tags.ts` (60 statements) is the biggest single file but is also
   depended on widely; a smaller true-leaf set is worth identifying first with a call
   graph rather than by grep count.
4. Flip `test/helpers.ts` `resetDb` to Postgres only **after** src is ported.
5. Then `STORE_BACKEND=postgres`, fix the dialect deltas the suite reports
   (43 `INSERT OR IGNORE`, 3 `INSERT OR REPLACE`, 20 `strftime`, 3 `julianday`,
   2 `lastInsertRowid`), and delete better-sqlite3 / sqlite-vec / Drizzle / the 147
   SQLite migrations in the cutover release.
6. Write a one-shot SQLite → Postgres data exporter — **not started**, and it is what
   makes the single cutover safe for deployed installs.
7. Only then consider type-tightening (`timestamptz`, `jsonb`, `boolean`).

---

## 7. Open questions for the owner

1. **Is pass A worth finishing?** 2,592 statements across 299 files, by hand, is a large
   multi-week effort with no user-visible benefit on its own. The foundation is merged
   and inert, so pausing costs nothing and leaves no half-migrated state. Worth an
   explicit decision rather than drift.
2. **Does the shared-database plan still hold?** The port assumes one Postgres with
   `planning.*` beside `ci.*`. Nothing yet reads across the boundary — if that
   integration is not actually coming, a separate database would be simpler.
3. **Type tightening**: the schema deliberately keeps `TEXT`/`INTEGER` rather than
   `timestamptz`/`jsonb`/`boolean`, which is a deviation from CI-Server's conventions.
   Fine as a port; needs a decision as a destination.
4. **Data migration owner** — nobody has written the exporter, and no deployed install
   can move without it.

---

## 8. Environment notes

- Postgres tests skip without `PG_TEST_URL`. CI should set it:
  ```bash
  docker run -d --name cip-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=planning \
    -p 55432:5432 pgvector/pgvector:pg17
  PG_TEST_URL=postgres://postgres:pw@localhost:55432/planning pnpm --filter server test
  ```
- Suite: **2633 without Postgres, 2665 with** — 32 tests are gated on `PG_TEST_URL`.
  (The conformance suite's 14 SQLite assertions always run; only its Postgres half,
  plus pg-integration and pg-migrate, are gated.)
- CI-Portal's full `pnpm install` needs credentials for the private
  `@companionintelligence/tokens` package (web-app only). `pnpm install --filter hono-app`
  works without it; its worker test env also needs `apps/web-app/dist` to exist.
