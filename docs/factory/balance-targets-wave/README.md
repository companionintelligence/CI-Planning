# Balance-targets wave — stated targets reach the scheduler — plan of record

Seven tickets closing the `capture → batch → apply` loop for life-balance targets. Each
`bal-N-*.md` in this folder is a full commit recipe. **This file is the live status;
update it as tickets land.**

Opened 2026-08-29.

## The gap

The Priorities Wizard captures `importance`, `satisfaction` and `target_hours_per_week`
per dimension into `life_priorities` (0127) — the richest explicit preference signal in
the product — and **nothing in placement reads any of it**. Verified on this tree:

```bash
grep -rn "life_priorities\|target_hours_per_week" server/src/engine/ server/src/agents/plan.ts
# → empty
```

The only readers are `services/triality-vector.ts` (analytical vector),
`services/priorities.ts` (CRUD), `routes/backup.ts`, `db/schema.ts`,
`db/entities/LifePrioritiesEntity.ts`, `lib/owners.ts` (deletion) and the client. A user
can rate Health 10/10 with a 14 h/week target and the scheduler never acts on it.

## Corrections to the brief that opened this wave

- **`client/src/lib/dimension-rollup.ts` was not on this base when this wave was
  first drafted** (2026-08-29, before the rebase below) — it existed only on
  `claude/app-launch-tailscale-7c490a` (commit `e7359a3c`), and this worktree's
  `DimensionPanel` showed Satisfaction / Importance / Gap / Target only. **This is
  now stale — see "Update — 2026-08-29 rebase" below.** Left here rather than
  deleted so the history of what changed and why stays legible.
- **The "batch arguably exists" premise does not hold, and still doesn't.** There
  was no target-vs-scheduled computation anywhere server-side
  (`grep -rn "unallocated" server/src` → empty at the time). The §6 comparison in
  `triality-vector.ts:308` measures **timed minutes from `time_entries`**, a
  different quantity, inside the situation vector. This wave still builds the
  server batch stage (ticket 1) — the rebase below added a CLIENT rollup, not a
  server one, and tickets 3/4's bias needs server data regardless of what the
  client can compute for itself.

## Update — 2026-08-29 rebase onto `origin/main`

This worktree's `main` was 7 commits behind `origin/main` when this wave was
first drafted. After rebasing onto `origin/main` (merge-base moved from
`cb072d07` to `cfc5e753`), two merged PRs landed in this branch:

- **#584** — the close-loop wave (dismissed suggestions), making `0157`/`0158`
  real migrations, not paper reservations.
- **#587** — "Objectives in the drawer, a Balance time rollup, and the
  close-loop ticket wave," which is exactly the `dimension-rollup.ts` /
  `DimensionPanel` work the original brief flagged as "may not be on main yet."
  It is now on main, and it is a fuller build of it than this wave's ticket 5
  originally planned: a week/month-scoped Allocation group (Target / Scheduled /
  Unallocated-or-Over-target), computed client-side from `api.blocks.list()`,
  plus a Balance.tsx simplification (the old Focus Areas rail was removed in
  favor of the drawer as the single per-dimension detail surface).

**Consequence: ticket 5 was rewritten**, not just renumbered. Its original scope
(a server shortfall endpoint + an "Unallocated" field in the drawer) is now
redundant with #587. What #587 does NOT add is any way to act on the number —
every row in the drawer's Open list opens the task, none stages it. Ticket 5 now
does exactly that: a one-tap Stage button on the existing Open list, entirely
client-side, no new server route, no dependency on ticket 1. See
[bal-5-suggest-surface.md](bal-5-suggest-surface.md) for the full rework and its
own "Superseded by a rebase, not by design" note.

**Ticket 1 is unaffected in purpose** (tickets 3/4's server-side bias cannot call
client code regardless of what the client now computes for itself) but now
carries a documented divergence: the client's "Scheduled" number in
`DimensionPanel` counts blocks with no status filter — including
cancelled/skipped/missed — while ticket 1's service deliberately excludes them.
Not a bug this wave introduces or is responsible for fixing; flagged in ticket 1
and in the follow-ups table below.

**Ticket 7's line-number citations into `DetailsDrawer.tsx` were updated** to
match the file as rebased in (the function moved from line 586 to 618) — those
numbers should still be re-checked at implementation time; this file has shifted
twice in one day already.

## Decisions of record (owner rulings, 2026-08-29)

**Bias + suggest, no reservation.** The owner ruled a stated target is a direct
instruction that must reach placement — via ordering bias plus a one-tap suggest
surface, explicitly **not** via reserved capacity. That keeps the N2 deferral's
constraint intact (`docs/recap_state_A-S.md:106`: "enforcement risks thrash"):
nothing in this wave pre-blocks calendar time, hides a task, or displaces a
placed block. Reservation can be a later wave on the same data if bias proves
too gentle.

**Instruction, not evidence — so a live read is legal.** The house pattern
(`services/classification-learning.ts`) forbids *learning* online. A target is not
learned evidence; it is a direct instruction, like an obstacle or a theme tag. Reading
`life_priorities` + current-week calendar state at placement time is a pure READ of
user-stated config — the same class as `dayObstacles` — and is not a violation. What
IS held to the batch contract is the **history**: the weekly shortfall snapshot
(`balance_week_log`, ticket 6) is durable, owner-scoped, batch-written by cron, and is
the corpus any future learning ("you've missed Health 6 weeks running") reads. Nothing
mid-request ever writes it.

**Bounded influence, never suppression.** The bias is a band in existing sort chains —
inert when empty, exactly the `memCmp`/`newCmp` mechanism `deterministicIndices`
already stacks (`agents/plan.ts:717-740`). Bounds: a dimension enters the lead set
only at ≥ `SHORTFALL_FLOOR_HOURS` (2) shortfall; at most `BIAS_DIMENSIONS_MAX` (2)
dimensions lead; candidate widening never excludes a task, only reorders. No
learning-rate knob, no env dial.

**Toggle: `balance_bias_enabled`, default ON.** Owner ruling. Follows the
`calibration_loop_enabled` prefs pattern (Settings toggle, GraphQL camel↔snake map,
api.ts optional field). Estimate calibration shipped default-on too
(`Settings.tsx:74`). Off ⇒ every band and the candidate widening are byte-inert; the
suggest surface (a pure read the user must tap) stays.

**The human tap is the write.** The suggest surface stages tasks via the existing
`POST /api/flight-plan` — precedent: `suggestEstimate` is "PURE READ — it never
writes" and the accept is the write.

**Week = owner-local Monday-start.** The `weekDays` rule in
`services/weekly-review.ts:81` (dow 0=Sun → back to Monday). One convention, cited in
every ticket that touches a week.

**"Scheduled" counts what happened or is planned.** Blocks with
`status NOT IN ('cancelled','skipped','missed')` — the three didn't-happen terminals
(`TERMINAL_BLOCK_STATUSES`, `services/block-task-sync.ts:39`) don't count toward a
target; `completed` does. Categories resolve block-own-else-task
(`blockCategoryNames`, `services/blocks.ts:127`).

## Status

| # | Ticket | Type | Status | Blocked by |
|---|---|---|---|---|
| 1 | [shortfall service](bal-1-shortfall-service.md) | Backend | ✅ landed `59651309` | — |
| 2 | [balance_bias_enabled pref](bal-2-balance-bias-pref.md) | DB Migration + Frontend | ✅ landed `90fb7b47` | — |
| 3 | [candidate-fill bias](bal-3-candidate-bias.md) | Backend | ✅ landed `519f3a7c` | 1, 2 |
| 4 | [day-order balance band](bal-4-order-band.md) | Backend | ✅ landed `f55652e1` | 1, 2 |
| 5 | [suggest surface](bal-5-suggest-surface.md) | Frontend | ✅ landed `21f65e4f` | — |
| 6 | [weekly history log](bal-6-week-log.md) | DB Migration + Backend | ✅ landed `d041633f` | 1 |
| 7 | [history readout](bal-7-history-readout.md) | Backend + Frontend | ⬜ not started | 6 |

1 and 2 are independent and can land in parallel. 3 and 4 fork off them; 5 is now
fully independent (client-only, no server dependency — see the 2026-08-29 rebase
update below) and can land any time. 6 forks off 1; 7 needs 6. Merge 6 early even
if 7 trails — the history corpus starts accruing only when the cron row exists,
and nothing can recover missed weeks.

## Cross-wave dependencies — verified against every branch, 2026-08-29

This worktree's `main` is **7 commits behind `origin/main`** (merge-base
`cb072d07`; `origin/main` is at `cfc5e753`). Re-check this before implementing —
the state below is a snapshot, not a standing guarantee.

**Real (merged to `origin/main`):**

| Slot | What | PR |
|---|---|---|
| 0157/0158 | `dismissal_evidence` + `calibrate_dismissals` cron (the close-loop wave, dismissed suggestions) | #584 |
| 0161 | `completion_score` (close-ritual 1-5 rating; unrelated feature, not one of the three loops) | #588 |

Migration head on `origin/main` is therefore **0161**, not 0156.

**Claimed on paper, unmerged (each verified by reading the actual branch, not
inferred from a README):**

| Slot | Wave | Branch | Status |
|---|---|---|---|
| 0159/0160 | G-INT — placement-override learning (`placement-learning-wave`) | `claude/silly-golick-0b3078` | 6 tickets + README only, no implementation |
| 0162 | Agent loop's write-only revision log (`revision-loop-wave`) | `claude/silly-solomon-5ab111` | 6 tickets + README, **plus one real file**: `db/migrations/0162_plan_loop_learning.ts` and a `test/helpers.ts` teardown addition |

**The collision, and how it was resolved.** G-INT's `place-1`/`place-4` tickets
originally claimed 0159/0160 with the identical reasoning this wave used
("0157/0158 taken, so next is 0159/0160") — a real triple-claim, since
revision-loop-wave had independently claimed the same pair too. Three rounds of
independent sweep-and-reclaim later (0159/0160 → this wave tried 0163/0164 →
G-INT tried 0164/0165), the G-INT session proposed a **fixed sequence across
all three waves**, relayed here via cross-session message, 2026-08-29:
revision-loop-wave keeps **0162/0163** (0162 already landed as a real file
there — re-litigating a merged number is real churn a still-unimplemented
plan's number isn't); this wave takes **0164/0165** (tickets 2 and 6, updated);
G-INT takes **0166/0167**. Adopted here because it's mechanically better than
another independent sweep (which is what produced the triple-claim in the
first place) and costs nothing to accept — it only changes two integers this
wave doesn't otherwise care about. **Re-verify at implementation time
regardless** — a fourth wave, or any of these three actually merging, moves
the real head again. The ids inside the migration files must be renamed
together with the filenames, and `migrations/index.ts` registration order must
match the actual head.

**Code-level overlap, checked function-by-function, not just file-by-file:**

- **G-INT vs this wave — no overlap found.** G-INT's `place-5` ticket touches
  `engine/scheduler.ts` (untouched by this wave) and one `pickGap` call inside
  `engine/autoplan.ts` at line 439 (`placeIntoWindow`). This wave's ticket 3
  touches a different function in the same file, `fillFlightPlanCandidates`
  (line 758) — no shared lines. Ticket 4 touches `agents/plan.ts`, which G-INT's
  tickets never mention.
- **Revision-loop-wave vs this wave — one real, localized overlap.** Its `rev-2`
  ticket wires a `record:` callback into the single production `runLoop(...)`
  call inside `authorPlanOrder` (`agents/plan.ts`, ~line 747) — the same call
  this wave's ticket 4 extends with a `check:` callback change, in the same
  object literal a few lines apart. Orthogonal concerns (their evidence capture,
  this wave's ordering bias), but a textual merge conflict is likely if both
  land close together — flagged in `bal-4-order-band.md` directly. Not a design
  conflict; whoever merges second keeps both new fields.
- **Close-loop-wave (merged, #584) vs this wave — no overlap.** It touches
  `agents/extract.ts`, `agents/groom.ts`, `agents/ingest.ts`,
  `services/possibles.ts`, `routes/oauth.ts` — none of which this wave touches.
  It does share `jobs/index.ts`, `db/migrations/index.ts` and
  `client/Settings.tsx` with this wave's tickets 2/6, but only as
  every-wave-appends-a-line registries — routine, not a design collision, and
  now moot for `jobs/index.ts`/`migrations/index.ts` since #584 is already on
  `origin/main` (this wave's diff will apply against the real head, not a stale one).
- **Cron slot.** Ticket 6 takes **Monday 04:40** (`'40 4 * * 1'`), checked
  against all 21 cron rows actually merged to `origin/main` (nearest neighbors:
  03:50, 04:10, 04:20 Monday — the last is `calibrate_dismissals`, confirmed
  real at `'20 4 * * 1'`) and against G-INT's paper-claimed 04:30 Monday
  (`calibrate_placement`). Clear of both.

**Bottom line: this wave's 7 tickets can be implemented in parallel with both
sibling waves.** No two waves write the same lines of the same function. The
only two coordination points are (a) the 0164/0165 slot assignment above —
settled, not just assumed, though still worth a final re-check at
implementation time — and (b) the `agents/plan.ts` `runLoop` call-site
adjacency with the revision-loop-wave, a normal merge-order issue, not a
blocker. Implement, test, and land any of the three waves independently;
whichever merges second does a small manual resolve on that one spot, nothing
more.

Also unaffected by any of this: the 2026-08-29 rebase onto `origin/main` (see
"Update" section above) reworked ticket 5 in response to #587 shipping the
client-side Allocation/Unallocated surface this wave had independently
planned. That rework is unrelated to the migration-slot coordination — it's a
response to what's already merged, not to a sibling wave still in flight.

## Verification

Wave-level, from the repo root: `pnpm typecheck && pnpm test`.

The factory template's `pnpm --filter server vitest run` fails with
`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. **Correction, verified 2026-08-29 during
implementation:** the form this wave's own tickets originally documented —
`pnpm --filter server exec vitest run server/test/<file>.test.ts` — is ALSO
wrong; `--filter server exec` already sets cwd to `server/`, so the leading
`server/` double-nests the path and vitest reports "No test files found."
Three independent implementing agents (tickets 1, 3, 6) hit this and
self-corrected; confirmed directly, twice, by running both forms here. The
actually-working form, used from here on:

```bash
pnpm --filter server exec vitest run test/<file>.test.ts
```

(Tickets 1–6's own `.md` files still show the old, wrong form in their Tests
sections — left as historical record since the actual landed code and tests
are correct regardless; each implementing agent's commit documents the
correction it made. Ticket 7's commands below use the corrected form.)

## Open follow-ups this wave will produce

| Item | Origin | Status |
|---|---|---|
| Task lock/unlock toggle on the task modal — ticketed: [drafts/task-lock-toggle.md](../drafts/task-lock-toggle.md). `time_blocks.is_locked` and `PATCH /api/blocks/:id` already exist; the ticket adds an `activeBlockFor` route enrichment (mirroring `peopleFor`) and wires the Lock chip that already exists on the timeblock tab (`ElementWizard.tsx:1503`) onto the task tab. Separate mechanism from targets — deliberately fenced out of this wave. | owner ruling | ticketed 2026-08-29, not started |
| Capacity reservation ("protect 14 h for Health") as an opt-in layer over `balance_week_log` data | apply-mode decision | open, only if bias measures too gentle |
| ~~Reconcile with `e7359a3c`'s client `dimension-rollup.ts`~~ — **done**: it merged as #587 during this wave's 2026-08-29 rebase; ticket 5 was rewritten around it rather than superseding it (see "Update — 2026-08-29 rebase" above) | brief correction | resolved 2026-08-29 |
| The client `DimensionPanel`'s "Scheduled" count has no status filter (counts cancelled/skipped/missed blocks); ticket 1's server service deliberately excludes them. Two different numbers for "scheduled" now exist in the app, one client one server. Not this wave's bug and not fixed here — flagged in ticket 1 | found reconciling ticket 5 post-rebase | open, out of scope |
| `life_priorities` has no `updated_at`-driven staleness surface — a 2-year-old target biases as strongly as yesterday's; consider a "targets last reviewed" nudge | found pinning ticket 1 | open, out of scope |
