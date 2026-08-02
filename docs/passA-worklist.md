# Pass A work list — sequenced by transitive importers

> ## State as of 2026-08-02 (branch `feat/postgres-cutover`, 38 commits)
>
> **DONE — waves 0–5 COMPLETE; wave 7's `engine/autoplan.ts` taken EARLY to unblock wave 6. Suite verified after every one
> of the 25 slices; the baseline is now 2634 SQLite-only / 2667 with
> `PG_TEST_URL` (was 2633 / 2665 — the objectives slice added one conformance
> test, which runs once per backend).**
>
> ### ⚠ The "remaining work is smaller" claim was WRONG — it under-counted by 46%
>
> Earlier revisions of this box said 151 (then 136) references in 20 (then 19)
> files, and cleared eight files as "hold NO raw statements, never needed
> porting". **All of that came from a single-line grep**, the exact mistake the
> foundation handoff's §4.1 documented and told us not to repeat: `grep
> 'sqlite\.prepare'` cannot see
>
> ```ts
> const rows = sqlite
>   .prepare(`…`)
> ```
>
> which is the dominant formatting in this codebase. The figure at the time of that
> correction was **261 statements across 27 files** — three are the seam (`db/index.ts`, `db/pg.ts`,
> `db/store.ts`) and one is `agents/groom.ts`'s sqlite-vec residue (below), so
> **23 real files remained**, not 15. (Now **13 real files / 147 statements** — wave 5
> closed, and autoplan landed out of order; see the deadlock note below.)
>
> **The corrected accounting is now CONFIRMED.** With wave 5 empty, the remaining
> per-wave totals are 73 / 117 / 4 — matching the original wave table's numbers
> exactly, arrived at independently. That table was right all along; the
> single-line grep was the only thing that was ever wrong.
>
> **The ORIGINAL wave table at the bottom of this document was right all along.**
> Its wave 6 / 7 / 8 totals (73 / 117 / 4 statements) match a correct count
> exactly, because it was built with a multi-line-aware script. The later "fresh
> count" is what corrupted the picture — and it corrupted it in the direction that
> makes the work look done. **Trust the wave table; distrust any hand grep.**
>
> Those eight wrongly-cleared files are all real work: **calibration (14),
> connectors/base (3), render-copy (3), connectors/index (2), mcp/client (2),
> flags (2)** — all wave 5 — plus **scheduler (1)** and **models (1)** in wave 7.
> `engine/scheduler.ts` matters most of the eight despite its single statement:
> `dayObstacles` is called by autoplan, patterns-place and the flight plan, so it
> is a hub, and it was invisible because its one statement is multi-line.
>
> Re-derive with a multi-line-aware count. Never the bare grep:
>
> ```
> python3 -c "
> import re,subprocess,pathlib
> fs=subprocess.run(['bash','-c','grep -rl sqlite --include=\"*.ts\" server/src --exclude-dir=migrations'],capture_output=True,text=True).stdout.split()
> print(sum(len(re.findall(r'sqlite\s*\.\s*(?:prepare|exec|transaction)', pathlib.Path(f).read_text())) for f in fs))"
> ```
>
> **`agents/groom.ts`'s 5 remaining refs are NOT pass-A work** and will not fall to
> the facade. They are sqlite-vec virtual-table calls (`vec0`, `MATCH`, the
> `vec_dedupe_tmp` scratch table) — a SQLite-extension code path that pgvector
> replaces at cutover, not a statement to route through `store()`. Groom is done;
> the grep just cannot tell. Subtract it before sizing what is left. The reasoning
> is `HANDOFF-2026-08-02-pass-a-waves-0-5.md` §4 ("groom's sqlite-vec KNN path
> stays on the raw handle"); it is repeated here because this is the file you
> actually count from.
>
> Actual remaining, by wave (multi-line-aware; statements in brackets):
>
> | Wave | Files left | Stmts | Which |
> |---|---|---|---|
> | 5 | 0 | 0 | **CLOSED** |
> | 6 | 7 | 73 | block-task-sync (21), day-types (17), reminders (14), sync/apply (7), pattern-blocks (5), recurrence-generate (5), pattern-prefs (4) |
> | 7 | 5 | 70 | tags (60), category-prefs (4), crypto/index (4), scheduler (1), models (1) — ✓ autoplan done early |
> | 8 | 1 | 4 | routes/sse |
> | — | 13 | **147** | + 8 seam + 5 groom = 160 total |
>
> - **Wave 5 — CLOSED, 17 of 17.** ✓ motivation, ✓ series-scope,
>   ✓ triality-vector, ✓ triality, ✓ groom + possibles (the circular pair, one
>   commit as required), ✓ task-close, ✓ **objectives**, ✓ **patterns-place**,
>   ✓ **calibration**, ✓ **the memory pair** (connectors/memory + services/memory,
>   one commit — services/memory is the only importer of the connector's DB-backed
>   exports, so splitting them would have left an intermediate broken state).
>   ✓ **flags** (part 29), ✓ **render-copy + connectors/base + connectors/index +
>   mcp/client** (part 30). **Wave 6 is next**; `sync/apply.ts` is the one that pays
>   the stampRow-handle debt across seven already-ported files.
>
>   **Two shapes worth carrying forward from the wave's last two slices.**
>   `lib/flags` proved a feature gate is the highest-consequence async break found
>   so far: `if (!timeSenseEnabled(o)) { 404 }` stops 404-ing AND
>   `if (timeSenseEnabled(o)) {…}` always takes the ON branch — both polarities fail
>   toward "the dark-shipped feature is live". Grep `if (!` and `? … :` over a
>   ported file's exports before trusting a green suite. And in `routes/oauth.ts` an
>   unawaited `BaseOAuth2Client.storeToken` let the following
>   `UPDATE … SET status='active'` run before the row it activates existed: the
>   connection would be stored but never activated, and both `getConnectors()` and
>   `googleAccounts()` filter on `status='active'`, so that account would silently
>   never sync again.
>
>   **The memory pair's hazard was boolean gates.** `memoryConnectorAvailable`,
>   `pushConnectorAvailable` and the `memoryCreds`-derived probes are all consumed as
>   `if (!f(owner)) return <degraded>`. `!somePromise` is ALWAYS false, so every one
>   of those guards silently STOPS FIRING — the suggest agent, the brief and the push
>   job would each run on against creds that do not resolve, and tsc says nothing
>   because `!x` is legal for any `x`. Four sites (memory-suggest, plan, summarize,
>   syncToMemory). Grep for `if (!` against a ported file's exports before trusting
>   a green suite.
>
>   **`engine/patterns-place.ts` is DONE** (part 26). 13 statements, not the 5 the
>   single-line grep showed. The debt from part 8 is PAID: `ensurePatternsForRange`
>   is now awaited in `services/blocks.blockRowsForQuery`, and the await had to go
>   *before* the select on the next lines — that call materializes the very rows the
>   select reads, so a floated promise would have returned the day view without the
>   routines it had just placed, surfacing them only on a later refetch. tsc could
>   not see it (void return). `placePatternOnDay`'s `sqlite.transaction(fn)()`
>   became `await store().transaction(async () => …)`; its reused `ins` statement
>   stays a plain `store().prepare` because `prepare` is synchronous on the facade.
>   The container INSERT … RETURNING was the `await f(…).id` trap in the wild —
>   parenthesised. `tagsOf`, `localDaysInRange` and `validatePatternRule` stayed
>   sync (their callees are wave 6/7 files that have not ported yet).
>
>   **`services/objectives.ts` is DONE** (part 25). 905 lines, ~50 raw refs, 25
>   exported functions; cascade was routes/objectives (12 sites),
>   graphql/objective-resolvers (11), services/task-promotion (3),
>   graphql/task-resolvers (1), routes/sync (1), and 7 sites in
>   sync-apply.test.ts. What the port had to decide, so it is not re-litigated:
>   - **Two check-then-write guards were re-asserted as part of the write**, per
>     the "implicit atomicity" rule below. `createObjective`'s live-parent check
>     became an `INSERT … SELECT … WHERE EXISTS (…)` (the unguarded `VALUES` form
>     is kept for the parentless case — `id = NULL` matches nothing, so an EXISTS
>     guard there would refuse every root objective), and `archiveObjective`'s
>     root UPDATE is now guarded on `archived_at IS NULL` with the audit gated on
>     `changes > 0`, matching the idempotent early return.
>   - **Two races were deliberately LEFT OPEN and documented at their site**,
>     because closing them needs a schema change rather than a refactor:
>     `linkObjectiveTask` can insert a duplicate join row under a double-submit
>     (`objective_tasks` has no unique index on (objective_id, task_id) — only on
>     the surrogate `id`; same shape and same disposition as
>     patterns.ensureHabitPattern), and `updateObjective`'s re-parent guards can
>     both pass under concurrency, of which the `cycle` one matters: A→B and B→A
>     both commit and the resulting parent loop does not terminate the `UNION ALL`
>     recursive CTEs in `heightBelow`/`wouldCycle`. That one cannot be folded into
>     a WHERE clause — it needs the two writers serialized. Fix both with the
>     other post-cutover items.
>   - `stampRow(sqlite, …)` still keeps the raw handle at 8 sites; the `sqlite`
>     import survives for that alone and dies when sync/apply.ts ports in wave 6.
>   - Both transactions carried over as `await store().transaction(async () => …)`
>     — note the facade RUNS the callback, so the trailing `()` of
>     `sqlite.transaction(fn)()` goes away.
> ### Wave 6 could not START without a wave-7 file — read before sequencing
>
> Every one of wave 6's seven files reaches `engine/autoplan.ts`, which is wave 7:
> day-types, pattern-blocks, pattern-prefs and block-task-sync are imported by it
> DIRECTLY, and reminders, recurrence-generate and sync/apply reach it through
> block-task-sync (whose ten exports were all synchronous). Autoplan's 29 internal
> helpers were synchronous too, so porting ANY wave-6 file forced autoplan async and
> dragged the other six in with it — a single ~120-statement commit. That is exactly
> the §5.2 trap ("porting them pulled in engine/autoplan.ts … and was still growing
> when I stopped"), and the wave boundary as drawn walks straight into it.
>
> **The seam is to port autoplan FIRST**, out of wave order. It is legal because the
> cascade climbs to IMPORTERS, and all ten of autoplan's importers were already
> ported — and because a still-synchronous callee is always safe to call from an
> async function, so autoplan's calls into the unported wave-6 files needed no
> change at all. Done as part 31. Each wave-6 file can now port on its own, with
> autoplan simply gaining an `await` at those twelve call sites.
>
> **The general rule this exposes**: a wave is only independently portable if no
> file OUTSIDE it imports one of its members while still being synchronous itself.
> Check that before starting a wave, not after.
>
> - **Wave 6 (7 files, 73 stmts)** — pattern-prefs, pattern-blocks, day-types,
>   block-task-sync, sync/apply, recurrence-generate, reminders.
> - **Wave 7 (6 files, 117 stmts)** — autoplan, crypto/index, tags,
>   category-prefs, **scheduler** and **models** (the last two restored: they hold
>   one multi-line statement each and had been wrongly cleared).
>   `engine/scheduler.ts` is a hub despite its single statement — `dayObstacles`
>   is called from autoplan, patterns-place and the flight plan.
>   **`services/tags.ts` is the single heaviest file left on the module-level-prepare
>   axis: 44 of them.** That is more than three times the whole of wave 5, and every
>   one has to become a module-scope SQL string plus an in-function
>   `store().prepare`. Budget the slice accordingly — it is mechanical but long, and
>   tags.ts has 9+ importers, so its cascade is wide too. Do NOT bundle it with
>   another file.
> - **Wave 8 (1 file)** — routes/sse (the event-bus design decision).
>
> **`sync/apply.ts` (wave 6) is the one that pays a debt**: every remaining raw
> `sqlite` import in already-ported files exists ONLY to pass the handle to
> `stampRow`/`applyOp`. Porting it removes the last raw-handle argument from
> routes/sync, routes/blocks, engine/extend-block, engine/review, services/blocks,
> services/tasks and services/task-promotion in one go.
>
> - Wave 0 ✓ (scripts; both verified end-to-end on a scratch DB)
> - Wave 1 ✓ (all 16 routes; raw `sqlite` survives ONLY as the handle argument
>   to `applyOp`/`stampRow` in routes/sync + routes/blocks + engine/extend-block
>   + services/blocks + engine/review — dies when sync/apply.ts ports)
> - Wave 2 ✓ (triality resolver)
> - Wave 3 ✓ (all 22 near-leaf services + every cascade)
> - Wave 4: DONE — password, resetToken, owners (the last-operator delete race
>   is now CLOSED: a guarded owners-row DELETE inside deleteOwner's transaction
>   throws typed `LastOperatorError`; the route pre-check is advisory),
>   services/stars, auto-tag, engine-ops, memory-suggest, task-enrich,
>   calibrate-estimates, reflections, triality-learning, engine/stars,
>   **the fused blocks trio** (blocks-place + blocks-recur + services/blocks —
>   blocks.ts calls both engines, so they had to land together; the EXDATE lost
>   update is now CLOSED, see the trap below), **engine/review**,
>   **engine/clear-range**, **engine/auto-defense** (`requestReplan` kept its
>   synchronous fire-and-forget signature — see the rule below),
>   **agents/ingest**, **agents/sync**, **agents/plan**. The agents files turned
>   out NOT to be interdependent — they went in as separate commits, not the
>   single one this list predicted. **engine/recurrence-ops** (its EXDATE lost
>   update is now CLOSED too, same compare-and-swap as blocks-recur — extracted
>   as `appendTemplateExdate`), **engine/deps**, **services/task-promotion**,
>   **services/patterns** (three implicit-atomicity sequences made explicit
>   transactions; `deletePatternType`'s in-use check became a guarded DELETE; one
>   residual race documented in place — see below), **services/tasks**.
>   **Wave 4 is CLOSED — 26 files.**
>
> **Known residual race, deliberately left open.** `patterns.ensureHabitPattern`
> probes "is this task already in a Habit pattern?" by looking for a membership
> row it has not written yet, so two concurrent calls can both pass and create
> two Habit patterns for one task. No single-statement guard fixes a predicate
> that depends on the writer's own later row — it needs a unique index on the
> (task_id, habit-type) pair, i.e. a schema change, which a pure refactor pass
> should not smuggle in. Consequence is a duplicate habit pattern under a
> double-submit, not data loss. Fix alongside the other post-cutover items.
>
> Exporter (handoff §6.6) not started.
>
> **Method that survived contact** (per file): python exact-match replacement →
> `tsc` enumerates the src cascade → UNTRUNCATED full-symbol grep over src+test
> (never pipe through `head` — it hid real call sites twice) → awaits + an
> asyncify pass over enclosing `it()` callbacks → focused tests → serialized
> full-suite gate per slice (no edits while a suite runs) → commit.
> Test-cascade shapes the asyncify regex misses: single-line
> `it('…', () => { … });` forms, `runWithOwner`/`asOwner` wrapper callbacks
> (need `await` on the wrapper AND `async` inside), Promises passed inline as
> JSON-body/object arguments, and adjacent same-shaped lines (grep the symbol
> again after editing — one of four `learnedF(…)` calls escaped a hand pass).
> **`expect(() => f()).toThrow()` fails OPEN when `f` becomes async** — the call
> returns a rejected promise instead of throwing, `toThrow` sees no throw, and the
> assertion passes while testing nothing. The deps slice had two guarding the
> cycle detector. Rewrite as `await expect(f()).rejects.toThrow(…)`, and
> `.not.toThrow()` as `await expect(f()).resolves…`. Grep each ported file's
> symbols for `toThrow` before trusting a green suite. Swept the suite for others:
> every remaining sync `toThrow` targets a still-sync callee (migrations, raw
> better-sqlite3 statements, `parseJsonLoose`, `currentOwnerId`,
> `mergeRefreshToken`). The ones that WILL need this treatment are
> `crypto.test.ts`'s `loadKek()` / `rotateKek()` / `open()` — `crypto/index` is
> wave 7 — so fix them in that slice, not before.
>
> **`await f(...).prop` parses as `await (f(...).prop)`** — property access binds
> tighter than `await`, so it reads the property off the PENDING promise, gets
> `undefined`, and awaits that. Silent. Any assertion of the form
> `expect(f(...).reason)` needs `expect((await f(...)).reason)`, never
> `expect(await f(...).reason)`. This is the trap that most needs a paren-aware
> inserter rather than a regex: the triality tests mixed `expect(f(...))`,
> `expect(f(...).changed)` and `return f(...).F` on adjacent lines, and only the
> last two need the parens. Match the call's closing paren, then branch on whether
> a `.` follows.
> Also: **`vi.advanceTimersByTime` stops working the moment the timer's callback
> becomes async** — it fires the callback but returns before any await settles,
> so assertions right after it see the pre-reflow world. Use
> `await vi.advanceTimersByTimeAsync(…)`. If you asyncify `it(` callbacks with a
> regex, exclude the ones already marked async or you get `async async () => {`
> (21 of them, in one pass).
>
> **Fire-and-forget signatures are worth preserving.** Before async-ifying an
> exported function, count its callers and ask what they do with the result.
> `writeAudit` (125 sites) and `requestReplan` (21) are both floated by every
> caller, so making them async buys nothing and costs a caller-layer cascade. If
> the only reason a function must go async is ONE gate/lookup, push that read
> down into the async work the function already schedules — `requestReplan`'s
> `auto_defense_enabled` check moved into the debounced `fireReplan`. Applies to
> anything triggered from a timer, a handler tail, or a job tick.
>
> **`tail` truncates tsc exactly like `head` does.** clear-range's first
> typecheck run, piped through `tail -12`, showed only
> `src/scripts/clear-planner-from.ts` — four resolver/route call sites were
> above the window and looked like silent Promise-payload traps. The full run
> had 15 errors across 5 files. Pipe tsc through `grep "error TS"`, never a
> head/tail window.

> Companion to `docs/HANDOFF-2026-08-02-oidc-and-postgres-port.md` §4–§5 and
> `server/db/postgres/README.md`. This is the ordered plan for the remaining
> call-site migration, built from an import-graph analysis of `server/src`
> (script: multi-line-aware `sqlite.(prepare|exec|transaction)` count + BFS over
> reverse imports). Regenerate rather than trust stale numbers — the handoff's
> §4.1 history earns that rule.

## Why this order

Porting a file makes its exported functions async; the cascade climbs to its
**importers**, not its imports. So the only safe order is topological from
files nothing imports (scripts, route handlers) down toward the hubs. Each
wave's files find their callers already async, so the new `await`s are local
edits. The reverse order — starting with the biggest files — is what §5.2
tried and aborted.

Two prior findings still bind:

- **No scripted edits** (§5.3). Per file, by hand, suite after each.
- **`tsc` does not see tests** (§5.4). The suite run is the signal for the
  test half of each cascade.

## New hazard: implicit atomicity from synchronicity

Not in the handoff. Several files document multi-statement safety as a
*property of better-sqlite3 being synchronous* — no await between statements
means no interleaving from concurrent requests:

- `routes/accounts.ts` DELETE handler: "Check-then-delete is safe from
  interleaving here: better-sqlite3 is synchronous and this handler has no
  await between the count and the delete." Once `operatorCount()` /
  `deleteOwner()` go async, two concurrent DELETEs can both pass the
  last-operator check and leave zero operators.
- `services/block-task-sync.ts`: "raw `sqlite` (synchronous) so a write can't
  be interrupted mid-flight".
- `services/{tasks,tags,objectives,patterns,block-templates,flight-plan,task-promotion}.ts`
  all carry "better-sqlite3 is synchronous; these are plain sync functions"
  headers.

Every `await` is an interleaving point — even on the SQLite backend
(concurrent handlers' microtask chains interleave). When porting each of these
files: wrap formerly-contiguous multi-statement sequences in
`store().transaction(…)`, and convert cross-request check-then-write guards to
single guarded statements (the pattern `routes/accounts.ts` PATCH already
uses for role demotion) — a plain transaction is NOT enough for those under
Postgres READ COMMITTED. Grep the file for "synchronous", "no await", and
"atomic" before starting it.

## Waves

Statement counts are src-only (tests add ~1,678 more across 198 files).
`trans` = transitive importers = upper bound on files that must absorb the
async change when this file ports.

| Wave | What | Files | Stmts | Character |
|---|---|---|---|---|
| 0 | `scripts/` (import-plan, seed-test-data) | 2 | 23 | True leaves; nothing imports them. `main()` already async. |
| 1 | `routes/*` except `sse.ts` | 16 | 98 | Koa handlers; async-ifying a handler is local (routers mount, never await). `backup.ts` handlers are currently sync — convert as part of the port. |
| 2 | `graphql/triality-resolvers.ts` | 1 | 1 | graphql-js awaits promise resolvers natively; only post-processing call sites need edits, and tsc sees them. |
| 3 | Near-leaf services/libs/jobs (trans ≤ 9, ≤ 1 unported sqlite importer) — vapid-config, task-metrics, connection-prefs, priorities, google-config, extend-block, triality-metrics, timer, planning-sessions, summarize, weekly-review, connections, prefs, experiment, jobs, jobs/index, block-templates, notifications, reset-routines, freeze-stars, advance-objectives, flight-plan | 22 | 145 | Callers are mostly wave 0–2 files, already async by now. |
| 4 | Mid services + auth libs + engine periphery — password, resetToken, owners, stars, auto-tag, task-enrich, engine-ops, memory-suggest, calibrate-estimates, reflections, triality-learning, review, clear-range, sync, plan, ingest, blocks, auto-defense, blocks-place, stars(engine), blocks-recur, tasks, recurrence-ops, deps, task-promotion, patterns | 26 | 292 | The bulk. Inspect each file's callers before starting it. |
| 5 | Connector/agent cluster — render-copy, connectors/index, triality, calibration, possibles, triality-vector, groom, flags, task-close, memory, series-scope, objectives, motivation, mcp/client, connectors/memory, patterns-place, connectors/base | 17 | 153 | Interdependent; expect multi-file commits. |
| 6 | Deep shared services — pattern-prefs, pattern-blocks, day-types, block-task-sync, sync/apply, recurrence-generate, reminders | 7 | 73 | trans 31–61. The §5.2 trap files live here — commit sizes grow. |
| 7 | The hubs — autoplan, crypto/index, scheduler, models, **tags (60)**, **category-prefs** | 6 | 117 | trans up to 66. The predicted one-large-commit zone; by now every caller is already async. |
| 8 | `routes/sse.ts` | 1 | 4 | **Not a route — an event bus** (39 direct importers). `logSyncEvent` *returns* the seq from its insert, so the writeAudit fire-and-forget pattern does not apply if callers consume the seq. Needs a design decision: async-ify (cascade is absorbed by then) or restructure. |
| — | `db/index.ts`, `db/store.ts`, `db/pg.ts` (8 stmts) | 3 | 8 | **Not work.** This is the seam itself. |

**Total: 914 src statements / 101 files** (23+98+1+145+292+153+73+117+4+8 = 914,
of which 906 are portable work).

## Two more silent-break shapes (found in wave 1–3, both typecheck clean)

- **`Array.filter`/`.every` with an async predicate** returns promises — always
  truthy, so every element passes. `routes/backup.ts` insertJunctionRows would
  have silently stopped dropping other owners' junction rows on import.
  Rewrite as explicit loops.
- **Koa does not await `ctx.body`** — `ctx.body = nowAsyncService(…)` assigns
  a Promise and serializes `{}`. `ctx.body` is `any`, so tsc says nothing;
  only the suite catches it. When a service ports, sweep its route call
  expressions for missing `await`.
- **Module-level `store().prepare(…)` throws at import time** when the module
  loads before db/index installs the backend (§5.5's trap in a new form —
  `services/task-metrics.ts` had module-level prepares). Keep SQL strings at
  module level; call `store().prepare` inside functions.
  **Wave 5 is dense with these — 13 across 5 files**, found by:

  ```
  grep -rn "^const .*sqlite\.prepare" server/src --include=*.ts
  ```

  **Wave 5 is now CLEAR of them; all 44 that remain are in `services/tags.ts`**
  (wave 7) — the earlier "13" counted wave-5 files only, and the true repo-wide
  figure was 47. Convert each to a module-level SQL string plus an in-function
  `store().prepare` — and note the suite will NOT catch a miss if the module
  happens to be imported after boot in test order, so fix them on sight rather
  than waiting for red.

  A bonus from doing this: `store().prepare` is ALREADY lazy, so any
  "prepare this one lazily because the table/column may not exist yet" guard
  written around better-sqlite3's eager prepare can be deleted outright.
  `triality-vector`'s `selectMotivationEntries` was one.
- **`Array.forEach` with an async callback drops the promise entirely.** Strictly
  worse than the `.filter`/`.every` case above: filter at least returns truthy
  promises, forEach discards them, so the body runs unordered and detached, any
  counter or accumulator after the await never runs, and a rejection surfaces as
  an unhandled rejection rather than failing the caller. Four sites in the ingest
  slice (`runExtraction`'s upsert loop, three in seed-test-data). Rewrite as
  `for (const [i, x] of xs.entries())`.
- **An unawaited void-returning call is invisible to tsc AND to the return-type
  check.** In `syncConnector`, `applyInbound` going async left the whole inbound
  reconcile detached, and the cursor write that must follow it ran first —
  silently inverting the advance-after-commit invariant. tsc flagged only the
  sibling line whose value was actually consumed. After porting a file, grep
  EVERY symbol it exports or calls internally, not just the ones tsc named.
- **Read-modify-write on a JSON-array column is a lost update.** Distinct from
  the check-then-write shape above: nothing is *checked*, so it reads as a plain
  port. `blocks-recur.excludeBlockOccurrence` SELECTed the template's
  `recurrence_exdates`, appended a day, and UPDATEd it back. With no await
  between them that was safe for free; with one, deleting two occurrences of the
  same template concurrently makes the second write drop the first's date and
  the occurrence resurrects on the next read. Fixed with a compare-and-swap:
  guard the UPDATE on the exact value read (`COALESCE(col,'') = ?` — portable,
  unlike `IS`/`IS NOT DISTINCT FROM`), retry against the fresher list on
  `changes === 0`, throw after 5 losses rather than silently skip the write.
  A plain transaction does NOT fix this under Postgres READ COMMITTED. Grep a
  file for `JSON.stringify` next to an UPDATE before porting it.
- **Dropping an `as T` cast for `.get<T>()` can make an inference cycle (TS7022).**
  Not a silent break — it fails the typecheck — but the error names the variable,
  not the cause, so it reads as a mystery. A type ASSERTION fixes an expression's
  type regardless of its arguments; the generic does not, so a loop of the shape
  `let cur: string | null = …; while (cur) { const row = await …get<T>(cur); cur =
  row.parent_id }` becomes circular: narrowing `cur` needs every assignment to it,
  which needs `row`, which needs the narrowed `cur`. `recomputeProgress` hit this.
  Annotate the local (`const row: T | undefined = await …`) rather than reaching
  back for a cast.
- **`x ?? null` on a now-async call is a no-op that happens to survive GraphQL.**
  `??` sees a pending promise, which is never nullish, so it returns the promise
  and the `?? null` does nothing; graphql-js then awaits it and gets `undefined`,
  which it coerces to null for a nullable field. So it works — by luck, through two
  layers — and reads as correct. Four sites in the objectives resolvers. Await
  inside the parens (`(await f(…)) ?? null`) so the intent survives a future
  refactor that consumes the value somewhere less forgiving than a field resolver.

**A raw NUL byte in a source file hides it from EVERY grep.**
`services/calibration.ts` built a composite Map key by joining two fields with a
literal U+0000, which made `file` report it as `data` rather than text. The two
greps in this environment then disagreed, both unhelpfully: GNU grep (what
`bash -c` scripts get) suppresses LINE output for binary files, so the prescribed
`grep -rn` returned nothing for it while `-l`/`-c` still named it; ugrep (what the
interactive shell's `grep` function resolves to) dropped the file entirely, even
for `-l`. That is how a 14-statement file — the second largest left in wave 5 —
came to be catalogued as holding none. It has been converted to the escape form,
which is the same string at runtime. **Before trusting any grep-derived
inventory, check for others:**

```
python3 -c "
import pathlib
print([str(p) for p in pathlib.Path('server').rglob('*.ts') if b'\x00' in p.read_bytes()])"
```

At this commit that list is empty. Prefer a python `rglob` walk over `grep -rl`
for file selection generally — it has no binary heuristic to be wrong about.

**New dialect-portability coverage.** The guarded `INSERT … SELECT … WHERE EXISTS`
that `createObjective` now uses is pinned in `test/store-conformance.test.ts`, so it
is asserted on BOTH backends rather than only the one pass A runs on. It verifies
that a full parameter list binds in the SELECT list (Postgres infers those types
from the INSERT's target columns) and that a failed guard reports `changes = 0`
rather than raising. Add a conformance case whenever a slice introduces a SQL shape
the existing statements do not already cover — that is cheaper than discovering it
at the `STORE_BACKEND=postgres` flip.

## Known N+1s the port preserves (do not fix during pass A)

`services/blocks.enrichApi` calls `rationaleOf` once per row — free on
better-sqlite3, one round trip per block under Postgres (a week view is ~100).
It was already per-row before the port; batching it is a behavior change, so it
belongs after the cutover, alongside the batched `entityCategoryNamesByIds` /
`externalSourceByBlockId` reads that already sit beside it.

## Per-file loop

1. Read the file's *direct importers* (`grep -rn "from.*<name>" server/src`) —
   confirm they're already async or in an earlier wave.
2. Port statements to `await store.prepare(…)` / `store.transaction(…)`.
3. `pnpm --filter server exec tsc --noEmit` — catches src-side cascade.
4. `pnpm --filter server test` — catches test-side cascade (§5.4).
5. Commit per file (or per small cluster in waves 5–7).

## After wave 8

Follow handoff §6 items 4–7: flip `test/helpers.ts` `resetDb`, then
`STORE_BACKEND=postgres`, fix dialect deltas (43 `INSERT OR IGNORE`,
3 `INSERT OR REPLACE`, 20 `strftime`, 3 `julianday`, 2 `lastInsertRowid`,
and `PRAGMA table_info` in `engine/series-scope.ts` forkSeriesAt — Postgres
needs `information_schema.columns`; it is there deliberately, so the column
copy can't silently stop copying columns added later),
delete better-sqlite3/sqlite-vec/Drizzle + 147 SQLite migrations, and write
the one-shot data exporter before any deployed install can cut over.
