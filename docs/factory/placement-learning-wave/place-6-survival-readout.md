> **Type:** Backend
> **Phase:** Placement-learning wave — G-INT (timing intelligence)
> **Branch:** `feat/placement-survival-readout`
> **Commit style:** `feat(routes): placement survival trend and reset-learning endpoint`
> **Design:** [README.md](README.md)
> **Dependencies:** Ticket 4 (`placement_survival` is being written). Independent of ticket 5 — may land in parallel.

## Goal

Make the loop falsifiable. One trend endpoint that answers *"what share of auto-placed
blocks survive the day untouched, week over week?"*, and one reset endpoint so an owner can
drop what the scheduler learned without losing the evidence it learned from.

Without this, "the scheduler got better" is a claim. This is what turns it into a number —
and it is the reason to merge this ticket even though nothing renders it yet.

## Non-goals

- **Do not build a client surface.** `routes/triality.ts` and `routes/classification.ts`
  have none either — verified, no `client/src` file references `/api/classification`. A
  Settings panel is a separate, later ticket.
- **Do not delete from `placement_log`.** The reset drops the learned rollup only, exactly
  as `DELETE /api/classification/exemplars` does: the evidence survives, so the next weekly
  pass re-earns the adaptation rather than losing it. There must be no endpoint anywhere
  that deletes evidence.
- **Do not add a "recalculate now" endpoint.** Learning is batch by contract — never online,
  never mid-request. An owner-triggered recalibration would be a hole in that. The existing
  Jobs "run now" affordance already covers manual runs through the normal job path.
- **Do not expose another owner's data, and do not add an `ownerId` query parameter.** Every
  statement filters `currentOwnerId()`.
- **Do not add a feature-flag gate.** `routes/classification.ts` states why it has none: an
  owner who has corrected nothing simply has an empty trend, which is what a fresh install
  reports anyway. Do not import `lib/flags.js`.
- **Do not change `placement_survival`'s shape or write to it here.** Ticket 4 owns the write.
- **No migration. No engine change. No job change.**

## Pinned conventions

Verified against the tree — do not substitute.

- **Router shape.** Copy `server/src/routes/classification.ts` structurally: a
  `placementRouter()` factory returning `new Router({ prefix: '/api/placement' })`, a
  file-header block comment stating that it is a thin adapter with zero business logic and
  that both routes are owner-scoped, and a `//` comment above each route saying what it is
  for.
- **Registration.** `server/src/routes/index.ts` — `import { placementRouter } from './placement.js';`
  beside the `classificationRouter` import (line 45, unchanged), and `placementRouter(),` in
  the array (after `classificationRouter()`, now line 94 — the close-loop wave's
  `dismissalLearningRouter()` merged in ahead of it since this plan was drafted; re-verify
  with `grep -n classificationRouter server/src/routes/index.ts` before editing).
- **Limit clamp.** `Math.min(Math.max(Number((ctx.query as Record<string, string>).limit) || 12, 1), 100)`
  — byte-identical to `classification.ts:26`.
- **Null is a gap, never a zero.** `survival_rate` is `NULL` when a period decided nothing.
  Serialise it as `null` and say so in the route comment: a chart must draw a gap there.
- **Audit.** The reset is an owner-initiated write, so it is audited (WHO rule) —
  `writeAudit({ ownerId: owner, actor: 'owner', action: 'reset', entity: 'placement:preferences' })`,
  and **only when `res.changes > 0`**: a no-op delete is not a mutation worth a row. The
  batch's own writes stay unaudited, matching `jobs/index.ts:414` (classification's
  identical WHO-rule comment — line numbers shift on this file often; re-verify before
  implementing).
- **Trend reader.** `survivalTrend(ownerId, limit)` goes in
  `services/placement-learning.ts` beside `calibratePlacement`, mirroring `accuracyTrend`
  (`classification-learning.ts:609`). `ORDER BY computed_date DESC LIMIT ?` — newest first.
- **Response shape.** `GET` → `{ runs: [...] }`; `DELETE` → `{ ok: true, cleared: <changes> }`,
  matching `classification.ts` exactly.

## Before implementation

Read `server/src/routes/classification.ts` in full (46 lines — this is a near-copy),
`services/classification-learning.ts` lines 609–620 (`accuracyTrend`),
`server/src/routes/index.ts` lines 40–100, and the `placement_survival` DDL in ticket 1.

## Files impacted

**New:**
- `server/src/routes/placement.ts`
- `server/test/placement-routes.test.ts`

**Changed:**
- `server/src/services/placement-learning.ts` — add `survivalTrend`
- `server/src/routes/index.ts` — import + array entry

## Schema required

None — ticket 1 landed `placement_survival` and `placement_preferences`; ticket 4 fills them.

## Definition of Done

- [ ] `GET /api/placement/survival` returns `{ runs }`, newest `computed_date` first, one
      entry per calibration run, each carrying `computed_date`, `period_days`, `decided`,
      `accepted`, `corrected`, `survival_rate`, `keys_learned` and `biased`
- [ ] `?limit=` is clamped to `[1, 100]`, defaulting to 12
- [ ] A run that decided nothing serialises `survival_rate: null`, never `0`
- [ ] `DELETE /api/placement/preferences` removes only the caller's
      `placement_preferences` rows and returns `{ ok: true, cleared: n }`
- [ ] The reset leaves `placement_log` and `placement_survival` untouched
- [ ] The reset writes exactly one audit row when it cleared something, and none when it did not
- [ ] `placementRouter()` is registered in `routes/index.ts`
- [ ] No `client/` file changes

## Tests

New `server/test/placement-routes.test.ts`:

- [ ] `GET /api/placement/survival` on a fresh owner returns `{ runs: [] }` and a 200
- [ ] With three seeded rows, runs come back newest-first
- [ ] `?limit=1` returns one row; `?limit=0` and `?limit=999` clamp to 1 and 100;
      a non-numeric `?limit=abc` falls back to 12
- [ ] A row with `survival_rate` NULL serialises as `null`
- [ ] `DELETE /api/placement/preferences` clears the caller's rows and reports the count
- [ ] After the reset, the owner's `placement_log` and `placement_survival` rows are intact
- [ ] The reset does not touch another owner's `placement_preferences`
- [ ] `GET /api/placement/survival` never returns another owner's rows
- [ ] One `audit_log` row with `action='reset'`, `entity='placement:preferences'` after a
      clearing delete; zero after a no-op delete
- [ ] The existing route-registration / smoke suite passes with the new router mounted

```bash
pnpm --filter server exec vitest run test/placement-routes.test.ts
pnpm --filter server exec vitest run test/placement-learning.test.ts
pnpm --filter server exec vitest run test/baseline.characterization.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given four weekly calibration runs, when `GET /api/placement/survival` is called, then
      the four readings come back newest-first with their survival rates
- [ ] Given an owner who resets their preferences, when the next weekly batch runs, then the
      bands are rebuilt from the surviving log — the adaptation is re-earned, not lost
- [ ] Given two owners, then neither endpoint can reach the other's rows
- [ ] Given a period that decided nothing, then its `survival_rate` is `null` in the response
- [ ] `git diff --stat` touches no file outside the four listed under **Files impacted**

## Subtasks

1. [ ] Read `routes/classification.ts` in full and `accuracyTrend`
2. [ ] Add `survivalTrend` to `services/placement-learning.ts`
3. [ ] Write `routes/placement.ts` with the two routes and the header contract comment
4. [ ] Register it in `routes/index.ts`
5. [ ] Write `placement-routes.test.ts`
6. [ ] Run the four verification commands
