> **Type:** Backend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-shortfall-service`
> **Commit style:** `feat(balance): per-dimension target-vs-scheduled shortfall service`
> **Design:** [README.md](README.md)
> **Dependencies:** None

## Goal

Create `server/src/services/balance-budget.ts`: the single deterministic READ that
answers, per life dimension, "what did the owner ask for this week, what is on the
calendar, and how short are they?" Every other ticket in the wave (bias bands, suggest
surface, weekly snapshot) consumes this one service — build it once, here.

## Non-goals

- **Do not touch the engine or agents.** No import from `engine/*` or `agents/*`; this
  ticket has no production caller (tickets 3–6 wire it).
- **Do not write anything.** Pure read, like `suggestEstimate`
  (`services/calibration.ts:312`). No table, no migration, no cron.
- **Do not read `time_entries`.** Timed (actual) minutes are ticket 6's snapshot
  concern; this service measures the CALENDAR (`time_blocks`) against targets.
- **Do not pool owners.** Every query filters `owner_id`; no cross-owner aggregate.
- **Do not add an LLM call or an env/pref knob.** Constants are exported and fixed.

## Pinned conventions

- **Week** = owner-local Monday-start. Copy the `weekDays` rule from
  `services/weekly-review.ts:75-84` (noon-UTC date math, `dow === 0 ? 6 : dow - 1`).
  Anchor: caller passes an owner-local `YYYY-MM-DD` (callers use
  `todayInTZ(ownerTimezone)`); UTC range = `days[0]+'T00:00:00.000Z'` →
  `days[6]+'T23:59:59.999Z'`, exactly as `weeklyReview` builds it. This ignores the
  owner's UTC offset at the week edges — the same accepted imprecision
  `weeklyReview` documents; do not invent a tz-exact variant.
- **Dimensions** = the fixed six: `health | career | relationships | growth | leisure |
  finance` — `life_priorities.category` keys, seeded as `tags.kind='category'` by
  0134. Read the owner's category tag ids by name from `tags WHERE owner_id = ? AND
  kind = 'category' AND is_base = 1`.
- **Block categories derive block-own-else-task** — the `blockCategoryNames` rule
  (`services/blocks.ts:127`). Implement it batched in SQL (two joins + COALESCE
  preference), not by calling the single-row helper in a loop.
- **Which blocks count:** overlap the week range AND
  `status NOT IN ('cancelled','skipped','missed')` — the didn't-happen terminals from
  `TERMINAL_BLOCK_STATUSES` (`services/block-task-sync.ts:39`); `completed` counts
  (it happened). All `block_kind`s count. Overlap minutes are clamped to the week
  bounds (a block spanning Sunday midnight contributes only its in-week part).
  Malformed rows (end ≤ start) contribute 0, mirroring `entryMinutes`
  (`services/triality-vector.ts:236`).
- **A block with N categories contributes its full minutes to each** (no splitting) —
  matches how the drawer's open-task list already treats membership. Say so in a
  comment.
- **Module shape:** SQL as module-level `const` strings, prepared inside functions
  (`services/priorities.ts:32` documents why — §5.5 store-install order).
  `import { store } from '../db/store.js';` — no Drizzle.
- **Exported constants** (cited by tests, not configurable):
  - `SHORTFALL_FLOOR_HOURS = 2` — below this a dimension never enters a bias lead set.
  - `BIAS_DIMENSIONS_MAX = 2` — at most this many dimensions lead, worst-first.
- **Exported functions:**
  - `weekBoundsFor(anchorLocalDate: string): { weekStart: string; startUtc: string; endUtc: string }`
  - `scheduledMinutesByDimension(ownerId: string, anchorLocalDate: string): Promise<Map<string, number>>`
  - `dimensionShortfalls(ownerId: string, anchorLocalDate: string): Promise<DimensionShortfall[]>`
    where `DimensionShortfall = { category: string; target_hours: number; scheduled_minutes: number; shortfall_minutes: number }` —
    `shortfall_minutes = max(0, target_hours*60 − scheduled_minutes)`; one row per
    dimension the owner has a `life_priorities` row for (target 0 ⇒ shortfall 0);
    sorted shortfall-desc then category asc (deterministic).
  - `biasLeadDimensions(shortfalls: readonly DimensionShortfall[]): string[]` — pure:
    filter `shortfall_minutes ≥ SHORTFALL_FLOOR_HOURS*60`, take first
    `BIAS_DIMENSIONS_MAX`.

## Before implementation

Read `services/weekly-review.ts:70-100` (week math), `services/blocks.ts:120-135`
(derive rule), `services/priorities.ts` (module shape, LifePriorityRow),
`services/triality-vector.ts:186-236` (SQL_PRIORITIES, entryMinutes),
`db/migrations/0134_categories_balance.ts` (category seeding).

## Files impacted

**New:**
- `server/src/services/balance-budget.ts`
- `server/test/balance-budget.test.ts`

**Changed:** none.

## Schema required

None.

## Definition of Done

- [ ] All four functions + both constants exported, typed, documented with a header
      comment stating the instruction-not-evidence rationale (README decision 2)
- [ ] No writes anywhere in the module; no `engine/*`/`agents/*` imports
- [ ] Week math byte-matches the `weekDays` rule
- [ ] Owner isolation on every query

## Tests

- [ ] `weekBoundsFor('2026-08-29')` (a Saturday) → weekStart `2026-08-24` (Monday)
- [ ] A Sunday anchor maps to the PRECEDING Monday (`dow===0` branch)
- [ ] Block with own categories uses them; task-backed block with none inherits the task's
- [ ] `cancelled`/`skipped`/`missed` blocks contribute 0; `completed` contributes fully
- [ ] A block spanning the week edge contributes only clamped minutes
- [ ] Two-category block counts fully in both dimensions
- [ ] Target 14 h, 4 h scheduled → shortfall 600; target 0 → shortfall 0
- [ ] `biasLeadDimensions`: floor excludes a 1.9 h shortfall; cap returns 2 of 3 eligible, worst-first
- [ ] Owner B's blocks/targets never leak into owner A's numbers

```bash
pnpm --filter server exec vitest run server/test/balance-budget.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an owner with targets and a part-filled week, when `dimensionShortfalls`
      runs, then each dimension reports target/scheduled/shortfall consistent with the
      pinned counting rules, deterministically ordered
- [ ] Given no `life_priorities` rows, then the result is `[]` and nothing throws

## Subtasks

1. [ ] Read the Before-implementation files
2. [ ] Write `weekBoundsFor` (copy `weekDays` math)
3. [ ] Write the batched scheduled-minutes SQL (derive rule, status filter, clamp)
4. [ ] Write `dimensionShortfalls` + `biasLeadDimensions`
5. [ ] Write the nine tests
6. [ ] Run verification
