# Handoff — CI-Planning: drawer UI (shipped) → Focus × Time Blocks (planned)

For whoever picks this up — human or agent. Everything here is verifiable from the
repo and the linked docs; nothing depends on the session that wrote it.

## Where things stand

**Shipped to main** (PR [#538](https://github.com/companionintelligence/CI-Planning/pull/538), merged as `2671743`):
the drawer layout — collapsible nav rail (208→60px), docked resizable details
drawer with a Planner tab on Today, open-time summary in Today's header, and an
env-driven `VITE_ALLOWED_HOSTS` for named dev-server access.

**Merged** (PR [#542](https://github.com/companionintelligence/CI-Planning/pull/542), four commits):

- `5b6169b` — one block colour in both views (`blockColorVar` everywhere; the
  Calendar's per-kind palette and 15%-alpha tint removed); Planner band hatch
  dropped, outline kept.
- `1aaee65` — the drawer describes every view's entities: `activeEntity` joins the
  selection store, six new panels (tag, direction, category, day, job, dimension),
  selection wired from Calendar/Tasks/Tags/Jobs/Balance/Focus, per-view selection
  memory, clickable cross-links. Calendar chips now select into the drawer instead
  of opening the editor (mockup's read/inspect split).
- `8e23b11` — canonical view chrome: `.view-container`/`ViewHeader`/`.view-tabs`
  in one place, all seven views composed from them; Today's drawer rests on the
  Planner tab when nothing is selected, Details when something is.
- `0670600` — `.claude/launch.json` trimmed to the three used configurations.

Suite fully green: **944 passing / 73 files**; `tsc` clean.

**Not built** (explicitly): Settings connections and Focus reminders are not
selectable (no drawer panels); objectives ride the task panel (the app models them
as tasks); `PlannerEntityCard` coexists with the drawer (drawer wins while open)
rather than being consolidated; flight-plan-as-drawer-tab was built then reverted
at the owner's request — the flight-plan stays in the centre column.

## The next work: Focus × Time Blocks

Full plan: [docs/AH-focus-timeblocks.md](AH-focus-timeblocks.md) (also published at
https://claude.ai/code/artifact/a92ca82a-32e9-4955-b474-566c3fc7e542).

The owner defined the canonical scheduling model — read it before touching the
engine:

- **L00** external calendar events: locked by default, never moved, updated
  externally.
- **L01** WORK/HOME/COMMUNITY windows (day-type `pattern_blocks`): autoscheduling
  rules — a directed task is only autoscheduled inside its direction's windows.
  Day-type change → stranded tasks go alert-red → **confirmed** reflow (same-day
  first, lowest task priority dropped first, unscheduled → flight-plan, LLM may
  propose but a deterministic validator decides, user always confirms).
- **L02** Time Blocks: override L01; tasks **auto-nest** when direction AND
  life-balance category both match (`block.tag` ∩ task direction, and
  `block.category_id`'s name ∈ `task.categories`). "Priority" in the owner's
  auto-nest rule means the life-balance category — **not** P1–P3.

Nine phases, 11–16 days, in the plan — the ninth: the parse/classify LLM
(quickadd → task-enrich) gets **better at life-balance category and me/us/them
selection and learns from corrections over time**, via retrieval few-shot over a
per-owner correction log (nomic-embed + sqlite-vec, both present), batch-calibrated
in the `calibrate_*` family per the `triality-learning.ts` house contract (never
online, bounded, measured by the existing rubric harness). Recommended first move:
**Phase 4**
(Calendar containment — 1 day, fixes a visible defect where a nested task renders
as an amber *conflict* beside its own container).

**Decisions confirmed by the owner:** #4 priority = life-balance category; #5
reflow drops by task priority (P3/Later first, tie-break no-due-date then shortest
estimate); #6 L01 binds the autoscheduler only — manual placement allowed and
rendered red; #7 full Time Block falls back to windows, never auto-extends; #2
**tasks move first, Time Blocks hold their slots** (ratifies current engine
behaviour — Phase 6 is formalisation only).
#1 **synced events cannot be unlocked — they show their SOURCE instead of a lock
toggle** (provider + account from `source_provider`/`source_account`; no disabled
control, the provenance line explains the immovability).
**Recommended, awaiting confirmation:** #3 members ride along on a user's
container move (already how `move-group` behaves).

## Code map (verified locations, may drift)

| What | Where |
|---|---|
| Focus filters out timeblocks | `client/src/views/Focus.tsx:28` — `FOCUS_KINDS = {'task','focus','habit'}` |
| Membership | `parent_block_id`; guarded by `isValidParent` (`server/src/services/blocks.ts:338`) |
| Immovability | `client/src/lib/drag.ts:117` — `is_locked \|\| kind==='meeting'` |
| Reflow pinning | `server/src/engine/auto-defense.ts:111`; autoplan reprocesses only `is_auto=1, kind='task', is_locked=0` |
| Sync writer (L00 lock lands here) | `server/src/sync/apply.ts` — `is_locked` already in its column map (line 35), nothing sets it |
| Calendar overlap layout (Phase 4 target) | `client/src/components/CalendarGrid.tsx:59` `layoutBlocks`; conflict = `cols>1` |
| Planner containment to port | `client/src/components/Planner.tsx:731–738` (`isNested`, `placedChildren`), `chipFrame(…, nested)` |
| Backlog search to reuse in Focus | `client/src/components/FlightPlan.tsx:108` `backlogMatches` |
| Re-staging path for unscheduled tasks | `api.flightPlan.addTask` — used by PlannerEntityCard's delete flow |
| Open time (timeblocks count as busy) | `client/src/components/OpenTimeSummary.tsx` + pure maths in `client/src/lib/open-time.ts` (22 tests) |
| Drawer shell state | `client/src/stores/ui.ts`; entity = `activeTask/activeBlock` in `stores/selection.ts` — do **not** add a second selection store |

Schema fact that shaped the plan: `time_blocks` has **no priority column** — but
none is needed; the category linkage above covers the auto-nest rule.

## Running the app / verifying

```bash
pnpm install && pnpm dev   # API :3848, client :5173 — no config, no login (AUTH_MODE=test)
```

Tailscale-exposed dev client (the owner previews this way):

```bash
VITE_ALLOWED_HOSTS=fzzy.capybara-ulmer.ts.net,fzzy pnpm --filter client exec vite --host 100.114.164.27
```

Headless verification that works in this environment (no Playwright installed;
`chromium` binary + CDP over the built-in Node `WebSocket`):

```bash
chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --disable-extensions \
  --user-data-dir=/tmp/prof --remote-debugging-port=9222 --hide-scrollbars &
# then drive http://127.0.0.1:9222/json/version via CDP; screenshot + Runtime.evaluate
```

Gotchas that cost time, so you don't pay twice:

- `--virtual-time-budget` **hangs** against Vite's HMR websocket — never use it on
  the dev server; navigate, wait, capture.
- `chromium --screenshot` fires at the load event — too early for the SPA. Drive
  CDP and wait, or you will screenshot the loading spinner.
- `pnpm --filter client dev -- --host X` silently drops the flag (the `--` reaches
  Vite literally); use `pnpm --filter client exec vite --host X`.
- Uppercase-transformed text (`.pill`, `.group-label`) comes back uppercase from
  `innerText` — compare case-insensitively in assertions.
- CalendarGrid tests mock `../stores/index.js`; any new store read by the
  component must be added to all three mocks or the module throws on import.
- Assertions on the app were the defect-finder all along: two real bugs (duplicate
  entity card, `ESTIMATE m` with no number) and one wrong fix (removing the alpha
  tint made chips invisible because the *colour source* was the real difference)
  were caught by screenshots, not by reading diffs. Verify by driving the app.

## Open questions for the owner

Only #3 remains open (members ride along on a user's container move — recommended
yes, matches existing `move-group`). Nothing blocks starting any phase.
