# Pass A work list — sequenced by transitive importers

> ## State as of 2026-08-02 (branch `feat/postgres-cutover`, 37 commits)
>
> **DONE — waves 0–4 COMPLETE, wave 5 at 7 of 11. Suite verified at 2633 passed
> after every one of the 24 slices.**
>
> **Remaining work is smaller than this document originally predicted.** A fresh
> count of `sqlite.(prepare|exec|transaction)` across `server/src` gives **151
> references in 20 files**, three of which are the seam itself (`db/index.ts`,
> `db/pg.ts`, `db/store.ts`) — so **17 files actually remain**. Several files the
> wave lists below name (render-copy, connectors/index, calibration, flags,
> mcp/client, connectors/base, scheduler, models) hold NO raw statements and are
> already done or never needed porting. Re-run the count rather than trusting the
> per-wave file lists:
>
> ```
> grep -rn "sqlite\.\(prepare\|exec\|transaction\)" server/src --include=*.ts | wc -l
> ```
>
> Actual remaining, by wave:
> - **Wave 5 (4 files left of 11)** — ✓ motivation, ✓ series-scope,
>   ✓ triality-vector, ✓ triality, ✓ groom + possibles (the circular pair, one
>   commit as required), ✓ task-close. Remaining: **objectives** (15 stmts, 9
>   importers — the big one; note task-promotion already calls its
>   recomputeProgress/linkObjectiveTask synchronously, so that cascade lands
>   here), connectors/memory, services/memory, patterns-place.
>   `patterns-place.ensurePatternsForRange` is still called UNAWAITED from
>   services/blocks.blockRowsForQuery — the one call site left deliberately sync
>   in part 8. Add the await when it ports.
>
>   **START HERE — `services/objectives.ts`, surveyed but NOT started.** 905 lines,
>   ~50 raw `sqlite` references (the "15" above counted single-line matches only —
>   trust the grep, not that number), 25+ exported functions, 9 importers. Largest
>   single slice left in wave 5; give it its own commit. What the survey found, so
>   it need not be redone:
>   - **Recursive / looping helpers that all go async and are called from inside
>     loops**: `heightBelow` (a `WITH RECURSIVE` query), `restampLevels` (walks UP
>     the parent chain calling `heightBelow` per node), `wouldCycle`,
>     `liveDescendantIds`, and `recomputeProgress` (rolls up through children).
>     Await inside those loops — do NOT reach for `.map`.
>   - **Two existing transactions** to carry over: `archiveObjective` and
>     `restoreObjective` (its subtree walk). The comment near line 748 — cascade as
>     a unit "has to be atomic" — is the reason; keep it true.
>   - **`stampRow(sqlite, …)` appears ~8 times** and keeps the raw handle, as
>     everywhere else, until sync/apply.ts ports in wave 6.
>   - Header line 17 still claims "better-sqlite3 is synchronous; these are plain
>     sync functions" — correct it the way patterns.ts's was.
>   - No module-level prepares in this file.
> - **Wave 6 (7 files)** — pattern-prefs, pattern-blocks, day-types,
>   block-task-sync, sync/apply, recurrence-generate, reminders.
> - **Wave 7 (4 files)** — autoplan, crypto/index, tags, category-prefs.
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
