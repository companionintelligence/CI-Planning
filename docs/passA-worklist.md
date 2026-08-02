# Pass A work list — sequenced by transitive importers

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
