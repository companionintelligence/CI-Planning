# Pass A work list — sequenced by transitive importers

> ## State as of 2026-08-02 (branch `feat/postgres-cutover`, 18 commits)
>
> **DONE — waves 0–3 complete, wave 4 in progress. ~414 of 906 portable
> statements ported. Suite verified at 2633 passed after every commit.**
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
>   **engine/clear-range**.
>   REMAINING (9 files, ~145 stmts): **next slice = engine/auto-defense** (11
>   stmts, 7 importers), then the agents trio (sync, plan, ingest — expect one
>   commit), services/tasks, recurrence-ops, deps, task-promotion, patterns.
>   `recurrence-ops.skipInstance` carries the SAME EXDATE read-modify-write as
>   blocks-recur — reuse the compare-and-swap below rather than porting it
>   straight.
> - Waves 5–8 untouched. Exporter (handoff §6.6) not started.
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
3 `INSERT OR REPLACE`, 20 `strftime`, 3 `julianday`, 2 `lastInsertRowid`),
delete better-sqlite3/sqlite-vec/Drizzle + 147 SQLite migrations, and write
the one-shot data exporter before any deployed install can cut over.
