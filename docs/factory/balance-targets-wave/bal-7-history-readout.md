> **Type:** Backend + Frontend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-history-readout`
> **Commit style:** `feat(balance): met-target history readout in the dimension drawer`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 6

## Goal

Read the frozen history back to the owner: "met target 2 of the last 6 recorded
weeks" in the dimension drawer. This is what makes the loop falsifiable — the
close-loop wave's rule that the readout is not "just reporting" and must not be
dropped. It is also the surface a future learning conversation ("lower the target or
protect the time?") will grow from; this wave stops at showing the truth.

## Non-goals

- **Do not interpret.** No advice, no trend arrows, no "consider lowering your
  target" copy — a count and the weeks, nothing else. The learning conversation is a
  future wave (README follow-ups).
- **Do not feed history into bias, prompts, or the engine.** The log's only reader
  is this endpoint (wave invariant, ticket 6).
- **Do not render in Balance.tsx** — drawer only; the Balance view stays
  current-week-focused (ticket 5).
- **No schema.**

## Pinned conventions

- **"Met"** = `scheduled_minutes >= target_hours * 60` for a week-row with
  `target_hours > 0`. Rows with `target_hours = 0` are excluded from BOTH counts
  (a week with no target can be neither met nor missed) — pin this in the service
  comment; it is the semantic a reviewer will question. Scheduled, not timed:
  the wave's apply is about the calendar; showing timed here would silently change
  the metric the bias acts on. (timed_minutes stays recorded for the future wave.)
- **Bounded retrieval:** `HISTORY_WEEKS_MAX = 12` exported from
  `services/balance-snapshot.ts`; the query is
  `SELECT week_start, category, target_hours, scheduled_minutes FROM balance_week_log WHERE owner_id = ? ORDER BY week_start DESC LIMIT ?`
  with `LIMIT HISTORY_WEEKS_MAX * 6` — never unbounded.
- **Route:** `GET /api/priorities/history` in `routes/priorities.ts` →
  `{ weeks_recorded: number, dimensions: Array<{ category, met_weeks, counted_weeks, recent: Array<{ week_start, met }> }> }`
  (`recent` newest-first, already capped by the limit). Service function
  `balanceHistory(ownerId)` in `balance-snapshot.ts` does the shaping; the route
  stays thin-transport.
- **Client:** `api.priorities.history()` in `api.ts`; in `DimensionPanel`
  (`DetailsDrawer.tsx:586`) one line under the Alignment group:
  `Met target {met} of last {counted} weeks` — rendered only when
  `counted_weeks > 0`, so pre-history installs show nothing (not "0 of 0"). Resource
  `catch(() => null)`, render guarded — endpoint failure leaves the drawer as today.
- **No pref gate** — pure read, same reasoning as ticket 5.

## Before implementation

Read ticket 6's service + table, `routes/priorities.ts` as changed by ticket 5,
`DetailsDrawer.tsx:586-625` as changed by ticket 5.

## Files impacted

**Changed:**
- `server/src/services/balance-snapshot.ts` — add `balanceHistory` + constant
- `server/src/routes/priorities.ts`
- `client/src/lib/api.ts`
- `client/src/components/DetailsDrawer.tsx`

**New:**
- `server/test/balance-history.test.ts`

## Schema required

None.

## Definition of Done

- [ ] Endpoint returns met/counted per dimension per the pinned "met" rule
- [ ] Zero-target weeks excluded from both counts; retrieval capped at 12 weeks
- [ ] Drawer renders the line only when history exists; failure-silent
- [ ] Log still has exactly one reader (this endpoint) — assert via grep in review

## Tests

- [ ] 6 seeded weeks, 2 met ⇒ `met_weeks: 2, counted_weeks: 6`
- [ ] A zero-target week ⇒ excluded from both counts
- [ ] 14 seeded weeks ⇒ only newest 12 counted
- [ ] Exactly-met boundary (`scheduled == target*60`) counts as met
- [ ] Owner isolation; empty log ⇒ `weeks_recorded: 0`, no throw

```bash
pnpm --filter server exec vitest run server/test/balance-history.test.ts
pnpm typecheck && pnpm test
```

## Acceptance Criteria

- [ ] Given six recorded weeks with two met, when the owner opens the dimension
      drawer, then it reads "Met target 2 of last 6 weeks"
- [ ] Given a fresh install with no history, then the drawer shows no history line

## Subtasks

1. [ ] `balanceHistory` + constant + "met" comment
2. [ ] Route + api.ts
3. [ ] Drawer line
4. [ ] Five tests; run verification
