# Handoff — 2026-08-02 · Pass A, waves 0–4 complete + wave 5 in flight

> ## Read this box first
>
> - **Branch `feat/postgres-cutover` is clean and green.** Nothing is half-done.
>   Suite: **2634 passed / 21 skipped** (2667 with `PG_TEST_URL`), verified after
>   every one of the 25 slices — never once red.
> - **Waves 0–5 are COMPLETE.** Wave 5 closed at 17 of 17 — not the 11 earlier
>   revisions claimed; the wrongly-cleared files below were wave-5 work. The call-site migration went
>   from ~355 to ~800 statements ported.
> - **13 real files remain** — NOT the 15/16 earlier revisions of this box claimed.
>   That figure came from a single-line grep that cannot see `sqlite\n  .prepare(`,
>   the dominant formatting here. Real total: **261 statements across 27 files**.
>   §7 has the corrected breakdown and the count that is actually safe to run.
> - **Three real concurrency bugs were found and fixed** — two EXDATE lost updates
>   and an inverted advance-after-commit invariant (§3). None were pre-existing;
>   all three were defects the port itself would have introduced.
> - **The app still runs on SQLite.** Nothing about the running system changed.
>   `STORE_BACKEND` is still opt-in and inert.
> - **Parts 25–30 are DONE**: objectives, patterns-place, calibration, the memory
>   pair, flags, and the four connector/copy files that closed wave 5. Do not redo
>   them. §6 records what those ports decided.
>   **Wave 6 is now UNBLOCKED**: every one of its seven files reached
>   `engine/autoplan.ts` (wave 7), which was still synchronous, so wave 6 could not
>   be started incrementally at all. Autoplan was ported early as part 31 to break
>   that — see the deadlock note in `passA-worklist.md`. **Start here: WAVE 6** —
>   block-task-sync (21), day-types (17), reminders (14), sync/apply (7),
>   pattern-blocks (5), recurrence-generate (5), pattern-prefs (4). Take
>   `sync/apply.ts` deliberately: it retires the last raw-handle argument from seven
>   already-ported files in one go.
> - **The trap catalogue lives in `docs/passA-worklist.md`, not here.** Read it
>   before your first edit. This document is the narrative; that one is the
>   checklist you work from.

Companion to `docs/HANDOFF-2026-08-02-oidc-and-postgres-port.md` (the foundation)
and `docs/passA-worklist.md` (the live tracker).

---

## 1. Where the work is

| | |
|---|---|
| Worktree | `.claude/worktrees/open-branch-handoff-ci-planning-d935d0` |
| Branch | `feat/postgres-cutover` |
| Ahead of main | 45 commits |
| This session | 29 commits — 17 `refactor(db)` slices covering 20 files, 12 `docs(db)` tracker updates |

---

## 2. What shipped

Wave 4 closed at 26 files. Wave 5 is 8 of 17 (see §7 — the "of 11" in earlier
revisions dropped six wave-5 files the single-line grep could not see).

| Part | Files | Note |
|---|---|---|
| 8 | blocks-place + blocks-recur + services/blocks | fused — blocks.ts calls both engines |
| 9 | engine/review | |
| 10 | engine/clear-range | |
| 11 | engine/auto-defense | `requestReplan` kept its sync fire-and-forget signature |
| 12 | agents/ingest | |
| 13 | agents/sync | |
| 14 | agents/plan | |
| 15 | engine/recurrence-ops | second EXDATE race closed |
| 16 | engine/deps | |
| 17 | services/task-promotion | |
| 18 | services/patterns | 3 implicit-atomicity sequences → transactions |
| 19 | services/tasks | **closes wave 4** |
| 20 | motivation + series-scope | opens wave 5 |
| 21 | services/triality-vector | 9 module-level prepares cleared |
| 22 | services/triality | |
| 23 | agents/groom + services/possibles | circular pair, one commit |
| 24 | services/task-close | last wave-5 module-level prepare |

The agents files turned out **not** to be interdependent, contrary to the plan —
they shipped separately. `groom`/`possibles` genuinely are circular and had to
ship together.

---

## 3. Three real bugs the port would have introduced

These are the reason pass A is worth doing carefully rather than mechanically.

**Two EXDATE lost updates** — `blocks-recur.excludeBlockOccurrence` and
`recurrence-ops.skipInstance`. Both read a JSON array of excluded dates, appended
one, and wrote it back. Race-free only because better-sqlite3 put no await between
the read and the write. With one, two concurrent occurrence deletes on the same
template both read the old list and the second write drops the first's date — so
the occurrence the user just deleted comes straight back on the next read. Closed
with a portable compare-and-swap (`COALESCE(col,'') = ?` guard, bounded retry,
throw rather than silently skip). `recurrence-ops` reuses the pattern as
`appendTemplateExdate`.

**An inverted advance-after-commit invariant** in `agents/sync.syncConnector`.
Making `applyInbound` async left the call unawaited, so the entire inbound calendar
reconcile ran detached while `writeCalendarCursor` persisted the next syncToken
immediately after. That inverts the guarantee the function documents in its own
comment: the cursor would advance past events whose writes had not landed, so a
crash would **skip** events rather than reprocess them. tsc saw only the one
neighbouring line where the cursor's type was consumed.

---

## 4. Decisions made deliberately, with reasons

Each is also commented at the code site.

**`requestReplan` stayed synchronous** (part 11). Its only DB read was the
`auto_defense_enabled` gate, so the gate moved into the async `fireReplan` behind
the debounce timer. Going async instead would have turned 21 fire-and-forget
trigger sites into awaits for nothing — the same reasoning that keeps `writeAudit`
floating. Evaluating the gate at fire time is also slightly more correct.

**`groom`'s sqlite-vec KNN path stays on the raw handle** (part 23). It builds a
`vec0` virtual table and runs a `MATCH` query; Postgres has no counterpart short of
pgvector. Handoff §6 deletes sqlite-vec at cutover, and the cosine fallback beside
it already makes identical keep/drop decisions — so the function is slated for
deletion, not translation. Routing it through the facade would be churn on dead
code and would imply it is backend-agnostic when it can only ever run on SQLite.

**`patterns.ensureHabitPattern` keeps a residual race** (part 18). Its idempotency
probe looks for a membership row the writer has not created yet, so two concurrent
calls can both pass it. No single-statement guard fixes a predicate that depends on
the writer's own later row — it needs a unique index, i.e. a schema change, which a
refactor pass should not smuggle in. Consequence is a duplicate habit pattern under
a double-submit, not data loss.

**Two Gmail read-modify-writes left unguarded** (part 12). `advanceGmailSince` and
`deadLetterGmail` have the same shape as the EXDATE bug, but losing those races
costs a reprocess (idempotent on `source_ref` — the documented crash behaviour) and
one id dropped from a diagnostic list. Neither destroys user data. Both want the
write folded into their `ON CONFLICT` clause post-cutover.

---

## 5. Method — what actually works

Per file: port statements → **untruncated** `tsc` → **full-symbol grep over src and
test** → awaits + asyncify enclosing `it()` callbacks → focused tests → serialized
full-suite gate → commit.

The grep is not optional. Across this session tsc missed roughly a dozen real
breaks, because in Koa `ctx.body` is `any`, in GraphQL resolvers a returned promise
is legal, and an unawaited **void-returning** call is invisible to both the
compiler and the return-type check. Every one came out of the symbol grep.

**Never window tsc's output.** `tail -12` hid four of five affected files on the
clear-range slice and nearly led to a wrong conclusion. `head` has the same
problem. Pipe through `grep "error TS"`.

Two test shapes **fail open** — green while testing nothing:

- `expect(() => f()).toThrow()` passes vacuously once `f` is async; the call
  rejects rather than throws. Use `await expect(f()).rejects.toThrow(…)`.
- `await f(...).prop` parses as `await (f(...).prop)` — the property is read off
  the *pending* promise, yielding `undefined`, which is then awaited. Needs
  `(await f(...)).prop`. This one wants a **paren-aware inserter, not a regex**:
  the triality tests had `expect(f(...))`, `expect(f(...).changed)` and
  `return f(...).F` on adjacent lines, and only the last two take parens.

Also: `vi.advanceTimersByTime` silently stops working once the timer callback is
async — use `advanceTimersByTimeAsync`. And if you asyncify `it(` callbacks with a
regex, exclude ones already marked async or you get `async async () => {` (that
produced 21 broken callbacks in one pass).

`docs/passA-worklist.md` carries the full catalogue, including the silent-break
shapes (`.filter`/`.every` with async predicates, `.map` returning promises,
`forEach` discarding them entirely) and the implicit-atomicity rules.

---

## 6. `services/objectives.ts` — DONE (part 25)

The survey that used to live here has been spent. 905 lines, ~50 raw references, 25
exported functions. Cascade: routes/objectives (12 sites),
graphql/objective-resolvers (11), services/task-promotion (3),
graphql/task-resolvers (1), routes/sync (1), and 7 sites in sync-apply.test.ts.

**Two check-then-write guards were re-asserted as part of the write**, since an
await now separates each from what it protects and a transaction does not close
that under Postgres READ COMMITTED. `createObjective`'s live-parent check became an
`INSERT … SELECT … WHERE EXISTS`; the unguarded `VALUES` form is kept for the
parentless case, because `id = NULL` matches nothing and an EXISTS guard there
would refuse every root objective. `archiveObjective`'s root UPDATE is guarded on
`archived_at IS NULL`, with the audit gated on `changes > 0` to match the
idempotent early return that also writes none.

**Two races were deliberately left open**, documented at their sites, on the same
reasoning as `ensureHabitPattern` in §4 — both need a schema change, not a
refactor:

- `linkObjectiveTask` can insert a duplicate join row under a double-submit.
  `objective_tasks` has no unique index on (objective_id, task_id), only on the
  surrogate `id`, and the predicate concerns a row the call has not written yet —
  so `WHERE NOT EXISTS` races exactly as the SELECT does.
- `updateObjective`'s three re-parent guards can each pass concurrently. The
  `cycle` one is the one that matters: A→B and B→A both commit, and the resulting
  parent loop does not terminate the `UNION ALL` recursive CTEs in
  `heightBelow`/`wouldCycle`. That needs the writers serialized, not a better
  WHERE clause.

**Three breaks tsc could not see**, all found by the symbol grep §5 insists on:
`task-promotion` built its link ids with `.map` over a now-async call (would have
broadcast `[object Promise]` as the link id — the payload is `unknown`, so it
typechecks); `routes/objectives` assigned two unawaited promises straight to
`ctx.body`, which Koa serializes as `{}`; `routes/sync` floated
`applySyncedObjectiveUpkeep`, detaching the archive cascade from the transaction
that must contain it. One test failed OPEN — `expect(() =>
applySyncedObjectiveUpkeep(…)).not.toThrow()` — rewritten as `await
expect(f()).resolves.toBeUndefined()`.

**A new dialect-portability case**: the guarded INSERT is new SQL, so it is pinned
in `test/store-conformance.test.ts` and asserted on BOTH backends rather than left
to surface at the flip. Verified against a real Postgres 17 + pgvector. Add a
conformance case whenever a slice introduces a SQL shape the existing statements do
not cover.

**Next: `engine/patterns-place.ts`, then `connectors/memory` + `services/memory`,
which close wave 5.** Note `patterns-place.ensurePatternsForRange` is still called
**unawaited** from `services/blocks.blockRowsForQuery` — the one call site left
deliberately sync back in part 8. Add the await when it ports.

---

## 7. What remains, and how to count it

Do not trust the per-wave file lists. Re-derive:

```
grep -rn "sqlite\.\(prepare\|exec\|transaction\)" server/src --include=*.ts | wc -l
```

**The bare grep above is NOT safe** — it is single-line only, and misses

```ts
const rows = sqlite
  .prepare(`…`)
```

which is how most statements in this codebase are written. It under-reported by
46%, and it under-reported in the direction that makes the work look finished.
Use a multi-line-aware count:

```
python3 -c "
import re,subprocess,pathlib
fs=subprocess.run(['bash','-c','grep -rl sqlite --include=\"*.ts\" server/src --exclude-dir=migrations'],capture_output=True,text=True).stdout.split()
print(sum(len(re.findall(r'sqlite\s*\.\s*(?:prepare|exec|transaction)', pathlib.Path(f).read_text())) for f in fs))"
```

At this commit: **261 statements across 27 files**. Three are the seam
(`db/index.ts`, `db/pg.ts`, `db/store.ts`) and one is `groom.ts`'s deliberate
sqlite-vec residue (§4) — so **23 real files remain**:

- **Wave 5 (9, 54 stmts)** — patterns-place (13), connectors/memory (9),
  services/memory (6), calibration (14), render-copy (3), connectors/base (3),
  connectors/index (2), mcp/client (2), flags (2)
- **Wave 6 (7, 73)** — block-task-sync (21), day-types (17), reminders (14),
  sync/apply (7), pattern-blocks (5), recurrence-generate (5), pattern-prefs (4)
- **Wave 7 (6, 117)** — tags (60), autoplan (47), category-prefs (4),
  crypto/index (4), scheduler (1), models (1)
- **Wave 8 (1, 4)** — routes/sse

**Earlier revisions of this section cleared eight files** — render-copy,
connectors/index, calibration, flags, mcp/client, connectors/base, scheduler,
models — as holding no raw statements. **Every one of them does.** They were
invisible only to the single-line grep. `engine/scheduler.ts` is the one to note:
a single statement, but `dayObstacles` is called from autoplan, patterns-place and
the flight plan, so it is a hub, not a leaf.

The ORIGINAL wave table in `passA-worklist.md` was correct all along — its wave
6/7/8 totals (73/117/4) match a proper count exactly, because it was built with a
multi-line-aware script. Trust that table over any hand grep.

### Two files to plan around

**`services/tags.ts` (wave 7) is the mountain: 44 module-level prepared
statements** — more than three times all of wave 5 — on top of 9+ importers. Every
one must become a module-scope SQL string plus an in-function `store().prepare`,
because a module-level `store().prepare` throws `"store not initialised"` at import
time for any module loaded before boot installs the backend. Mechanical but long.
Do not bundle it with anything.

That trap does **not** reliably fail the suite — whether it throws depends on module
import order in a given test — so fix them on sight rather than waiting for red:

```
grep -rn "^const .*sqlite\.prepare" server/src --include=*.ts
```

**`sync/apply.ts` (wave 6) pays a debt.** Every remaining raw `sqlite` import in an
already-ported file exists solely to hand `stampRow`/`applyOp` a handle. Porting it
removes the last raw-handle argument from routes/sync, routes/blocks,
engine/extend-block, engine/review, services/blocks, services/tasks and
services/task-promotion in one go.

---

## 8. After wave 8

Unchanged from the original plan (handoff §6 items 4–7): flip `test/helpers.ts`
`resetDb`, then `STORE_BACKEND=postgres`, fix the dialect deltas, delete
better-sqlite3 / sqlite-vec / Drizzle and the 147 SQLite migrations, and write the
one-shot data exporter before any deployed install can cut over.

Dialect deltas found so far: 43 `INSERT OR IGNORE`, 3 `INSERT OR REPLACE`, 20
`strftime`, 3 `julianday`, 2 `lastInsertRowid`, plus **`PRAGMA table_info`** in
`engine/series-scope.ts` `forkSeriesAt` and `triality-vector.motivationColumnExists`
— Postgres needs `information_schema.columns`.

Deferred cleanups, all documented at their sites: the two Gmail read-modify-writes
(§4), `ensureHabitPattern`'s residual race (§4), and the `enrichApi` rationale N+1
in `services/blocks` (one query per block — free on SQLite, a round trip each under
Postgres; batching it is a behaviour change, so it belongs after the cutover).
