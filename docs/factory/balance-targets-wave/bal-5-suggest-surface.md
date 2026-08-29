> **Type:** Backend + Frontend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-suggest-surface`
> **Commit style:** `feat(balance): shortfall read API + one-tap stage from the dimension drawer`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 1; independent of 2/3/4

## Goal

Surface the shortfall where the owner already looks — the Balance view and the
dimension drawer — with a one-tap "stage a task" action. The read is pure; **the
human tap is the write** (precedent: `suggestEstimate` is "PURE READ — it never
writes", `services/calibration.ts:8`; the accept is the write). This is the suggest
half of the owner's bias+suggest ruling, and it works even with the bias pref off.

## Non-goals

- **Do not gate on `balance_bias_enabled`.** The pref gates bias; this is a read the
  owner must act on. (README decision; say so in a route comment.)
- **Do not auto-place or auto-stage.** The endpoint returns data; only the tap calls
  the existing staging API. No new write endpoint at all.
- **Do not duplicate week math client-side.** The server number is the single source
  (README follow-up: supersedes `e7359a3c`'s client-side rollup if that branch merges).
- **Do not redesign Balance.tsx.** One line + one button on existing surfaces.

## Pinned conventions

- **Route:** extend `server/src/routes/priorities.ts` (thin-transport doctrine in
  its header):
  `GET /api/priorities/shortfalls` →
  `{ week_start: string, shortfalls: Array<{ category, target_hours, scheduled_minutes, shortfall_minutes, suggested_task_ids: string[] }> }`.
  Anchor = `todayInTZ(ownerTimezone)`; delegate to `dimensionShortfalls`. Requires
  read auth like the sibling GET (the route file is not in `PUBLIC_PREFIXES`).
- **Suggested tasks — bounded retrieval:** per dimension, at most
  `SUGGEST_TASKS_MAX = 3` (new exported const in `services/balance-budget.ts`) open
  tasks (`status = 'open'`, `parent_id IS NULL`, `recurrence_parent_id IS NULL`,
  not already in `flight_plan`) whose `entity_categories` include the dimension,
  ordered `priority, COALESCE(due_at,'9999-12-31'), id` — the exact candidate-fill
  order (`engine/autoplan.ts:780`). Implemented in the service, not the route.
- **Client api:** `client/src/lib/api.ts` — `api.priorities.shortfalls()` typed to
  the payload, next to the existing `api.priorities.list()`.
- **Drawer:** `client/src/components/DetailsDrawer.tsx` `DimensionPanel`
  (line 586): add to the Alignment `<dl>` a
  `<Field label="Unallocated">{...}h this week</Field>` (shortfall rounded to one
  decimal; render `0h` when met — meeting a target is information too), and below
  the grid a `<button>` "Stage a task" shown only when `shortfall_minutes > 0` and
  `suggested_task_ids.length > 0`; tap calls the EXISTING
  `api.flightPlan.stage(taskId)` (`api.ts:539`, POSTs `/flight-plan` with
  `{ task_id }`) for the first suggested id, then refetches the resource. Style:
  reuse the `drawer-pill`/`drawer-tag` classes already in the panel — no new CSS.
- **Balance view:** `client/src/views/Balance.tsx` dimension card (the
  `{p().target_hours_per_week}h/wk target` line, ~179): append
  ` · Nh unallocated` when > 0, from the same single `shortfalls()` resource
  fetched once per view (never per card).
- **Failure:** resource `catch (() => null)` and every render guarded — the drawer
  must render exactly as today when the endpoint fails (matches the panel's
  existing `.catch(() => [])` pattern).

## Before implementation

Read `routes/priorities.ts` (whole file — it is short), `services/calibration.ts:300-345`
(suggest-only precedent), `DetailsDrawer.tsx:586-625`, `Balance.tsx:150-200`,
`api.ts:530-548` and `:1091` region.

## Files impacted

**Changed:**
- `server/src/services/balance-budget.ts` — add `SUGGEST_TASKS_MAX` + suggested-task query
- `server/src/routes/priorities.ts`
- `client/src/lib/api.ts`
- `client/src/components/DetailsDrawer.tsx`
- `client/src/views/Balance.tsx`

**New:**
- `server/test/balance-shortfalls-api.test.ts`

## Schema required

None.

## Definition of Done

- [ ] GET returns per-dimension shortfall + ≤3 suggested open task ids in the pinned order
- [ ] No write path anywhere in this ticket's server code
- [ ] Drawer shows Unallocated + stage button per the pinned rules; tap stages via
      the existing endpoint and the panel refreshes
- [ ] Balance card shows the unallocated suffix only when > 0
- [ ] Endpoint failure leaves both surfaces rendering as today

## Tests

- [ ] API: target 14 h / 4 h scheduled ⇒ `shortfall_minutes: 600`
- [ ] API: at most 3 suggestions, correct order, staged/subtask/instance tasks excluded
- [ ] API: owner isolation
- [ ] API: no `life_priorities` rows ⇒ `shortfalls: []`
- [ ] API: auth required (401 unauthenticated, matching the sibling GET's behavior)

```bash
pnpm --filter server exec vitest run server/test/balance-shortfalls-api.test.ts
pnpm typecheck && pnpm test
```

## Acceptance Criteria

- [ ] Given Health 10 h unallocated with open Health tasks, when the owner opens the
      Health drawer, then they see "10h this week" and one tap stages the top task
      into the flight plan (nothing placed on the calendar)
- [ ] Given every target met, then the drawer shows 0h and no button

## Subtasks

1. [ ] Service: suggested-task query + constant
2. [ ] Route + api.ts client
3. [ ] Drawer field + button; Balance suffix
4. [ ] Five API tests
5. [ ] Run verification
