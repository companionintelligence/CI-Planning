> **Type:** Backend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-order-band`
> **Commit style:** `feat(planner): balance band in day-order authoring`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by tickets 1 (service) and 2 (pref); independent of 3

## Goal

Give under-served dimensions an ordering band in day authoring
(`agents/plan.ts`), the surface whose frozen order placement actually reads: a
`balanceLead` set flows through `deterministicIndices`, `checkOrder`, and (as a soft
prompt line) the LLM path — the exact mechanism `memoryRelated` (AA3a) and
`newToday` already use. Inert when empty.

## Non-goals

- **Do not outrank the existing bands.** Band position is pinned LAST: theme →
  memory → new_today → **balance** → due/priority. Theme is an explicit "today is X"
  instruction; balance is a weekly nudge. (Also a cross-wave courtesy — README:
  G-INT may add its own band; last-place lets a sibling slot ahead without conflict.)
- **Do not make the LLM line an instruction.** The prompt line is phrased as context
  ("Behind weekly targets: health (10h short)"), soft like `memoryOrderLine` — never
  "you must schedule".
- **Do not compute shortfalls inside `deterministicIndices` or `checkOrder`.** They
  stay pure; `authorPlanOrder` computes the set once (gated) and passes it down —
  exactly how `memoryRelated` is threaded.
- **Do not touch `autoplan.ts`** (ticket 3) or reflow. No schema, no client change.

## Pinned conventions

- **Set semantics:** `balanceLead: Set<string>` of task_ids. Built in
  `authorPlanOrder` (~line 686, next to the `newToday` build): gate on
  `balance_bias_enabled` (absent row ⇒ ON) — add the column to the existing
  `loadPlanningPrefs` SELECT (`plan.ts:83`) rather than a second query — then
  `dimensionShortfalls(owner, date)` + `biasLeadDimensions` from
  `services/balance-budget.js` (anchor = the `date` being authored), then one batched
  `entity_categories` query mapping staged task_ids → lead membership. Empty set on
  pref-off / no targets / under-floor / any service error (try/catch to empty +
  debug log — authoring's never-throws invariant, `plan.ts:712` comment).
- **`deterministicIndices`** (`plan.ts:711`): new optional trailing param
  `balanceLead?: Set<string>`; comparator `balCmp` cloned from `newCmp`
  byte-for-byte (0/1 membership rank, inert on absent/empty), evaluated after
  `newCmp`, before `dueCmp`/`priCmp`.
- **`checkOrder`** (`plan.ts:456`): new optional trailing param
  `balanceLead?: Set<string>`; a lead task may precede a higher-priority or
  earlier-due non-lead without being flagged — extend the existing exemption
  predicate exactly the way `themed`/`related` (`plan.ts:465-466`) already compose.
  Every call site in `authorPlanOrder` (both the deterministic persist and the
  `runLoop` check callback) passes the same set.
- **LLM path:** `balanceLine(shortfalls)` helper beside `memoryOrderLine`, rendering
  at most `BIAS_DIMENSIONS_MAX` dimensions as
  `Behind weekly targets: health (10h short), growth (3h short).`, empty string when
  none; concatenated into `genPrompt` the same way `memoryLine` is. Hours rounded to
  whole; no task ids in the line.
- **Persisted order** remains the only engine contract — placement reads
  `daily_plan`; nothing else changes.

## Before implementation

Read `agents/plan.ts:711-760` (`deterministicIndices` + band comparators),
`:456-520` (`checkOrder` exemptions), `:686-745` (`authorPlanOrder` set builds +
`persistDeterministic` + `runLoop` wiring), `memoryOrderLine` and its `genPrompt`
splice, and `server/test/aa3-memory-ordering.test.ts` — your test file mirrors it.

## Files impacted

**Changed:**
- `server/src/agents/plan.ts`

**New:**
- `server/test/balance-order-band.test.ts`

## Schema required

None.

## Definition of Done

- [ ] Empty/absent set ⇒ `deterministicIndices` and `checkOrder` byte-identical
      (assert against a fixture order)
- [ ] Lead tasks lead within their theme band; theme, memory and new_today all still
      outrank balance
- [ ] `checkOrder` raises no inversion defect for a band-legal lead, and still
      catches a genuine inversion between two non-lead tasks
- [ ] `balanceLine` caps at `BIAS_DIMENSIONS_MAX`, empty-string when none
- [ ] Pref off ⇒ no shortfall query runs (spy/count), order unchanged
- [ ] Service throw ⇒ deterministic order persists, no rejection

## Tests

- [ ] Band order: theme > memory > new_today > balance > due > priority (one fixture
      exercising all)
- [ ] Inert-when-empty characterization vs current order
- [ ] `checkOrder` exemption + non-exemption cases
- [ ] `balanceLine` rendering: two dims, rounding, empty
- [ ] Gate + error-degrade cases
- [ ] Owner isolation via the service (mock returns per-owner)

```bash
pnpm --filter server exec vitest run server/test/balance-order-band.test.ts
pnpm --filter server exec vitest run server/test/authoring.test.ts server/test/aa3-memory-ordering.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given Health 10 h short and a staged Health task, when the day is authored
      deterministically, then that task precedes equal-band non-lead tasks
- [ ] Given `balance_bias_enabled = 0`, then authored order is byte-identical to today

## Subtasks

1. [ ] Extend `loadPlanningPrefs` SELECT + `PlanningPrefs` type
2. [ ] Build `balanceLead` in `authorPlanOrder` (gated, guarded)
3. [ ] Add `balCmp` to `deterministicIndices`; thread param
4. [ ] Extend `checkOrder` exemption; update both call sites
5. [ ] Add `balanceLine` + `genPrompt` splice
6. [ ] Tests; run verification incl. existing authoring suites
