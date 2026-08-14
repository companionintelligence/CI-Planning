# Focus × Time Blocks — plan

Time Blocks become first-class in the Focus view (expandable sections with inline
task add/search), the Calendar draws containment the way the Planner already does,
tasks that match a Time Block's direction and life-balance category auto-nest into
it, and the scheduling model gets an explicit mobility ladder: synced calendar
events never move, anything can be locked, Time Blocks hold their slots while
reflow shuffles tasks around them.

---

## What the codebase already provides

The plan builds on machinery that exists rather than inventing parallel systems.

| Piece | Where | State |
|---|---|---|
| Time Block containers | `block_kind='timeblock'`, members are task blocks with `parent_block_id` | Fully modelled; `isValidParent` guards the relation (`server/services/blocks.ts:338`) |
| Membership API | `api.blocks.create/update` accept `parent_block_id` | Exists — the Planner's "Removed from Time Block" action already uses it |
| Lock flag | `is_locked` on every block | Exists; reflow honours it (`auto-defense.ts:111` — "a user-pinned block holds its slot AND its task") |
| Immovability | `isImmovable = is_locked \|\| kind === 'meeting'` (`client/lib/drag.ts:117`) | Meetings are immovable **by kind hardcoding**, not by a visible lock |
| Sync writer | `server/sync/apply.ts` maps connector events onto blocks; `is_locked` is already in its column map (line 35) | Nothing sets it — synced events land unlocked-but-immovable |
| Task search over the backlog | FlightPlan's `backlogMatches` — `filterByName` over an `openTasks` resource (`FlightPlan.tsx:108`) | Reusable pattern, already handles staged-exclusion |
| Focus view | `FOCUS_KINDS = {'task','focus','habit'}` (`Focus.tsx:28`) | Timeblocks and meetings are filtered out — this one line is why they don't show |
| Open time | `OpenTimeSummary` subtracts **every** block from the day's windows | Timeblocks already count as busy — correct, but accidental and untested |

## The scheduling model — L00 / L01 / L02 (canonical)

This is how the system understands scheduling. Everything else in the plan
implements a consequence of these three layers.

**L00 — External calendar events.** Locked by default, updated externally. The
source calendar owns their time; the app never moves them. They are *facts* the
scheduler routes around.

**L01 — Direction windows (WORK / HOME / COMMUNITY).** The day type's
`pattern_blocks` windows, set in Settings or the drawer's Edit windows. They are
*rules*, not blocks: a `work`-tagged task may only be **autoscheduled** inside work
windows, `home` in home windows, `community` in community windows — per the day
type resolved for that day. Changing the day type after tasks are placed can strand
tasks outside their direction's windows: those render **alert red**, and the app
asks whether to reflow (Phase 7) — never reflows silently.

**L02 — Time Blocks.** Scheduled, but less concrete than a task and more moveable
during reflow than an L00 event. **L02 overrides L01**: a task nested in a Time
Block follows the block, not the window rule — a `#work` Time Block at 7pm is a
deliberate exception to home hours, and its members inherit that exception. Tasks
**auto-assign into a Time Block when both coordinates match**: the direction
(WORK/HOME/COMMUNITY) *and* the life-balance category (Career, Health, Leisure, …).
Placement order for autoscheduling follows: matching Time Block with room first,
then L01 windows, then unplaced.

The mobility ladder (owner-confirmed): **tasks move first, Time Blocks hold.**

```
never moves    ── L00 synced calendar event (provenance lock, on by default)
               ── anything the user locked   (is_locked)
holds its slot ── L02 Time Blocks            (reflow shuffles tasks around them;
                                              a user can still move one by hand,
                                              members ride along — group-move)
moves last     ── manual task blocks
moves first    ── auto-placed task blocks    (today's reflow already moves only these)
```

This ratifies the engine's current shape — reflow reprocesses only auto task
blocks — so Phase 6 is formalisation, not a behaviour change.

The schema already carries every coordinate this needs: tasks have `categories`
(1–3 life-balance category names — exactly what the Balance view filters on) and a
direction tag in `tags`; blocks have `category_id` and a direction `tag`;
categories are `kind='category'` tags that already declare a per-category direction
scope (`direction_optouts`). **No schema change required.**

**Decisions** (my recommendation first; 4 is resolved, 5–7 are new):

1. **RESOLVED — a synced event cannot be unlocked, and shows its SOURCE instead
   of a lock toggle.** No disabled control: where a native block renders the
   LockToggle, a synced event renders its provenance — provider and account from
   `source_provider` / `source_account` (e.g. "Synced from Google · work") — plus
   the lock icon. A dead toggle says "broken"; the source line says *why* the
   event answers to no one here.
2. **RESOLVED — tasks move first, Time Blocks hold their slots.** Reflow shuffles
   task blocks around the blocks; Time Blocks are not reflow candidates. They stay
   above L00 only in the sense that a *user* may move them; the engine may not.
3. **When a Time Block moves, its members move with it** (same offset, container
   intact). Recommend yes — members are *inside* the block; anything else breaks
   the containment metaphor.
4. **RESOLVED — "priority" means the life-balance category** (Career, Health,
   Leisure, …), not P1–P3. The match is `block.category_id`'s category name ∈
   `task.categories`, plus the direction tag. Both fields exist today; no schema
   change.
5. **RESOLVED — reflow drops by task priority**: Later/P3 unscheduled before P2,
   P1 last. Tie-break within a band: no due date first, then shortest estimate.
6. **RESOLVED — L01 binds the autoscheduler only.** A hand-dragged block lands
   wherever the user puts it, rendered with the red conflict treatment when
   out-of-window — never blocked, never auto-moved.
7. **RESOLVED — a full Time Block falls back to L01 windows; never auto-extend.**
   The block's span is the user's stated budget for that category.

---

## Phases

Each lands independently; order matters only where noted.

### Phase 1 — The lock model *(1 day, server + client)*

The smallest phase and the foundation. No behaviour change for reflow — locked
blocks are already pinned — this makes lock state universal and visible.

1. **Server:** `sync/apply.ts` stamps `is_locked = 1` on calendar-sourced blocks at
   ingest. Migration backfills existing blocks with a `source_provider`. Keep the
   `kind === 'meeting'` guard in `isImmovable` as defence in depth — belt and braces.
2. **Client:** one `LockToggle` affordance (padlock, filled = locked), surfaced in:
   - `DetailsDrawer`'s BlockPanel
   - `PlannerEntityCard` (it has Unlock at line 183; gains Lock)
   - the Focus rows/sections from Phases 2–3
   Synced events render **no toggle at all** (decision 1): in its place, the
   event's source — `source_provider` / `source_account`, the same pair the
   connection-appearance work already keys on — alongside the lock icon.
3. `Planner.tsx:582` and `CalendarGrid` already render lock icons — they inherit
   the newly-visible state for free.

**Done when:** every scheduled item shows and toggles its lock; a fresh calendar
sync produces locked events; reflow tests still green.

### Phase 2 — Focus shows Time Blocks as expandable sections *(1–2 days)*

`Focus.tsx` today builds a flat, time-ordered entry list and skips anything not in
`FOCUS_KINDS`. Restructure the entry builder:

1. Include `timeblock` blocks as **section** entries; member task blocks
   (`parent_block_id === tb.id`) nest under their section instead of appearing as
   flat rows. Sections sort chronologically among the flat rows by `start_at`.
2. Section header: title, time range, member progress (`2/5 done`), lock state,
   expand/collapse chevron. Collapsed state persists per-day in memory (matches the
   existing `pastOpen` collapse idiom already in the file).
3. Meetings stay excluded from Focus — nothing in this request asks for them, and
   the view's job is "what am I doing", not "what is on my calendar".
4. The existing hero/current-block logic (`Focus.tsx:136`) keeps working: a member
   block in progress is still the current block; a timeblock itself never becomes
   the hero (it's a container, not a doing).

**Done when:** a seeded timeblock with members renders as a section, expands and
collapses, progress counts match, and the flat rows are unchanged for days with no
timeblocks.

### Phase 3 — Add / search tasks into a Time Block from Focus *(1–2 days)*

Each expanded section gets one inline input, reusing FlightPlan's proven pattern:

1. **Type → search**: `filterByName` over the `openTasks` resource, excluding tasks
   already scheduled in this block. Pick a result → create a member block:
   `api.blocks.create({ task_id, parent_block_id: tb.id, block_kind: 'task', … })`,
   slotted at the first free span inside the container (the `extend-block` engine
   and `patterns-place` already solve in-container placement — reuse, don't rewrite).
2. **Type → create**: no match + Enter creates the task
   (`api.tasks.create`) then places it as above — one gesture, both cases.
3. Full container: fall back to appending at the container's end and let the block
   grow via the existing extend-block path, or toast if that's disallowed — follow
   whatever `patterns-place` does today so Focus and Planner agree.

**Done when:** both paths work from the keyboard alone; the new member appears in
the section, the Planner, and the Calendar without refetch weirdness.

### Phase 4 — Calendar draws containment like the Planner *(1 day)*

Today the Calendar's `layoutBlocks` (`CalendarGrid.tsx:59`) treats every timed
block as a flat sibling: a member overlapping its own container is swept into an
overlap cluster, tiled **beside** it, and — because `cols > 1` is the conflict
signal — ringed amber as if it were a scheduling conflict. That is the defect in
the screenshot: a nested task reading as a collision with its own Time Block.

The Planner already has the correct model (`Planner.tsx:731–738`): containers
render as outline boxes, and `placedChildren(cid)` runs the overlap layout over
**only that container's members**, inset via `chipFrame(…, nested)`.

1. Port the split to `CalendarGrid`: exclude members (`parent_block_id` set, and
   the parent is on this day) from the top-level `layoutBlocks` pass; render each
   container's outline wrapping its span; lay members out inside it with their own
   mini-cluster pass.
2. Conflict highlighting keys off the top-level pass only — a member can no longer
   conflict with its own container, but two overlapping *containers*, or a member
   overlapping a foreign block, still ring correctly.
3. Reuse the Planner's inset geometry constants rather than inventing a second
   containment look — Phase W of the UI work was about one visual language.

**Done when:** the screenshot's scenario — one member inside one Time Block —
renders as a wrapped outline with no conflict ring, in Week and Day views, and the
existing CalendarGrid tests (17) still pass plus new cases for member-in-container
and container-vs-container overlap.

### Phase 5 — Auto-nest matching tasks into Time Blocks *(1–2 days, server)*

"Created inside" must mean *every* creation path — Focus's new add box (Phase 3),
Planner click-to-create, the Element wizard, quick-add, agents — so the rule lives
in `server/services/blocks.ts` create, not in any one UI:

1. On task-block creation, when no explicit `parent_block_id` was given: find a
   same-day Time Block whose span contains the new block's span, whose direction
   tag (the container's `tag`, split via `splitTagNames` — it can be a
   multi-direction union) matches the task's direction, **and whose
   `category_id` names a category in the task's `categories`** (decision 4 — the
   life-balance match). Both match → stamp `parent_block_id`. A block with no
   `category_id` matches on direction alone.
2. Ambiguity rule: two candidate containers (nested/overlapping Time Blocks) →
   prefer the tightest span; still tied → leave un-nested rather than guess.
3. Explicit intent always wins: a caller that passes `parent_block_id` (drag-onto-
   Plan, routine placement) bypasses matching entirely; passing `null` explicitly
   means "keep it loose".
4. `autoplan` already stamps `parent_block_id` when placing into Plans
   (`autoplan.ts:349`) — reflow-placed blocks are unaffected; this phase only
   covers user-created ones.
5. Tests: direction match nests; direction mismatch does not; priority mismatch
   does not (per decision 4); tightest-container tiebreak; explicit
   `parent_block_id: null` respected.

**Done when:** creating a `#work` Career task at 12:30 inside a `#work` Career
Time Block nests it (and the Calendar/Planner/Focus all show it wrapped), while a
`#work` Health task or a `#home` task at the same time stays loose.

### Phase 6 — Reflow mobility ladder *(1 day — formalisation, per decision 2)*

Decision 2 ratified the engine's current shape — reflow moves only auto task
blocks; Time Blocks hold. So this phase is formalisation, not behaviour change:

1. Encode the ladder in one place (a `mobility(block)` function server-side) so
   the ordering is a fact, not an emergent property of five WHERE clauses;
   autoplan/auto-defense filter through it.
2. Tests pin the ladder: "reflow never moves a Time Block", "reflow never moves a
   locked or synced block even when it blocks everything", "a user group-move of a
   container carries its members" (existing `move-group` behaviour, now asserted).

### Phase 7 — Day-type change: conflicts and the confirmed reflow *(2–3 days)*

The L01 consequence. Changing a day's type swaps its windows; tasks already placed
can end up outside their direction's hours.

1. **Detect** — a pure function (sibling of `lib/open-time.ts`): given the new
   windows and the day's blocks, return every task block now outside its
   direction's windows. Members of a Time Block are exempt — **L02 overrides L01**,
   the container is their authority. L00 events are never conflicts; they answer to
   no window.
2. **Show** — conflicted blocks render in the alert red (`--destructive`) across
   Planner, Calendar, and Focus, with a banner: *"3 tasks fall outside the new
   Light-day windows — reflow?"* The banner is persistent, not a toast; the
   `ConflictBanner` idiom already exists for sync conflicts.
3. **Propose** — the reflow proposal tries **same-day first**: re-place conflicted
   tasks into the new windows (and matching Time Blocks, per L02-first ordering).
   What cannot fit is proposed as *unscheduled*, lowest task priority first
   (decision 5). The LLM may author the proposal when Ollama is present — the app
   already hides AI features when it is not — but the proposal is **validated
   deterministically** (window arithmetic is never trusted to a model) and the
   deterministic engine is the fallback, so behaviour degrades gracefully to the
   same contract.
4. **Confirm — always.** The dialog lists every move and every unschedule; nothing
   happens until the user approves. Approved unschedules go **back to the
   flight-plan** (`api.flightPlan.addTask` — the exact re-staging path the app
   already uses when a block is deleted). Declined: blocks stay put, red stays on.
5. Tests: conflicts detected on window shrink; members exempt; L00 exempt; the
   proposal never moves locked blocks; unscheduled tasks land in the flight-plan;
   nothing mutates without confirmation.

**Done when:** flipping today from Workday to a Light day marks the stranded work
tasks red, the banner offers a reflow, the preview is accurate, confirming
re-places what fits and re-stages what does not — and cancelling changes nothing.

### Phase 8 — The parsing LLM gets better, and learns *(3–4 days, server)*

The LLM that turns user input into a task with variables should select the
**life-balance category** (Career, Health, Leisure, …) and the **me/us/them**
motivation better — and improve from the owner's corrections over time.

Grounding — all of the machinery exists, none of it currently learns
classification:

| Piece | Where |
|---|---|
| Input → task parse | `server/src/engine/quickadd.ts` (dates via chrono; recently fixed for durations) |
| LLM classification | `server/src/services/task-enrich.ts` — assigns `categories` from `suggestibleVocabulary` via `generateJson`; `motivation: 'me'\|'us'\|'them'` lives on the triality side |
| Learning precedent | `server/src/services/triality-learning.ts` — batch over durable evidence (`triality_log`), bounded weights, **never online, no rate knobs**; its header is the house contract |
| Embeddings | `nomic-embed-text` configured, `sqlite-vec` loads at boot |
| Measurement | `enrichment-rubric`, `rubric-live-measure`, `triality-confidence` test harnesses |
| Degrade contract | `llm-call-policy` / `llm-degrade` tests — everything inert without Ollama |

The design, following the triality-learning contract rather than inventing a new
philosophy:

1. **Capture corrections as durable evidence.** When the LLM assigned a category
   or motivation and the owner later changes it, log `(input text, llm pick,
   owner's final value)` to a correction log — the classification sibling of
   `triality_log`. An assignment left untouched for 24h+ is a weak positive
   (mirroring the `PENDING_MS` / `ignored` semantics that file already defines);
   an explicit edit is a strong labeled example.
2. **Retrieval few-shot, not fine-tuning.** At classification time, embed the
   input (`nomic-embed-text`) and retrieve the k nearest *corrected* examples via
   `sqlite-vec`; inject them into the prompt as exemplars — "you said Career here
   before, the owner said Finance". This is how a local model learns without
   training: the knowledge lives in the owner's own correction log, per-owner,
   fully local, and deletable.
3. **Batch calibration, never online.** A `calibrate_classification` job in the
   existing `calibrate_*` family maintains the exemplar index and per-category
   priors (e.g. this owner's "gym" tasks are Health, not Leisure). Bounded and
   inspectable like `triality_weights`; a classification can only change behaviour
   after the job runs — mid-request nothing shifts.
4. **"Better" is measured, not vibes.** Extend the existing rubric harness: each
   calibration run scores the current prompt+exemplars against a held-out slice of
   the correction log and records accuracy for category and motivation
   separately. The Jobs view shows the trend — if learning is not helping, the
   numbers say so before anyone argues about it.
5. **Degrade cleanly.** Without Ollama the whole surface stays inert (the app
   already hides AI features); corrections still accumulate so learning resumes
   with history when the model returns. All llm-call-policy tests keep passing.

**Done when:** correcting a task's category twice makes the third similar input
classify correctly; the rubric trend is visible per calibration run; nothing
about task creation changes when Ollama is absent.

### Phase 9 — Open time stays honest *(half a day)*

"Timeblocks are not open time" is already true — `OpenTimeSummary` subtracts every
block — but only by accident. Extract the busy-interval builder into
`lib/open-time.ts` (`busyFromBlocks(blocks)`), and pin it with tests: a timeblock
counts as busy even when empty; a member inside a timeblock doesn't double-subtract
(the existing `mergeRanges` already guarantees this — the test makes it load-bearing).

---

## Order and estimate

1 → 2 → 3 are sequential (each builds on the last). 4 (Calendar containment) and
5 (auto-nest) are independent of the Focus work and of each other — 4 is the
quickest visible win and fixes the false-conflict defect. 6 (mobility ladder,
formalisation only after decision 2) comes before 7 (day-type reflow) so the
reflow proposal can lean on the `mobility()` function. 8 (the learning parse LLM)
is independent of everything else. 9 (open time) is anytime. The L02-first
placement ordering lands with Phase 5's matcher plus a small autoplan ordering
change — called out inside Phases 5/7, not a phase of its own. Total: **11–16
working days**, with Phase 7 carrying the main regression risk.

## Autoscheduler: what L01 already does

Worth stating so Phase 8 is scoped honestly: autoplan **already** places
tag-matched tasks into Plans first, then direction windows, then a workday
fallback for *undirected* tasks — so "work tasks only in work hours" is
substantially the current behaviour for autoscheduling. Phase 8's new work is the
*conflict lifecycle* (detect on day-type change, show red, propose, confirm,
re-stage), not the window placement itself. Verify with tests rather than assume:
one test per direction asserting the autoscheduler never places a directed task
outside its windows.

## Not in scope

- Meetings in the Focus list (excluded deliberately, see Phase 2.3).
- Two-way calendar sync (would reopen decision 1 — noted, not planned).
- Moving timeblocks by drag in Focus — dragging stays a Planner interaction; Focus
  stays a list.
