# Handoff — CI-Planning: Focus × Time Blocks, the whole wave is merged

For whoever picks this up — human or agent. Everything here is verifiable from the
repo and the linked plan; nothing depends on the session that wrote it.

Full plan: **https://claude.ai/code/artifact/a92ca82a-32e9-4955-b474-566c3fc7e542**

## Where things stand

**Every phase is merged, and the two items the plan left unowned with them.** Nothing
in this wave is open.

Main is at `ef6f941`, and **`pnpm test` is fully green there** — measured, not
assumed: server **3153 passing** / 241 files, client **1056 passing** / 81 files,
`tsc` clean on both. All seven plan decisions are resolved.

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
| 9 — open time stays honest | merged | [#556](https://github.com/companionintelligence/CI-Planning/pull/556) |
| L02-first placement (was unowned) | merged | [#557](https://github.com/companionintelligence/CI-Planning/pull/557) |
| 8 — the learning parse LLM | merged | [#558](https://github.com/companionintelligence/CI-Planning/pull/558) |
| Time Blocks hold their slot (fell out of 557) | merged | [#559](https://github.com/companionintelligence/CI-Planning/pull/559) |

## If you are picking this up next

There is no open work in this wave. The two things a reader of the plan might still
expect are in *Known gaps* below, and neither is a bug: LLM-authored reflow proposals
are optional and unwired, and Phase 7's UI still rests on component tests.

The most likely reason to be here is that you are touching one of these areas and want
to know what the shape is. Start with *What each shipped phase left behind* and the
code map; read *Lessons* before you verify anything, because most of them were paid
for twice.

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
  you touch the reflow UI, drive it properly — see *Verifying* below. (Phase 9 was
  driven properly, on 3901, with the API response intercepted rather than the database
  seeded — that recipe is under *Verifying* and works around the same held port.)

Phase 8 added two of its own, both stated in [#558](https://github.com/companionintelligence/CI-Planning/pull/558):

- **No client chart for the accuracy trend.** The per-run numbers are in the Jobs run
  log and at `GET /api/classification/accuracy`; a chart wants a design.
- **The rubric scorer asks the classification question in isolation** — same rubric,
  same exemplars, no memory graph. An old held-out task's graph context is
  unreproducible, so scoring the full enrichment prompt would measure drift in the
  graph rather than in the exemplars, which are the only thing learning changes.

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
- **8 — the learning parse LLM.** `services/classification-learning.ts` is the whole
  contract (capture, evidence, retrieval, calibration); `classification-score.ts` is
  the grader. Three tables — `classification_log` is the durable evidence and the only
  thing that cannot be recomputed. Capture hangs off three seams: quick-add and
  `task-enrich` log what the model claimed, `updateTask` records the owner's answer.
- **9 — open time stays honest.** `busyFromBlocks` in `client/src/lib/open-time.ts`,
  and `occupiesMinuteAxis` in `client/src/lib/overlay.ts` — the one home for "does
  this block hold minutes", which click-to-create reads too.
- **L02-first.** `placeIntoContainers` (Pass 1.9) in `engine/autoplan.ts`, matching on
  the phase-5 rule via `preferredContainers` / `coordsMatch` in `services/auto-nest.ts`.
- **Holds its slot.** `PLACED_TIMEBLOCK_SQL` in `engine/mobility.ts` — one fact ("this
  Time Block is actually on the timeline") behind both questions anyone asks of a
  container: does it hold its slot (`dayObstacles`, `extend-block.ts`) and may it
  receive a member (`auto-nest.ts`). It was `HOLDS_SLOT_SQL` until auto-nest's own copy
  was folded into it.

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
| Mobility ladder | `server/src/engine/mobility.ts` — `mobility()`, `MOBILITY_RANK`, `AUTO_PLACED_SQL`, `REFLOW_CANDIDATE_SQL`, `PLACED_TIMEBLOCK_SQL` |
| "Is this Time Block on the timeline" | `PLACED_TIMEBLOCK_SQL` (mobility.ts) — the ONE predicate behind "holds its slot" (`dayObstacles` in `engine/scheduler.ts`, `engine/extend-block.ts`) and "may receive a member" (`services/auto-nest.ts`). **Not** `block_type = 'scheduled'`, which only the wizard writes |
| Auto-nest on create | `server/src/services/auto-nest.ts` — `chooseContainer` (pure), `resolveAutoNestParent` |
| The nest rule, without time | `coordsMatch` / `preferredContainers` (auto-nest.ts) — shared by create-time nesting and the autoscheduler |
| L02-first autoscheduling | `placeIntoContainers` (Pass 1.9) in `engine/autoplan.ts`, between the hint pass and the direction windows |
| A block's effective categories | `blockCategoryNames(blockId, taskId)` (`services/blocks.ts`) |
| Membership | `parent_block_id`; `isValidParent` (`services/blocks.ts:261`) — parents must be `block_kind='timeblock'` |
| Calendar containment | `client/src/components/CalendarGrid.tsx` — `splitContainment`, `chipFrame`, `CONTAINER_EDGE_PX` |
| Focus grouping / add box | `client/src/lib/focus-sections.ts`, `client/src/lib/focus-add.ts` |
| Lock affordance | `client/src/components/LockToggle.tsx` + `client/src/lib/lock.ts` |
| Owner's planning timezone | `ownerTimezone(owner)` in `engine/recurrence-generate.ts` — **use this, not `serverTimezone()`** |
| Open time | `client/src/lib/open-time.ts` — `busyFromBlocks`, `openTime`; rendered by `components/OpenTimeSummary.tsx` |
| "Does this block hold minutes" (client) | `occupiesMinuteAxis` in `client/src/lib/overlay.ts` — read by open time AND click-to-create (`lib/create-click.ts`) |
| Classification learning | `services/classification-learning.ts` (the contract), `services/classification-score.ts` (the grader), `routes/classification.ts` |
| Its evidence | `classification_log` (durable), `classification_exemplars` (regenerable index), `classification_accuracy` (migrations 0149/0150) |
| Learning house contract | `services/triality-learning.ts` — read its header before writing any learning loop |

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
- **Better than seeding: intercept the response.** To see the UI handle data the dev
  database does not contain, enable CDP `Fetch` with `requestStage: 'Response'` on
  `*/api/blocks*`, `Fetch.getResponseBody`, splice rows into the JSON, and
  `Fetch.fulfillRequest`. The real component renders real data plus your fixture, and
  the owner's database is never written to. Phase 9 was verified this way, including a
  before/after A-B against the pre-change builder (patch the component, re-run, restore).

## What the last four found

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
  such rows exist in the owner's own database.
- **Phase 8 (#558) needed the plan's acceptance test to set the constant.** The
  learning floor was written at 5 by analogy with `OUTCOME_FLOOR = 20`, which
  contradicts the plan's own "correcting twice makes the third similar input classify
  correctly". It is 2, and a test asserts the constant so raising it fails loudly.
- **The same `block_type` assumption was in the obstacle set too (#559).** `dayObstacles`
  and `extend-block.ts` both wrote the ladder's `holds` rung by hand as
  `block_type = 'scheduled'`, so a Planner-drawn Time Block held no slot and the engine
  placed straight through it — in the file whose own header says the ladder lives there
  once because near-identical WHERE clauses drift. It had drifted. Widening it also
  needed three explicit exclusions (someday, all-day, recurrence templates), or the fix
  would have started blocking time nothing uses — the inverse of the Phase 9 bug.

Three more verification lessons, all earned the hard way:

- **Mutate the source to check a test.** Every claim in these four PRs was checked by
  breaking the code and confirming the intended test failed. It caught three tests that
  could not fail: a "does not double-subtract" fixture that passed under every mutant
  (`mergeRanges` collapsed the overlap before the code under test saw it), an untested
  day-clamp, and an embedder readiness gate that no test reached because every fixture
  injected an embedder. All three were rewritten rather than shipped as decoration.
- **Per-PR green says nothing about the combination.** #557 and #559 were each green
  alone and failed together: #559's fixtures gave a container the same direction as the
  task, so once #557's L02-first pass existed that container CLAIMED the task and the
  overlap became legitimate. Found by merging all four into a throwaway branch and
  running the suite BEFORE anything landed on main. A test can encode an assumption
  about what else exists in the tree.
- **uuid7 ties are random within a millisecond.** A test fixture that writes rows in a
  loop gives them all the same `assigned_at`, so any `ORDER BY ts, id` read falls
  through to uuid7's random within-ms bytes. Phase 8's tests passed alone and failed in
  the suite until every fixture row got a distinct timestamp. If a read's order matters,
  the fixture must make it total.

## Open questions for the owner

None. All seven plan decisions are resolved.
