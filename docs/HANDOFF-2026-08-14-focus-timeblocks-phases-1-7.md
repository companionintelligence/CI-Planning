# Handoff — CI-Planning: Focus × Time Blocks, phases 1–7 merged → 8, 9 open

For whoever picks this up — human or agent. Everything here is verifiable from the
repo and the linked plan; nothing depends on the session that wrote it.

Full plan: **https://claude.ai/code/artifact/a92ca82a-32e9-4955-b474-566c3fc7e542**

## Where things stand

Main is at `6b24e7e`, and **`pnpm test` is fully green there** — measured, not
assumed: server **3083 passing** / 236 files, client **1046 passing** / 81 files,
`tsc` clean on both. All seven plan decisions are resolved; nothing is blocked.

The long-standing flaky `triality-routes` test is also gone — it turned out to be a
real product bug, not test interference: the novelty embedder was not gated on
readiness, so `N` was a coin flip ([#552](https://github.com/companionintelligence/CI-Planning/pull/552)).
Worth remembering the next time a test looks "just flaky".

| Phase | State | PR |
| --- | --- | --- |
| 1 — the lock model | merged | [#547](https://github.com/companionintelligence/CI-Planning/pull/547) |
| 2 — Focus sections | merged | [#548](https://github.com/companionintelligence/CI-Planning/pull/548) |
| 3 — add into a block | merged | [#549](https://github.com/companionintelligence/CI-Planning/pull/549) + fixes in-branch |
| 4 — Calendar containment | merged | [#544](https://github.com/companionintelligence/CI-Planning/pull/544) |
| 5 — auto-nest on create | merged | [#545](https://github.com/companionintelligence/CI-Planning/pull/545) |
| 6 — mobility ladder | merged | [#550](https://github.com/companionintelligence/CI-Planning/pull/550) + [#551](https://github.com/companionintelligence/CI-Planning/pull/551) |
| 7 — day-type reflow | merged | [#553](https://github.com/companionintelligence/CI-Planning/pull/553) |
| 9 — open time stays honest | PR open | [#556](https://github.com/companionintelligence/CI-Planning/pull/556) |
| L02-first placement (was unowned) | PR open | [#557](https://github.com/companionintelligence/CI-Planning/pull/557) |
| 8 — the learning parse LLM | PR open | [#558](https://github.com/companionintelligence/CI-Planning/pull/558) |

**Every item in this handoff now has a PR.** The three below are the original
write-up, kept as written; what each one turned out to involve is in *What the last
three found* at the bottom.

## Start here — the three open items

### 1. Phase 9 (half a day, lowest risk)

`OpenTimeSummary` already subtracts every block, so "timeblocks are not open time" is
true **by accident**. Extract the busy-interval builder into
`client/src/lib/open-time.ts` (`busyFromBlocks`) and pin it: a timeblock counts as
busy even when empty; a member inside a timeblock does not double-subtract
(`mergeRanges` already guarantees that — the test makes it load-bearing).

### 2. The L02-first placement ordering (unowned, small, keeps slipping)

Phase 5 nests at **create** time. Making the *autoscheduler* prefer a matching Time
Block over a bare L01 window is a separate `autoplan` change. The plan mentions it
inside phases 5 and 7; it shipped with neither, and Phase 7 deliberately did not
touch autoplan's window placement. It belongs there. **Do this before Phase 8** — it
is small, and it is the last piece of the L02 story.

### 3. Phase 8 (3–4 days, the biggest remaining)

The parse/classify LLM gets better at life-balance category and me/us/them, learning
from corrections via retrieval few-shot over a per-owner correction log
(nomic-embed + sqlite-vec, both present), batch-calibrated in the `calibrate_*`
family per the `triality-learning.ts` house contract: never online, bounded,
measured by the existing rubric harness. Read that file's header first — it is the
contract, not a suggestion.

## Known gaps in what shipped

Two things Phase 7 did **not** deliver. Neither is a bug; both are places a reader of
the plan would reasonably expect more:

- **LLM-authored reflow proposals are not wired.** The plan makes this optional — an
  LLM *may* author, but a deterministic validator must decide and the deterministic
  engine is the fallback. What shipped is that contract. An LLM author would have to
  produce something `proposeDayReflow` could ratify.
- **Phase 7 was never driven in a browser.** Port 3848 was held by another instance
  of the app (the systemd service in `.claude/launch.json`), so the HTTP routes were
  exercised with curl on port 3901 instead and the UI rests on 11 component tests.
  That is weaker than phases 2–4 got, on the phase with the most regression risk. If
  you touch the reflow UI, drive it properly — see *Verifying* below.

## What each shipped phase left behind

- **1 — lock.** `LockToggle` (drawer BlockPanel, Planner entity card, Focus section
  headers); the pure decision is `client/src/lib/lock.ts`. A synced event renders
  **no control** — its source line instead. Server: migration 0148 backfills
  `is_locked` on inbound mirrors, and `inbound_readonly` now rejects unlocking one.
- **2 — Focus sections.** `client/src/lib/focus-sections.ts`. Members travel WITH
  their section; an empty container is not "all done"; **identity stability is part
  of its contract** (see the lesson below).
- **3 — add into a block.** `SectionAddTask` + `client/src/lib/focus-add.ts`, reusing
  `POST /blocks/:id/add-tasks` so Focus and the Time-Block modal cannot drift.
- **4 — Calendar containment.** `splitContainment` / `chipFrame` in `CalendarGrid`;
  conflict is cluster width **within a pass**.
- **5 — auto-nest.** `server/src/services/auto-nest.ts`, called from `createBlock`
  (REST *and* GraphQL). Engine paths insert directly and are untouched.
- **6 — mobility ladder.** `server/src/engine/mobility.ts` — the single home for
  "which blocks may the engine move".
- **7 — day-type reflow.** `engine/day-conflicts.ts` (detect, pure core),
  `engine/day-reflow.ts` (propose/apply), `routes/day-reflow.ts`,
  `components/DayReflowBanner.tsx`.

## Three places the plan's text did not survive contact with the code

Do not read the plan as gospel on these:

- **`time_blocks.category_id` is retired** (migration 0135). The plan's decision 4
  matches on it; categories live in `entity_categories`, and a block's effective set
  is its own rows else its task's (`blockCategoryNames`).
- **The L00 lock does not land in `sync/apply.ts`.** That is the device-sync LWW
  writer. Calendar ingest is `agents/sync.ts`, and it has stamped `is_locked = 1`
  since before the multi-tenant migration — so Phase 1's real work was the backfill.
- **Phase 7's detect is server-side, not a `lib/open-time.ts` sibling.** There is no
  shared package, and duplicating window arithmetic across client and server is the
  drift Phase 6 removed.

## Lessons that cost real time — read before verifying anything

Phase 3 merged with **three defects that all passed their unit tests**, and Phase 6
merged with **two duplicate predicates and a silent type trap**. The pattern is the
same each time: the check was narrower than the failure.

- **Verify longer than the failure window, and adversarially.** A 30-second timer
  wiped the Focus add box; every check ran under 30 seconds. A create-duplicate race
  hid behind a 1.2-second pause after typing. Type fast, wait out timers, and assert
  on focus and element identity — not just visible text.
- **jsdom never remounts a component on its own.** Anything depending on remount has
  to be tested by explicitly unmounting and re-rendering, or in the app. An add fires
  **two** refetches (blocks and tasks are separate resources), so a section remounts
  more than once.
- **Grep for the shape, not the string.** Phase 6 missed two copies of a predicate
  because they wrote the same conjunction in a different column order.
- **A structural type with all-optional fields is a silent trap.** `mobility()`
  accepted camelCase drizzle rows and returned `manual` for everything — no type
  error, no test failure. If a helper takes a row, make it read both casings or make
  the fields required.
- **Review before opening the PR, not after.** Phase 7 did, and it caught the
  unconfigured-L01 false alarm and a `serverTimezone()`/`ownerTimezone()` bug that
  would have mis-scheduled every non-server-timezone owner.
- **A test fixture can share the bug's blind spot.** Phase 7's "Light day" fixture
  had no windows for *any* direction, making it indistinguishable from an
  unconfigured install — it would have passed either way. Fixtures must distinguish
  the cases they claim to.

## Code map (verified locations, may drift)

| What | Where |
| --- | --- |
| Day-type conflicts (detect) | `server/src/engine/day-conflicts.ts` — `strandedBlocks` (pure), `detectDayConflicts`, `windowsForDate` |
| Reflow propose/apply | `server/src/engine/day-reflow.ts` — `proposeDayReflow` (pure read), `applyDayReflow` (recomputes; the only mutator) |
| Reflow endpoints | `GET /api/days/:date/conflicts`, `GET /api/days/:date/reflow/preview`, `POST /api/days/:date/reflow/apply` |
| Conflict UI | `client/src/components/DayReflowBanner.tsx`; red treatment keys off `conflictedBlockIds` in `stores/index.ts` |
| Mobility ladder | `server/src/engine/mobility.ts` — `mobility()`, `MOBILITY_RANK`, `AUTO_PLACED_SQL`, `REFLOW_CANDIDATE_SQL` |
| Auto-nest on create | `server/src/services/auto-nest.ts` — `chooseContainer` (pure), `resolveAutoNestParent` |
| A block's effective categories | `blockCategoryNames(blockId, taskId)` (`services/blocks.ts`) |
| Membership | `parent_block_id`; `isValidParent` (`services/blocks.ts:261`) — parents must be `block_kind='timeblock'` |
| Calendar containment | `client/src/components/CalendarGrid.tsx` — `splitContainment`, `chipFrame`, `CONTAINER_EDGE_PX` |
| Focus grouping / add box | `client/src/lib/focus-sections.ts`, `client/src/lib/focus-add.ts` |
| Lock affordance | `client/src/components/LockToggle.tsx` + `client/src/lib/lock.ts` |
| Owner's planning timezone | `ownerTimezone(owner)` in `engine/recurrence-generate.ts` — **use this, not `serverTimezone()`** |
| Open time (Phase 9's target) | `client/src/components/OpenTimeSummary.tsx` + `client/src/lib/open-time.ts` |
| Phase 8's grounding | `services/task-enrich.ts`, `services/triality-learning.ts` (the house contract), `engine/quickadd.ts` |

## Running the app / verifying

```bash
pnpm install && pnpm dev   # API :3848, client :5173 — no config, no login (AUTH_MODE=test)
```

Headless verification (no Playwright; `chromium` + CDP over the built-in Node
`WebSocket`):

```bash
chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --disable-extensions \
  --user-data-dir=/tmp/prof --remote-debugging-port=9222 --hide-scrollbars &
# then drive http://127.0.0.1:9222/json/version via CDP; screenshot + Runtime.evaluate
```

Gotchas, worst first:

- **Port 3848 may already be taken** by the systemd instance of this app. Symptom:
  every endpoint 401s and `pnpm dev` logs `EADDRINUSE`. Do **not** kill it — run the
  API on another port (`PORT=3901 npx tsx src/index.ts`) and point your checks there.
- **CalendarGrid tests mock `../stores/index.js`.** Any new store read by the
  component must be added to **every** mock or the module throws on import. This has
  bitten twice. `connectionPrefs` is deliberately absent — it is only read for blocks
  with `source_provider` **and** `source_account`, so fixtures must leave those unset.
- For "works from the keyboard" claims, drive **real** CDP `Input` events
  (`insertText` + `dispatchKeyEvent`), not synthetic DOM events.
- `--virtual-time-budget` **hangs** against Vite's HMR websocket. Navigate, wait,
  capture. `chromium --screenshot` fires at the load event — too early for the SPA.
- `pnpm --filter client dev -- --host X` silently drops the flag; use
  `pnpm --filter client exec vite --host X`.
- Uppercase-transformed text (`.pill`, the Day/Week/Month tabs) comes back uppercase
  from `innerText`/`textContent` — match case-insensitively.
- `date -d "…" -u` on this box does not shift local→UTC as expected when building
  fixture timestamps; compute them in Node.
- `DELETE /api/tasks/:id` is a **soft** delete (status → `cancelled`).
- **Never run `applyDayReflow` against the owner's dev database** to "see it work" —
  it moves and deletes real blocks. Seed a block, verify, delete it; or use the tests.

## What the last three found

Written after the fact, in the same spirit as the lessons above — each of these was a
surprise, not something the plan predicted.

- **Phase 9 (#556) was not a refactor.** Lifting the busy-interval builder out of
  `OpenTimeSummary` surfaced that it disagreed with the two predicates the client
  already had for "does this block hold minutes" (`isSlotOccupied`, the wizard's gap
  finder). Open time subtracted all-day rows, someday concepts and cancelled work,
  none of which the others count — an all-day row's `end_at` is start + duration, so
  subtracting it deleted hours nothing was using. The rule now has one home,
  `occupiesMinuteAxis` in `overlay.ts`.
- **L02-first (#557) was blocked on `block_type`.** The two Plan passes in `autoplan`
  both require `block_type = 'scheduled'`, which only the Element wizard writes; every
  other creation path leaves it NULL, and `auto-nest` accepts NULL happily. So a
  container the owner could nest into by hand was invisible to the autoscheduler. Four
  such rows exist in the owner's own database. `dayObstacles` keys on the same value
  and was left alone — see that PR's closing note.
- **Phase 8 (#558) needed the plan's acceptance test to set the constant.** The
  learning floor was written at 5 by analogy with `OUTCOME_FLOOR = 20`, which
  contradicts the plan's own "correcting twice makes the third similar input classify
  correctly". It is 2, and a test asserts the constant so raising it fails loudly.

Two more verification lessons, both earned the hard way:

- **Mutate the source to check a test.** Every claim in these three PRs was checked by
  breaking the code and confirming the intended test failed. It caught two tests that
  could not fail: a "does not double-subtract" fixture that passed under every mutant
  (`mergeRanges` collapsed the overlap before the code under test saw it), and an
  untested day-clamp. Both were rewritten rather than shipped as decoration.
- **uuid7 ties are random within a millisecond.** A test fixture that writes rows in a
  loop gives them all the same `assigned_at`, so any `ORDER BY ts, id` read falls
  through to uuid7's random within-ms bytes. Phase 8's tests passed alone and failed in
  the suite until every fixture row got a distinct timestamp. If a read's order matters,
  the fixture must make it total.

## Open questions for the owner

None. All seven plan decisions are resolved.
