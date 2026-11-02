# How Objectives render as block groupings in the Planner

> **Status:** decision record · **Spike:** [#361](https://github.com/companionintelligence/CI-Planning/issues/361) ·
> **Date:** 2026-07-16 · **Branch:** `spike/objectives-in-planner` · **Production diff:** none
>
> **Decision: (c) — a non-geometric objective accent on member blocks, plus an opt-in
> single-objective rail. Reject (b) the derived spanning band.** Reasoning and evidence below.
>
> **Follow-up status (2026-11-01):** step 1, the always-on accent and the shared objectives
> store, shipped as #386 (re-merged in #401): `client/src/lib/objective-accent.ts`,
> `objectiveAccentByBlock` in `client/src/stores/index.ts:120`, and the left-border recolour in
> `Planner.tsx:468-471` and `:538`. Step 2, the opt-in focused-objective rail, is not built.
> The rest of this record is the 2026-07-16 analysis and is left as written, so its
> measurements and "today" statements describe the code at head 0131; the citations are
> updated to the current files where they still exist.

The owner asked: *"Objectives happen across multiple sessions. They are similar to timeblocks.
Represent Objectives in the same way as a Time Block"* — and chose rendering an Objective as a
container that groups its tasks' blocks, with the span derived from those child blocks.

This record evaluates that against measured behaviour. The short version: **the span is trivial to
derive and actively misleading to draw.** A Time Block is contiguous *by construction* — it owns
one box because it owns one interval. An Objective is a set of scattered intervals, so the box it
would own is mostly other people's work. The parts of "like a Time Block" worth keeping are
identity and grouping, not the box.

---

## 1. The four blockers, re-verified

The ticket's four blockers are all real. **Two of its code citations are wrong** — corrected here,
because the follow-up ticket must not inherit them.

| # | Claim | Verdict | Correct citation |
|---|---|---|---|
| 1 | Objectives have no time columns | **TRUE** | ⚠️ **not** `server/src/db/schema.ts:648-669` — `objectives` **is not in `schema.ts` at all**. It is raw DDL in [`0081_objectives.ts:19`](../server/src/db/migrations/0081_objectives.ts). |
| 2 | The Planner has never heard of objectives | **TRUE** at head 0131 | `grep -ic objective client/src/components/Planner.tsx` → **0**. No objectives store in `client/src/stores/index.ts`. *(Changed since: #386 added both; see the follow-up status above.)* |
| 3 | The tree API returns no block linkage | **TRUE** | [`api.ts:903`](../client/src/lib/api.ts#L903) (`api.objectives.list`; the ticket said 1066-1075). |
| 4 | "Container" is already a real block | **TRUE** | `block_kind === 'timeblock'`; children via `parent_block_id`; [`group-move.ts`](../client/src/lib/group-move.ts). |

**Blocker 1 in full.** `objectives` columns as of head 0131 (0081 + 0086 + 0087 + 0129):
`id, owner_id, parent_id, level, horizon, title, description, target_date, status, category_id,
progress_cache, cadence, last_advanced_at, priority, created_at, updated_at, completed_at,
source_task_id, version, field_ts, archived_at, archive_root_id, purge_after` (a later
migration, `0133_item_colors`, added `color_token`).
`target_date` is a **date**, not a clock time. There is no `start_at`/`end_at`. Confirmed.

### 4a. A fifth blocker the ticket did not have: the time axis is vertical

The ticket's option (a) proposes *"an all-day lane above the grid, one row per Objective with its
tasks' blocks ticked along it."* **That cannot work as written.** In the Planner, time runs
**down the Y axis** — blocks are placed by `top`/`height` via `segmentExtentPx`, and resize
handles are `cursor-ns-resize`. A horizontal row above the grid has **no time alignment**; its
ticks could not line up with anything.

There *is* a header lane above the grid ([`Planner.tsx:1139`](../client/src/components/Planner.tsx#L1139)),
but it is explicitly **off the minute axis** — it holds all-day Plans and Concepts precisely
because they have no position in time.

The correct analogue of option (a) on a vertical axis is a **vertical rail**: a narrow column
beside the grid, ticked at each member block's Y. This already exists as a pattern —
`DirectionColumn` is a 1.75rem rail in the Planner's own grid template
([`Planner.tsx:1151`](../client/src/components/Planner.tsx#L1151)):

```
grid-template-columns: 3.5rem 1.75rem 1fr    /* TimeGutter | DirectionColumn | grid */
```

Option (a) is evaluated below in this corrected, vertical form.

---

## 2. The evidence problem: there is no real data (N = 0)

Subtask 2 asked me to *"measure the real data: how often are an Objective's blocks non-contiguous?
How often do two Objectives interleave on one day?"*

**That base rate cannot be measured, because the data does not exist.** Both local databases:

| DB | migration head | objectives | **objective_tasks links** | task-linked blocks |
|---|---|---|---|---|
| `data/local-dev.db` | **0092** (38 behind main) | 1 | **0** | 5 |
| `data/companion.db` | pre-0081 | **table absent** | — | — |

`local-dev.db` predates the objectives feature it would have to measure — its schema is 38
migrations behind main's 0131 and has no `archived_at`. **Zero objective↔task links exist
anywhere.** So "how often" has no denominator, and any percentage I reported would be invented.

**This is itself the finding:** the feature is being designed for data no user has produced yet.
That inverts the design priority — the cost of getting this wrong is not "a rare day looks odd",
it is that **the first objective a user ever creates has to look right**, with the empty and
one-block cases mattering far more than the crowded case.

Measurement therefore proceeds against a **synthetic worst-case** scenario on a fresh DB at head
**0130** — the head on the day it was measured; main has since moved to 0131, which adds
`planning_sessions` and touches nothing here (isolated stack, `PORT=3849` + scratchpad DB). The
numbers below describe **what the geometry does in a known-hard configuration**, not how often
that configuration occurs. Read them as *possibility*, not *frequency*.

### The scenario

| | 09:00 | 11:00 | 13:00 | 14:30 | 15:00 | 18:00 |
|---|---|---|---|---|---|---|
| **A · Ship the redesign** | A1 | | | | A2 *(inside a Plan)* | |
| **B · Hire an engineer** | | B1 | | | | B2 |
| **unrelated** | | | Dentist | *Deep work* (Plan container 14:30–16:30) | | |
| **C · Learn Spanish** | *(one task, no blocks today)* | | | | | |

A's derived span is 09:00–16:00; B's is 11:00–19:00. A2 is a member of A **and** a child of the
"Deep work" Plan via `parent_block_id` — the double-containment case.

---

## 3. What the prototype measured

A throwaway prototype (all three options behind `localStorage.spike361`) was built, driven in the
browser, and reverted. It supplied the missing objectives store and the client-side
objective→task→block join, then rendered each treatment.

**The join works and needs no API change.** `blocks()` rows carry `task_id`; the tree gives task
ids per leaf; joining in memory is enough. This is the one part of the ticket's plan that survives
intact.

### Option (b) — the derived spanning band: **rejected, in pixels**

```
A · Ship the redesign   span 09:00–16:00   →  top 177.6px, height 537.6px
B · Hire an engineer    span 11:00–19:00   →  top 331.2px, height 614.4px
```

- **Density: 29% (A) and 25% (B).** Three quarters of each band is *not that objective's work*.
  The band's dominant visual claim is false.
- **It swallows.** A's band encloses `B1` and `Dentist`. B's band encloses `A2` and `Dentist` —
  **an objective's band visually claims another objective's block.**
- **It interleaves.** `A.top < B.bottom && B.top < A.bottom`, and neither contains the other →
  `interleavedInPixels: true`. Two bands **cannot** nest; boxes have no valid z-order here.
- **It collides with `parent_block_id`.** A2 sits inside the "Deep work" Plan *and* inside A's
  band — two overlapping groupings asserting ownership of one chip.

> **Screenshot (band):** captured live in the spike session — objective A's cyan band runs from
> 09:00 down past 12:00; `B1 · screen resumes` (objective **B**'s block) sits **inside** it; B's
> magenta band starts at 12:00 and **overlaps** A's rather than nesting; `Dentist (unrelated)` at
> 13:00 is inside both. See §7 on why no image file is committed.

### Option (a, corrected) — one vertical rail per objective: **viable, doesn't scale**

```
A · rail at left 2px    ticks: 177.6px (A1), 638.4px (A2)      gap 254→638 stays empty
B · rail at left 12px   ticks: 331.2px (B1), 868.8px (B2)
```

- **Non-contiguity is handled honestly** — the rail ticks only where work exists; the gap is
  visibly empty and claims nothing.
- **Interleaving is a non-issue** — each objective owns its own column, so nothing needs to nest.
- **`parent_block_id` is untouched** — the rail is outside the grid column entirely.
- **But width is linear in objective count.** Each rail costs ~10px of the same horizontal budget
  the overlap columns and the 104px category cell already compete for. Fine at 2 objectives;
  unusable at 8. The Planner has exactly one 1.75rem rail today, and it is a **fixed** axis
  (direction), not an unbounded per-entity one.

### Option (c) — non-geometric accent: **recommended**

```
A1 → inset 4px rgb(48,201,232)   A2 → inset 4px rgb(48,201,232)    (same objective, same colour)
B1 → inset 4px rgb(232,48,171)   B2 → inset 4px rgb(232,48,171)
Dentist → (none)                 geometry added: 0 elements
```

- **Immune to all four blockers.** No span is drawn, so nothing swallows, nothing interleaves,
  nothing competes with `parent_block_id`. `geometryAdded: 0`.
- **It survives the container.** A2 is nested inside the "Deep work" Plan and still carries A's
  accent — identity and containment stop fighting because only one of them is a box.
- **It crosses the gap.** A1 (09:00) and A2 (15:00) read as one objective across six hours of
  unrelated work — which is exactly the owner's *"objectives happen across multiple sessions."*

> **Screenshot (accent — the recommended option):** captured live in the spike session —
> `A1 · wireframes` (09:00) carries objective A's cyan left edge and `B1 · screen resumes` (11:00)
> carries objective B's magenta, on an otherwise unchanged grid. No band, no rail, no new boxes.
> See §7 on why no image file is committed.

---

## 4. The recommendation

**Ship (c) as the always-on default. Add the (a) rail later as an opt-in, restricted to ONE
focused objective at a time.**

The rail's only fatal flaw is that N rails don't fit. Focusing a single objective removes that
flaw completely: one rail is 10px, interleaving is moot with one lane, and the gaps in the rail
answer *"where does this objective actually live today?"* — the question the owner is really
asking. Focus-one is also the honest read of "objectives happen across multiple sessions": you
follow one thread through the day, you don't wallpaper the grid with every thread at once.

That gives a two-step path where step 1 is safe and immediately useful, and step 2 is additive:

1. **Accent (always on)** — answers *"which objective does this block serve?"* at a glance.
2. **Focused rail (opt-in, one objective)** — answers *"where does this objective live today, and
   where are its gaps?"* without ever drawing a false span.

**Do not build (b).** It is the only option the measurements actively disprove, and its failure is
not a tuning problem — a 25%-density box that encloses its rival's work is wrong at any opacity.

### Why this still honours "represent Objectives like a Time Block"

It keeps what a Time Block *communicates* (this work belongs together; here is its identity) and
drops what a Time Block *is* (one contiguous box), because the second is a property of contiguous
intervals and objectives are not contiguous. Reporting this back to the owner is part of the
spike's job: **the box is the one part of the ask the data cannot support.**

---

## 5. Schema and API impact

**None required.** This is the strongest argument for the recommendation.

- **Schema:** no migration. No `start_at`/`end_at` on `objectives`. The span is derived, and under
  (c) not even drawn.
- **API:** no change. The client-side join over `blocks().task_id` is sufficient — **proven by the
  prototype**, which used only `GET /objectives` and the existing `blocks()` store.
- **The one real cost is a client store.** `ObjectivesPanel` currently fetches its own objectives
  via a local `createResource`. The Planner needs the same data, so a shared objectives store in
  `client/src/stores/index.ts` should be added and `ObjectivesPanel` left alone for now (the ticket
  forbids touching it).

If the focused rail is built later it needs **no schema either** — the focused objective id is
view state (a signal, or `view_prefs` if it should persist).

---

## 6. Required edge cases

**An objective whose tasks have no blocks on the viewed day — the common case, and today the
*only* case (N=0).** Under (c) it renders **nothing at all**, and that is correct: the Planner
shows a day, and an objective with no work on that day has no business on it. The prototype
confirmed objective C (one task, no blocks) produced zero elements in every mode — no empty rail,
no zero-height band, no placeholder. Discovery of such objectives belongs to the Objectives tab,
not the day grid. **Any design whose empty state is a visible stub is wrong**, because at N=0
every objective is the empty state.

**A block inside a collapsed night region has no pixels.** `segmentExtentPx` returns **null** when
an extent falls entirely inside a collapsed region (00:00–07:00 / 21:00–24:00 by default), which
is why the prototype filters on it. Under (b) an objective whose only blocks are at 06:00 and
06:30 would have a span that **cannot be drawn at all**. Under (c) the member chip is already
hidden with its region, so the accent disappears with it — no special case needed.

**An archived objective.** Per [#366](https://github.com/companionintelligence/CI-Planning/pull/366)
the archive is an `archived_at` **column**, and `GET /objectives` returns the live tree only, so
archived objectives never reach the join. No extra filter needed — but the follow-up must not
introduce one that assumes `status='archived'`.

---

## 7. Incidental findings

- **`POST /api/blocks` silently ignored `parent_block_id`** — ✅ **since fixed and merged**
  ([#376](https://github.com/companionintelligence/CI-Planning/pull/376)). Found here while
  seeding the scenario: a create-time attach was accepted and dropped on the floor, no 4xx, while
  the client's own typed `create` signature advertised the field. Containment was establishable
  only via `PATCH`. Chasing it also surfaced a **cross-owner grafting hole on the shipped PATCH
  path** (the self-referential FK proves a row exists, not that you own it), closed by the same PR.
  Consequence for this record: the seeding step described in §2 now attaches in one call, so a
  future reader reproducing the scenario will not hit the two-step `POST`-then-`PATCH` dance the
  spike had to use.
- **Why no screenshot images are committed.** Both screenshots were captured live and are in the
  spike session/PR, but no `.png` is checked in: they depict a prototype that **no longer exists in
  any branch**, so a committed image would rot immediately and could later be mistaken for shipped
  UI. The durable evidence is the **measured DOM geometry** quoted above — it is reproducible from
  the archived prototype, whereas a screenshot is not falsifiable. If the owner wants the images in
  the repo, they belong on the follow-up's PR, against code that actually ships.
- **Browser-pane screenshots do work** (contradicting a note in my own memory that claimed they
  always time out); `computer{action:"zoom"}` *does* still time out reliably.

---

## 8. Follow-up

[`docs/factory/drafts/spike361_followup_objective_accent.md`](./factory/drafts/spike361_followup_objective_accent.md)
— a commit recipe for step 1 (the accent + the shared objectives store). Step 2 (the focused rail)
is deliberately **not** drafted: it should be written only after the accent is in front of the
owner, and only once real objective data exists to check the rail against.
