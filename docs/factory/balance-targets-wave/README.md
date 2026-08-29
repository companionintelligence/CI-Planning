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

- **`client/src/lib/dimension-rollup.ts` is not on this base.** It exists only on
  `claude/app-launch-tailscale-7c490a` (commit `e7359a3c`). The drawer's
  `DimensionPanel` here shows Satisfaction / Importance / Gap / Target only.
- **The "batch arguably exists" premise does not hold.** There is no target-vs-scheduled
  computation anywhere server-side (`grep -rn "unallocated" server/src` → empty). The
  §6 comparison in `triality-vector.ts:308` measures **timed minutes from
  `time_entries`**, a different quantity, inside the situation vector. This wave builds
  the batch stage; it is not "capture + batch exist, add apply".

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
| 1 | [shortfall service](bal-1-shortfall-service.md) | Backend | ⬜ not started | — |
| 2 | [balance_bias_enabled pref](bal-2-balance-bias-pref.md) | DB Migration + Frontend | ⬜ not started | — |
| 3 | [candidate-fill bias](bal-3-candidate-bias.md) | Backend | ⬜ not started | 1, 2 |
| 4 | [day-order balance band](bal-4-order-band.md) | Backend | ⬜ not started | 1, 2 |
| 5 | [suggest surface](bal-5-suggest-surface.md) | Backend + Frontend | ⬜ not started | 1 |
| 6 | [weekly history log](bal-6-week-log.md) | DB Migration + Backend | ⬜ not started | 1 |
| 7 | [history readout](bal-7-history-readout.md) | Backend + Frontend | ⬜ not started | 6 |

1 and 2 are independent and can land in parallel. 3, 4 and 5 fork off them and are
independent of each other. 6 forks off 1; 7 needs 6. Merge 6 early even if 7 trails —
the history corpus starts accruing only when the cron row exists, and nothing can
recover missed weeks.

## Cross-wave dependencies (two sibling waves plan in parallel)

- **Migration slots.** Head on this base is `0156_capacity_hours_per_week`. The
  close-loop wave (commit `aade3a64`) reserves **0157/0158**. This wave assumes
  **0159** (ticket 2) and **0160** (ticket 6). The G-INT and revision-log waves will
  also want slots. **Whoever implements renumbers to the actual head at merge time**
  — the ids inside the files must be renamed with the filenames, and `index.ts`
  registration order must match.
- **`G-INT` (placement-override learning) will touch the same engine files** —
  `engine/autoplan.ts` and `agents/plan.ts` ordering. If it also adds a band to
  `deterministicIndices`, band ORDER between the two must be decided at merge time;
  this wave pins its band LAST before due/priority precisely so a sibling band can
  slot ahead of it without re-litigating. Flagging per the scope fence; not planning
  their side.
- **Cron slot.** Ticket 6 takes **Monday 04:40** (`'40 4 * * 1'`), clear of every
  seeded row (03:50, 04:10, 05:00 Mondays; 04:20 reserved by the close-loop wave).

## Verification

Wave-level, from the repo root: `pnpm typecheck && pnpm test`.

The factory template's `pnpm --filter server vitest run` fails with
`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. The working form, used throughout:

```bash
pnpm --filter server exec vitest run server/test/<file>.test.ts
```

## Open follow-ups this wave will produce

| Item | Origin | Status |
|---|---|---|
| Task lock/unlock toggle on the task modal — ticketed: [drafts/task-lock-toggle.md](../drafts/task-lock-toggle.md). `time_blocks.is_locked` and `PATCH /api/blocks/:id` already exist; the ticket adds an `activeBlockFor` route enrichment (mirroring `peopleFor`) and wires the Lock chip that already exists on the timeblock tab (`ElementWizard.tsx:1503`) onto the task tab. Separate mechanism from targets — deliberately fenced out of this wave. | owner ruling | ticketed 2026-08-29, not started |
| Capacity reservation ("protect 14 h for Health") as an opt-in layer over `balance_week_log` data | apply-mode decision | open, only if bias measures too gentle |
| Reconcile with `e7359a3c`'s client `dimension-rollup.ts` if that branch merges — ticket 5's server shortfall read supersedes its client-side week math; keep the server as the single source | brief correction | open |
| `life_priorities` has no `updated_at`-driven staleness surface — a 2-year-old target biases as strongly as yesterday's; consider a "targets last reviewed" nudge | found pinning ticket 1 | open, out of scope |
