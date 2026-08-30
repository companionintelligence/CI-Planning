> **Type:** Backend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-candidate-bias`
> **Commit style:** `feat(engine): band under-served dimensions into flight-plan candidate fill`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by tickets 1 (service) and 2 (pref)

## Goal

Make "Fill Flight Plan" propose tasks from under-served dimensions. Today
`fillFlightPlanCandidates` (`engine/autoplan.ts:758`) selects the top
`CANDIDATE_LIMIT` (20) open tasks by `priority, due_at, id` — a Health task ranked
25th never gets staged, so ordering bias downstream (ticket 4) could never see it.
This ticket widens the fetch and applies a band so lead-dimension tasks are proposed,
without ever excluding a task the old query would have staged... unless it falls off
the same LIMIT it always could.

## Non-goals

- **Do not touch placement.** `placeFlightPlan`, `fillByPriority`, obstacles, gaps —
  untouched. This biases what gets PROPOSED into staging (step 1 'fill'), nothing else.
- **Do not auto-select differently.** Candidates arrive `selected = 1` exactly as
  today (deselect-to-exclude model, req 8) — the user's one-glance veto is the guard.
- **Do not exceed the band.** Only dimensions from `biasLeadDimensions` (floor 2 h,
  cap 2 — ticket 1's exported constants) lead; within each half the existing
  `priority, due_at, id` order is preserved (stable partition, not a re-sort).
- **Do not change behaviour when the pref is off, no targets exist, or no dimension
  clears the floor** — those paths must run the ORIGINAL single query, byte-identical
  result, zero extra queries beyond the one pref/shortfall check.
- **No schema, no route, no client change.**

## Pinned conventions

- **Widened fetch bound:** `CANDIDATE_LIMIT * 3` (60) — a named local
  `WIDEN_FACTOR = 3` with a comment: wide enough to surface backlog tasks in a
  neglected dimension, bounded so the fill can't scan an unbounded backlog. Final
  slice is still exactly `CANDIDATE_LIMIT`.
- **Band membership:** a candidate is lead iff it has an `entity_categories` row
  (`entity_kind='task'`) for a lead dimension's category tag id. Resolve names→ids
  via `tags WHERE owner_id = ? AND kind = 'category'` (the 0134 axis). One batched
  `IN (...)` query over the fetched candidate ids — never per-task queries.
- **Gate order (cheapest first):** read
  `scheduling_prefs.balance_bias_enabled` (treat absent row as ON, matching the
  DEFAULT) → if off, original path. Then `dimensionShortfalls` +
  `biasLeadDimensions` from `services/balance-budget.js` with
  `anchorLocalDate = fillDate` (the function's existing owner-local date) → if
  empty, original path.
- **Stability:** partition, preserving SQL order inside each half — implement as
  `[...leads, ...rest]` from a single pass, no comparator.
- **Never throws:** wrap the bias path so any error falls back to the original
  query result (log at `debug` via `lib/logger.js`); a broken bias must not break
  staging.
- **Import direction:** `engine/autoplan.ts` imports from
  `services/balance-budget.js` — same direction as its existing
  `services/pattern-blocks.js` imports; no new cycle (`balance-budget` imports no
  engine module, pinned in ticket 1).

## Before implementation

Read `engine/autoplan.ts:754-795` (the function, its SQL, the `INSERT OR IGNORE`
tail), ticket 1's service header, and `engine/autoplan.ts:99-108` (`tagsOf` — note
you are NOT reusing it: it reads `entity_tags` levels, not `entity_categories`).

## Files impacted

**Changed:**
- `server/src/engine/autoplan.ts` — `fillFlightPlanCandidates` only

**New:**
- `server/test/balance-candidate-bias.test.ts`

## Schema required

None.

## Definition of Done

- [ ] Pref off / no targets / under floor ⇒ staged set and order byte-identical to
      today (characterization asserted, not assumed)
- [ ] With a ≥2 h shortfall dimension, a matching task ranked past position 20 in the
      base order gets staged
- [ ] Lead tasks precede non-lead in `flight_plan.position`; each half keeps
      `priority, due_at, id` order
- [ ] At most `CANDIDATE_LIMIT` rows inserted; `requireEstimate`/`scheduled_for`
      clauses untouched
- [ ] A thrown service error degrades to the unbiased result

## Tests

- [ ] Characterization: bias off ⇒ identical staging to a pre-change snapshot
- [ ] Health 14 h target, 0 scheduled, Health task at base-rank 25 ⇒ staged
- [ ] Two eligible dimensions ⇒ both lead, worst-first blocks; third (cap) does not
- [ ] 1.9 h shortfall ⇒ inert (floor, cited from the exported constant)
- [ ] Stable order inside each half
- [ ] Owner isolation: owner B's targets don't bias owner A's fill
- [ ] Service throw ⇒ unbiased result, no rejection

```bash
pnpm --filter server exec vitest run server/test/balance-candidate-bias.test.ts
pnpm --filter server exec vitest run server/test/auto-placement.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an under-served dimension with open tasks, when the owner taps Fill,
      then at least one task from that dimension is proposed (selected, vetoable)
- [ ] Given `balance_bias_enabled = 0`, then the fill is byte-identical to today's

## Subtasks

1. [ ] Add the widened-fetch + partition path behind the two gates
2. [ ] Batched category-membership query
3. [ ] Fallback wrapper + debug log
4. [ ] Seven tests incl. characterization
5. [ ] Run verification (incl. existing auto-placement suite)
