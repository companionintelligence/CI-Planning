> **Type:** Backend
> **Phase:** Placement-learning wave — G-INT (timing intelligence)
> **Branch:** `feat/placement-bias-gap-choice`
> **Commit style:** `feat(engine): bias gap choice toward the owner's learned hour band`
> **Design:** [README.md](README.md)
> **Dependencies:** Ticket 4 (`placement_preferences` is being written)

## Goal

The apply stage. `pickGap` gains an optional pure scoring function; when an owner has a
learned band for the work's `slot_key`, the Auto engine prefers a fitting gap inside that
band over the strict least-leftover one — but only within a hard fragmentation budget, and
only among gaps `pickGap` had **already accepted as fitting**.

This is the whole of the influence. Nothing moves an existing block, nothing overrides a
lock, a pin, a deadline or an obstacle, and with no learned row the function returns
byte-identically to today.

## Non-goals

- **Do not move, re-time or delete any existing block.** The bias affects only which free
  gap a *new* placement lands in.
- **Do not touch the truncating fallback.** When no gap fits, `pickGap` still returns the
  largest remaining gap, unbiased. A forced placement is not a preference and must not be
  dressed up as one.
- **Do not bias `patterns-place.ts` or `blocks-place.ts`.** Their two `pickGap` calls pass no
  scorer and must compile and behave unchanged — the parameter is optional precisely so they
  are untouched by the unmerged `wip/patterns-place-pinning` (`8bad3350`) rewrite of both files.
- **Do not change task ORDER.** `orderByOverdue`, `orderByNewToday` and the deadline-first
  sort are out of scope. This ticket changes *where a task goes*, never *which task goes first*.
- **Do not add a suppression, blocklist or forbidden-hours path.** A gap the band scores 0
  is still fully eligible; a low score can only lose a tie-break, never remove an option.
- **Do not add a knob.** No `placement_bias_strength`, no env var, no `scheduling_prefs`
  column. `MAX_FRAGMENT_COST_MS` and `BAND_FALLOFF_HOURS` are named constants cited by tests.
- **Do not make `scheduler.ts` impure.** It must not import `store`, `ownerTimezone` or the
  learning service. The caller builds the closure and passes it in.
- **Do not read `placement_log`.** The apply stage is a pure read of what the last batch
  produced — the same rule `retrieveExemplars` follows.
- **No migration, no route, no client change.**

## Pinned conventions

Verified against the tree — do not substitute.

- **Signature.** `export function pickGap(gaps: Gap[], wantMs: number, score?: (startMs: number) => number): { gap: Gap; len: number } | null`
  in `server/src/engine/scheduler.ts:44`. Additive third parameter — all four existing call
  sites (`autoplan.ts:439`, `blocks-place.ts:105`, `patterns-place.ts:235`, `:270`) compile
  untouched.
- **Constant placement.** `MAX_FRAGMENT_COST_MS = 60 * MS_PER_MIN` beside `MIN_SESSION_MS`
  in `scheduler.ts`, exported, with a comment: a preferred slot may cost at most one hour of
  extra day fragmentation, because fragmentation is a real cost paid by every later
  placement and the bias must never be able to shred a day.
- **Algorithm.** Compute `fit` / `fitLeftover` / `largest` / `largestFree` exactly as the
  current body does, then:
  1. if `score` is absent **or** `fit` is null → return today's result unchanged;
  2. eligible = gaps with `free >= wantMs` and `(free - wantMs) <= fitLeftover + MAX_FRAGMENT_COST_MS`;
  3. rank eligible by `score(g.cursor)` **descending**, then `(free - wantMs)` ascending,
     then `g.start` ascending; return `{ gap: winner, len: wantMs }`.
  The third tiebreak is not decoration: today's loop uses a strict `<`, so on equal leftover
  the first gap in day order wins. Reproducing that is what makes a neutral scorer
  byte-identical.
- **Scorer.** `placementScorer(ownerId, slotKey)` in `services/placement-learning.ts` returns
  `((startMs: number) => number) | null`, resolving `ownerTimezone` once and closing over the
  row's `p25_hour` / `p75_hour`. `null` when no row exists — the caller then passes
  `undefined` and nothing changes.
- **Score shape.** `1` when the local fractional hour is within `[p25_hour, p75_hour]`;
  otherwise `Math.max(0, 1 - hoursOutside / BAND_FALLOFF_HOURS)` with
  `BAND_FALLOFF_HOURS = 3`. Bounded to `[0, 1]`, continuous, no configuration.
  Local fractional hour from `utcToZonedWallTime(iso, tz)` (`lib/tz.ts:68`):
  `h + m / 60` from the returned `'HH:MM'`.
- **Call site.** `autoplan.ts:439` only, reusing the per-run slot-key `Map` cache ticket 2
  added; add a second `Map` from `slotKey` to scorer so a run resolves each band once.
- **Reflow.** `reflow()` re-places through `placeFlightPlan`, so re-placements are biased
  too. That is correct — a re-place is a new placement — and it is already bounded by
  auto-defense's anti-thrash rules: in-progress blocks are never moved, locked blocks are
  held, and blocks moved within `STABILITY_WINDOW_MS` (`auto-defense.ts:46`, 5 minutes) are
  held. Do not add a second thrash guard here.

## Before implementation

Read `engine/scheduler.ts` lines 16–67 (`Gap`, `MIN_SESSION_MS`, `pickGap` in full),
`engine/autoplan.ts` lines 415–455 (the placement loop and the cursor advance),
`engine/auto-defense.ts` lines 20–50 (the anti-thrash rules and `STABILITY_WINDOW_MS`),
`services/classification-learning.ts` lines 353–447 (`retrieveExemplars` /
`classificationHint` — the "apply is a pure read of the last batch" shape), and the
`placement_preferences` DDL in ticket 1.

## Files impacted

**New:**
- `server/test/placement-bias.test.ts`

**Changed:**
- `server/src/engine/scheduler.ts` — `MAX_FRAGMENT_COST_MS`, `pickGap`'s third parameter
- `server/src/services/placement-learning.ts` — `BAND_FALLOFF_HOURS`, `placementScorer`
- `server/src/engine/autoplan.ts` — resolve and pass the scorer at the one `pickGap` call

## Schema required

None — ticket 1 landed `placement_preferences` and ticket 4 fills it.

## Definition of Done

- [ ] `pickGap(gaps, wantMs)` with two arguments returns exactly what it returns on `main`,
      for every input — proved by the existing suites passing unchanged
- [ ] A scorer that returns the same number for every gap also returns today's result
- [ ] `MAX_FRAGMENT_COST_MS = 60 * MS_PER_MIN` and `BAND_FALLOFF_HOURS = 3` are exported
      constants with `/** why */` comments
- [ ] A gap outside the fragmentation budget is never chosen, however well it scores
- [ ] The truncating fallback path is never biased
- [ ] `placementScorer` returns `null` for an owner or key with no row, and the placement
      loop then behaves identically to today
- [ ] A run resolves each `slot_key`'s scorer at most once
- [ ] Nothing in `engine/scheduler.ts` imports `store`, `ownerTimezone` or the learning service

## Tests

New `server/test/placement-bias.test.ts`:

- [ ] **`pickGap` unit, no scorer** — a table of gap sets, asserting identical output to the
      documented current behaviour (best-fit, else largest, else null)
- [ ] **Neutral scorer** — `() => 1` over the same table yields identical output
- [ ] **Bias within budget** — two fitting gaps, the second scoring higher and costing 30 min
      more leftover → the second wins
- [ ] **Budget respected** — the same, but the preferred gap costs 90 min more leftover →
      the least-leftover gap wins
- [ ] **No fitting gap** — a task larger than every gap with a scorer present → the largest
      gap, truncated, exactly as unbiased
- [ ] **Score ties** — equal scores and equal leftover → the earliest gap, matching today
- [ ] **Band edges** — a start exactly at `p25_hour` and exactly at `p75_hour` both score 1
- [ ] **Falloff** — 3 hours outside the band scores 0; 1.5 hours outside scores 0.5
- [ ] **End to end** — an owner with an evening `work` band, a free day, one staged `work`
      task → the block lands in the evening; delete the preference row and it lands in the
      morning again
- [ ] **Owner isolation** — owner A's band never affects owner B's placement
- [ ] **Obstacles still win** — a band-preferred window fully occupied by a meeting is not
      chosen; the block goes elsewhere
- [ ] **Locks still win** — a locked block in the preferred window is not displaced
- [ ] `auto-placement.test.ts`, `auto-defense.test.ts`, `auto-overlap.test.ts`,
      `auto-nest.test.ts`, `auto-mode.test.ts`, `blocks-place.test.ts`,
      `patterns-place.test.ts`, `l02-first-placement.test.ts` and `reflow-wipe.test.ts` all
      pass unchanged

```bash
pnpm --filter server exec vitest run server/test/placement-bias.test.ts
pnpm --filter server exec vitest run server/test/auto-placement.test.ts
pnpm --filter server exec vitest run server/test/patterns-place.test.ts
pnpm --filter server exec vitest run server/test/blocks-place.test.ts
pnpm --filter server exec vitest run server/test/reflow-wipe.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an owner with no `placement_preferences` rows, when Auto runs, then every block
      lands exactly where it does on `main`
- [ ] Given an owner with a 17:00–20:00 `work` band and a fully free day, when Auto places a
      `work` task, then it lands between 17:00 and 20:00 local
- [ ] Given the same owner and a day whose only fitting gap is 09:00–10:00, then the task
      still lands at 09:00 — a band never prevents a placement
- [ ] Given a preferred gap that would leave 90 extra minutes of fragmentation, then the
      least-leftover gap is still chosen
- [ ] Given a locked block occupying the band, then it is not moved and nothing overlaps it
- [ ] `git diff --stat` touches no file outside the four listed under **Files impacted**

## Subtasks

1. [ ] Read the five sources under **Before implementation**
2. [ ] Add `MAX_FRAGMENT_COST_MS` and the optional `score` parameter to `pickGap`, keeping the
       existing two-argument behaviour bit-exact
3. [ ] Add `BAND_FALLOFF_HOURS` and `placementScorer` to `services/placement-learning.ts`
4. [ ] Resolve the scorer per `slot_key` in the Auto placement loop and pass it to `pickGap`
5. [ ] Write `placement-bias.test.ts`
6. [ ] Run the six verification commands; confirm all nine existing engine suites are untouched
