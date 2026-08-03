# Handoff — 2026-08-02 · Pass A COMPLETE — the cutover is next

> ## Read this box first
>
> - **Pass A is finished.** Every call site is on the store facade. **Zero raw
>   `sqlite` statements remain** outside the seam (`db/index.ts`, `db/store.ts`,
>   `db/pg.ts`), `boot.ts` which installs it, and `agents/groom.ts`'s sqlite-vec
>   path, which pgvector replaces at cutover rather than porting.
> - **Green on both backends, at every commit.** **2634** passed / 21 skipped
>   SQLite-only; **2667** passed / 3 skipped with `PG_TEST_URL`, 225/225 files.
>   Never once red across 13 slices.
> - **This session ported 296 statements across 24 files** (parts 25–37, 17
>   commits). The app still runs on SQLite — `STORE_BACKEND` is still opt-in and
>   inert. Nothing user-visible changed.
> - **⚠ ONE BLOCKER BEFORE THE FLIP.** `sync_events.seq` is `INTEGER PRIMARY KEY`
>   in the Postgres baseline, which auto-assigns on SQLite but is a plain
>   non-defaulted column on Postgres — **every `sync_events` INSERT will fail
>   NOT NULL at cutover.** §4. Fix it first; the suite will not tell you.
> - **Two structural corrections to the plan (§3)** — the remaining-work count was
>   46% low, and wave 6 could not be started without a wave-7 file. Read §3 before
>   sequencing anything.
> - **Start here: the cutover, in the order given in §8.**
> - **The trap catalogue is `docs/passA-worklist.md`, not here.** It is the
>   checklist; this is the narrative.

Companion to `docs/HANDOFF-2026-08-02-oidc-and-postgres-port.md` (the foundation)
and `docs/HANDOFF-2026-08-02-pass-a-waves-0-5.md` (the previous session, parts
8–24). `docs/passA-worklist.md` is the live tracker and carries every trap.

---

## 1. Where the work is

| | |
|---|---|
| Worktree | `.claude/worktrees/postgres-cutover-handoff-9f14db` |
| Branch | `claude/postgres-cutover-handoff-9f14db` |
| Based on | `feat/postgres-cutover` @ `fa90942` (+17 commits) |
| Ahead of `origin/main` | 63 commits |
| PR | [#464](https://github.com/companionintelligence/CI-Planning/pull/464), base `feat/postgres-cutover` |

`feat/postgres-cutover` moved under this session once (a docs-only commit); the
branch was rebased onto it cleanly. Both were pushed — `feat/postgres-cutover` had
never been on the remote, and without it the PR would have shown 53 commits against
`main` and read as a proposal to merge the whole in-flight cutover.

---

## 2. What shipped

| Part | File(s) | Stmts | Note |
|---|---|---|---|
| 25 | `services/objectives.ts` | ~50 | two guards folded into their writes; two races documented |
| 26 | `engine/patterns-place.ts` | 13 | paid part 8's unawaited `ensurePatternsForRange` debt |
| — | `services/calibration.ts` | — | `fix(db)`: raw NUL byte → escape (§3.2) |
| 27 | `services/calibration.ts` | 14 | two `.map` shapes that produced a WRONG VALUE, not a dropped promise |
| 28 | `connectors/memory` + `services/memory` | 15 | boolean gates: `!somePromise` is always false |
| 29 | `lib/flags.ts` | 2 | 11 gate sites; both polarities fail toward "the dark-shipped feature is live" |
| 30 | render-copy, connectors/base + index, mcp/client | 10 | **wave 5 closed**; found the unawaited `storeToken` ordering bug |
| 31 | `engine/autoplan.ts` | 47 | taken EARLY from wave 7 — wave 6 could not start without it (§3.3) |
| 32 | `services/block-task-sync.ts` | 21 | two status guards folded into their UPDATEs |
| 33 | `recurrence-generate` + `reminders` | 19 | exactly-once claim survives; only its stated reason was wrong |
| 34 | pattern-blocks, day-types, pattern-prefs | 26 | spreading a promise yields `{}` |
| 35 | `sync/apply.ts` | 7 | **wave 6 closed**; retired the raw handle from 81 sites / 9 files |
| 36 | `services/tags.ts` | 60 | the mountain: 44 module-level prepares, 37 files touched |
| 37 | category-prefs, crypto, scheduler, models, **sse** | 14 | **waves 7+8 closed — PASS A COMPLETE** |

Three `docs(db)` commits carry the corrections in §3.

---

## 3. Two structural corrections to the plan

These matter more than any individual slice, because both were wrong in the
direction that makes the work look finished.

### 3.1 The remaining-work count was 46% low

Both handoffs told a successor to re-derive what remains with

```
grep -rn "sqlite\.\(prepare\|exec\|transaction\)" server/src --include=*.ts | wc -l
```

That is single-line only. It cannot match

```ts
const rows = sqlite
  .prepare(`…`)
```

which is the dominant formatting in this codebase. It reported **136 statements /
19 files against 261 / 27 actual** — the same mistake the foundation handoff's §4.1
already catalogued, for the third time.

The damage was not arithmetic. On that grep's authority both documents had
**cleared eight files as "never needed porting"**: calibration (14 statements),
connectors/base (3), render-copy (3), connectors/index (2), mcp/client (2), flags
(2), scheduler (1), models (1). All eight were real work. `engine/scheduler.ts`
mattered most — one statement, but `dayObstacles` is called from autoplan,
patterns-place and the flight plan, so a hub had been written off as a non-file.

**The ORIGINAL wave table was right all along.** Its wave 6/7/8 totals (73/117/4)
match a correct count exactly, because it was built with a multi-line-aware script.
Trust that table; distrust any hand grep. `passA-worklist.md` now carries a
multi-line-aware command instead.

### 3.2 One file was invisible for a second, independent reason

`services/calibration.ts` contained a **raw NUL byte** — a delimiter in a composite
Map key — which made `file` report the source as `data`. The two greps in this
environment then disagreed, both unhelpfully:

- **GNU grep 3.12** (what `bash -c` scripts get) suppresses LINE output for binary
  files, so the prescribed `grep -rn` returned nothing while `-l`/`-c` still named it.
- **ugrep 7.5.0** (what the interactive shell's `grep` function resolves to) drops
  the file entirely, including for `-l`.

Converted to the escape form in its own commit — identical string at runtime, and
the file is now UTF-8 text. **No other source file contains NUL bytes**; the check
is in the work list. Prefer a python `rglob` walk over `grep -rl` for file
selection: it has no binary heuristic to be wrong about.

### 3.3 Wave 6 could not be started without a wave-7 file

Every one of wave 6's seven files reaches `engine/autoplan.ts`, which is wave 7.
day-types, pattern-blocks, pattern-prefs and block-task-sync are imported by it
directly; reminders, recurrence-generate and sync/apply reach it through
block-task-sync, whose ten exports were all synchronous. Autoplan's 29 internal
helpers were synchronous too, so porting ANY wave-6 file forced autoplan async and
dragged the other six along — one ~120-statement commit across eight files. That is
exactly the §5.2 trap the plan documents, and the wave boundary walks into it.

**Porting autoplan FIRST breaks the cycle**, and is legal for two reasons the wave
ordering makes easy to miss: the cascade climbs to IMPORTERS, and all ten of
autoplan's importers were already ported; and **a still-synchronous callee is always
safe to call from an async function**, so autoplan's twelve calls into the unported
wave-6 files needed no change at all.

**The general rule, and it applied again INSIDE wave 6** (block-task-sync before
reminders/recurrence-generate/sync-apply; pattern-blocks before day-types):

> A wave is independently portable only if no file OUTSIDE it imports one of its
> members while still being synchronous itself. Check before starting a wave.

---

## 4. ⚠ The port defect — fix before flipping

`sync_events.seq` is declared `INTEGER PRIMARY KEY` in the Postgres baseline
(`20260802000400_create_planning_baseline.sql`). On SQLite that is a rowid alias and
auto-assigns. **On Postgres it is a plain, non-defaulted column**, so every
`sync_events` INSERT — one per `broadcast()`, i.e. one per mutation — will fail its
NOT NULL constraint the moment `STORE_BACKEND=postgres`.

It needs `GENERATED BY DEFAULT AS IDENTITY` (or a sequence) in the schema migration.

**The dual-backend suite will not catch this**, because nothing in
`pg-integration.test.ts` writes `sync_events`. It was found by reading the schema
while porting `logSyncEvent`, not by a failing test. Consider adding a
pg-integration case that inserts one, so the next such gap fails loudly.

Related and already fixed: `logSyncEvent` now uses `INSERT … RETURNING seq` instead
of `lastInsertRowid`, which retires one of the two documented dialect deltas —
the facade's `run()` deliberately reports only `{ changes }`.

---

## 5. Bugs the port would have introduced

Every one of these typechecks clean. All were found by the untruncated symbol
sweep or by the suite — never by tsc.

**Feature-flag bypass (part 29), the highest-consequence.** `timeSenseEnabled` /
`trialityEnabled` are consumed as gates, and **both polarities fail the same way**:

```ts
if (!timeSenseEnabled(owner)) { ctx.status = 404; return; }   // stops 404-ing
if (timeSenseEnabled(owner))  { …Z7 voice path… }             // always takes ON
```

`!somePromise` is always false. Between them that is the entire dark-ship mechanism
for Time-Sense and Triality, defeated silently, across 11 sites plus three
route-level `gate(ctx)` helpers whose own 10 call sites had to follow.

**The whole Z6 feature switched off (part 27).** `resolveCalibration`'s scope ladder
ran `.map(read.get).filter((r): r is ScopeStats => !!r && r.sample_count >= FLOOR)`.
With an async `read.get` every element is a pending promise: `!!r` passes,
`r.sample_count` is `undefined`, `undefined >= 5` is false. Every candidate dropped
on every rung → `null` for every task. The `r is ScopeStats` predicate asserts the
lie straight past the compiler.

**An OAuth connection stored but never activated (part 30).** `routes/oauth.ts` did
`BaseOAuth2Client.storeToken(…)` then `await store()…UPDATE … SET status='active'`.
Unawaited, the INSERT floats and the UPDATE runs first, matching zero rows — and
both `getConnectors()` and `googleAccounts()` filter `status='active'`, so that
account silently never syncs again behind a successful-looking callback.

**Spreading a promise yields `{}` (part 34).** `ctx.body = { date,
...resolveDayTypeWithSource(o, d) }` drops every field: a pending promise has no own
enumerable properties, so the route answers 200 with `{ date }`. A paren-aware await
inserter walks past it — the call sits between `...` and `)`, so it reads as a bare
statement.

**`"[object Promise] + [object Promise]"` into user-visible copy (part 27).**
`scopeLabel`'s combo branch ran `ref.split('+').map(tagName).join(' + ')`. String
coercion never throws and the template still infers `string`.

**Five unawaited tag WRITES (part 36).** `applyBlockTagLevels` / `applyTaskTagLevels`
in the create/update paths: void-returning, so tsc is blind; the row was written and
its tags silently were not.

**An archive cascade detached from its transaction (part 25).** `routes/sync` floated
`applySyncedObjectiveUpkeep`, so the cascade would race the commit and a client could
observe an archived root whose subtree was still live.

**Part 8's deliberate debt, paid (part 26).** `ensurePatternsForRange` was the one
call site kept sync. Its `await` had to go BEFORE the select on the following lines —
it materializes the very rows that select reads, so left floating the day view returns
without the routines it just placed.

---

## 6. Decisions made deliberately

Each is also commented at the code site.

**`broadcast` stays synchronous and fire-and-forget** (part 37, the wave-8 decision
the plan deferred). 192 call sites, and it returns void — async-ifying it would make
every mutating route, service and resolver await a result none of them consume. Same
reasoning that keeps `writeAudit` floating. What could NOT be floated is the `seq`:
it becomes the SSE frame's `id:` line and powers Last-Event-ID catch-up, so the emit
moved INSIDE the promise chain and the frame carries the correct seq one microtask
later. `flushBroadcasts()` is the `flushAudits()` twin.

**Four check-then-write guards were folded INTO their writes**, because an await now
separates each from what it protects and a transaction does not close that under
Postgres READ COMMITTED:

| Guard | Why it is not benign |
|---|---|
| `createObjective` live parent → `INSERT … SELECT … WHERE EXISTS` | a live child under an archived parent silently resurfaces as a top-level goal |
| `archiveObjective` root → `… AND archived_at IS NULL` | two concurrent archives both re-stamp and re-cascade |
| `applyTaskPlacementStatus` → `… AND status = 'open' AND subtype <> 'habit'` | a caller that read 'open' writes 'scheduled' over a concurrent completion |
| `revertTaskPlacementStatus` → `… AND NOT EXISTS (active placement)` | sends a task that HAS a block back to the open backlog |

The unguarded `VALUES` form is kept for parentless creates: `id = NULL` matches
nothing, so an EXISTS guard there would refuse every root objective.

**Three races left OPEN and documented at their sites**, all needing a schema change
rather than a refactor — same disposition as `ensureHabitPattern`:

- `linkObjectiveTask` can insert a duplicate join row under a double-submit
  (`objective_tasks` has no unique index on the pair).
- `updateObjective`'s **cycle** guard: A→B and B→A both commit, and the resulting
  parent loop does not terminate the `UNION ALL` recursive CTEs in
  `heightBelow`/`wouldCycle`. Needs the writers serialized, not a better WHERE.
- `patterns.ensureHabitPattern` (inherited, part 18).

**A claimed invariant that survived with the wrong reason attached** (part 33).
`reminders`' header credited exactly-once delivery to "better-sqlite3 is synchronous
+ single-writer". The port makes that reason false while leaving the guarantee
intact, because what actually provides it is the claim being ONE statement —
`UPDATE … RETURNING` is atomic on Postgres too. The comment was corrected, not the
code. Worth checking for more of these: a header explaining WHY something is safe is
a load-bearing claim, and the port can falsify the explanation without touching the
property.

---

## 7. Method — and what the automation got wrong

The per-file loop from the previous handoff still holds: port statements →
**untruncated** `tsc` → **full-symbol grep over src and test** → awaits + asyncify
enclosing callbacks → focused tests → serialized full-suite gate → commit.

New this session, and all self-inflicted — record these before automating anything:

- **Resolve import ALIASES before sweeping.** `import { createTag as svcCreateTag }`
  and `createTagService` in tag-resolvers. A sweep keyed on EXPORT names misses every
  one; 17 test failures came from this alone.
- **A sweep only awaits the OUTER call.** `setEntityCategories('task', id,
  categoryIdsForOwner(names, owner))` left the inner argument raw.
- **Check whether a file defines its own copy of a name.** A local `resolveTagId` in
  migration 0033 shares a name with a tags.ts export; the sweep rewrote the
  migration's own function.
- **Never let an inserter touch GraphQL document strings.** It rewrote the FIELD NAME
  inside `gql('mutation { setPatternBlockRanges(…) }')` → `Cannot query field
  "await"`. The shorthand `gql('{ field(…) }')` form has no `query` keyword to anchor
  on.
- **A paren-aware inserter must skip promise-chaining and `expect`.** A repo-wide
  `await f(...).prop` → `(await f(...)).prop` pass also wrapped `await f().catch(…)`,
  `.then(…)` and `await expect(…)`, where the parens change meaning rather than fix
  it. 60 sites reverted.
- **`prepare` is SYNCHRONOUS on the facade.** The same pass rewrote `await
  prepare(sql).all(…)` into `(await prepare(sql)).all(…)` at 21 sites — which drops
  the await from `.all()` and leaves a pending promise. It typechecks whenever the
  value is discarded, so it surfaced only under `PG_TEST_URL`. The await belongs on
  the whole chain.
- **`await expect(await f())` is its own kind of wrong** — the inner await throws
  before the matcher runs. The promise must reach `expect()` unresolved.
- **`expect(() => f()).toThrow()` fails OPEN only when the arrow is left sync.** Once
  an inserter puts `await` inside it, oxc rejects it at transform time — loud, but a
  long way from the cause.

`tsc` remains blind to: `ctx.body` (typed `any`), GraphQL resolvers returning
promises, void-returning calls, and every boolean-gate shape. The symbol sweep is
what finds those, and it is not optional.

---

## 8. The cutover — do it in this order

1. **Fix `sync_events.seq`** (§4). Nothing else works until this is done, and no test
   will tell you.
2. Flip `test/helpers.ts` `resetDb` to Postgres.
3. Set `STORE_BACKEND=postgres` and run the suite. Expect the dialect deltas:
   **43 `INSERT OR IGNORE`, 3 `INSERT OR REPLACE`, 20 `strftime`, 3 `julianday`**,
   plus `PRAGMA table_info` in `engine/series-scope.ts` `forkSeriesAt` and
   `triality-vector.motivationColumnExists` — Postgres needs
   `information_schema.columns`. Both are deliberate, so the column copy cannot
   silently stop copying columns added later.
   (`lastInsertRowid` is already retired — see §4.)
4. Delete better-sqlite3, sqlite-vec, Drizzle, the 147 SQLite migrations, and
   `agents/groom.ts`'s `vec0` KNN path (its cosine fallback already makes identical
   keep/drop decisions).
5. **Write the one-shot SQLite → Postgres exporter. STILL NOT STARTED**, and it is
   what makes the cutover safe for any deployed install.
6. Only then consider type tightening (`timestamptz`, `jsonb`, `boolean`) — a
   deviation from CI-Server's conventions that the port deliberately deferred.

Deferred cleanups, all documented at their sites: the three residual races (§6), the
two Gmail read-modify-writes, and `services/blocks.enrichApi`'s per-row `rationaleOf`
N+1 (free on SQLite, one round trip per block under Postgres; batching it is a
behaviour change).

---

## 9. Environment notes

- Postgres tests skip without `PG_TEST_URL`. CI should set it:
  ```bash
  docker run -d --name cip-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=planning \
    -p 55432:5432 pgvector/pgvector:pg17
  PG_TEST_URL=postgres://postgres:pw@localhost:55432/planning pnpm --filter server test
  ```
  A skipped Postgres half is a GREEN run that proves nothing — check the gated files
  actually executed, not just the total.
- Suite: **2634** without Postgres, **2667** with. The gap is 33 tests: the two
  PG-only files plus the conformance suite's Postgres half. Two of those 33 are new
  this session — the `INSERT … SELECT … WHERE EXISTS` conformance case runs once per
  backend.
- `.claude/launch.json` gained two branch-preview configs — **Branch preview API
  (3849)** and **Branch preview client (5174)** — so the branch can be run without
  touching the systemd `companion-planning` service on 3848. The client proxies
  `/api` to 3849 via `VITE_API_TARGET`.
- Verified in the browser at the end of this session: the app boots on the fully
  ported layer, and `/api/day-types/resolve/…` returns `key` + `source` (the
  spread-a-promise fix) while `/api/tags` returns 66 tags with array-valued
  `directions`/`categories` — both would be silently wrong if those fixes had not
  landed.
