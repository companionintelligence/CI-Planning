# [Factory] Triality T7 — Triality metrics on Balance → Metrics

> **Type:** Backend + Frontend · **Phase:** Triality Wave 4 · **Branch:** `feat/triality-metrics` · **Commit style:** `feat(balance): Triality outcome metrics + learned-weights tiles` · **Design:** `docs/triality-design.md` §9.2 · **Dependencies:** T4 (log rows exist to measure). Parallel-safe with T6 (disjoint files).

## Goal

Balance → Metrics stays the measurement surface and grows Triality tiles: what
the suggestions did, measured from `triality_log` (and, once T8 lands,
`triality_weights`). Existing task metrics untouched. Tiles:

1. **Acceptance per slot** — (staged+opened)/shown for Habitual · Contextual ·
   Novel, per the tab's 7/30/90-day windows.
2. **Novel uptake trend** — is feasible novelty actually taken, sparkline over
   the window.
3. **Deficit response** — for acted-on Contextual/Novel picks in under-served
   categories: did those categories' timed minutes share move (reuses
   `taskMetrics` shares; correlation surfaced honestly as "moved with", never
   "because").
4. **Weights** — effective vs default per slot with sample counts, plus the
   **Reset learning** action. Until T8 lands this tile renders its no-data
   state ("learning not started"), so T7 does NOT depend on T8.
5. **Motivation-axis visuals (§3b/§9.2, needs T2b):** motivation split bar
   (timed minutes me/us/them per window, **unlabeled share always shown** and
   the **llm-tagged share disclosed** — model coverage is not owner testimony);
   **mood by motivation** (existing MoodBar per me/us/them from close-ritual
   data); **drift sparkline** (me-share vs the owner's 90d baseline — the exact
   series `motivation_balance` ternarizes); **acceptance by motivation** among
   the Triality tiles. NULL-vs-`us` distinctness is a test, not a hope.

## Non-goals

No suggestion chips/pills on Balance (Focus owns suggestions — T6). No learning
computation (T8 — this ticket only *reads*). No changes to existing
`taskMetrics` outputs. No new windows beyond the tab's 7/30/90.

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- Server: extend `routes/metrics.ts` (existing surface: `GET /api/metrics/tasks`
  L19, `GET /api/metrics/calibration` L32) with `GET /api/metrics/triality?days=` —
  read-only, flag-gated 404 like the rest of the Triality surface, computed in a
  new `services/triality-metrics.ts` (sibling of `task-metrics.ts`, same
  windowing conventions `Math.max(1, Math.min(365, …))`).
- **Honest-zero tile rule** (BalanceMetrics.tsx header): where there is no data
  the tile says so — zero shown rows ≠ 0% acceptance; render "no suggestions
  shown yet". Slots below their sample floor render the floor copy, not a rate.
- UI: tiles inside `BalanceMetrics.tsx`'s existing grid idiom (MoodBar/stat-tile
  patterns; WINDOWS = [7, 30, 90] const already there — reuse it).
- **Reset learning**: `DELETE /api/triality/weights` (T8 adds the route; T7 ships
  the button wired to it but hidden while the weights tile is in its no-data
  state — no dead buttons).
- Deficit-response arithmetic: shares from `taskMetrics`, under-served set from
  the same §6 ternarization the engine uses — import from T2/T3's module, never
  re-derive (one source of deficit truth).

## Before implementation

Read: `services/task-metrics.ts` (windowing + AxisMetrics), `routes/metrics.ts`,
`BalanceMetrics.tsx` (tile + empty-state idiom), design §6/§6b/§9.2.

## Files impacted

- **New:** `server/src/services/triality-metrics.ts`,
  `server/test/triality-metrics.test.ts`
- **Changed:** `server/src/routes/metrics.ts`, `client/src/lib/api.ts`,
  `client/src/components/BalanceMetrics.tsx` (+ its test file)

## Schema required

None (reads `triality_log`; reads `triality_weights` when it exists — feature-
detect the table? No: T8 orders after T7 in no wave; **pin: query
`triality_weights` only through a helper that returns null pre-T8** — the table
ships in T8's migration, so T7's helper must tolerate its absence via
`sqlite_master` check, mirroring how optional `sqlite-vec` presence is probed).

## Definition of Done

- [ ] `GET /api/metrics/triality` returns per-slot acceptance, novel trend
      buckets, deficit-response deltas, weights (or nulls) — all windowed
- [ ] Tiles render in both themes, every no-data state distinct from zero
- [ ] Flag off → endpoint 404s, tiles absent, existing metrics untouched
- [ ] Zero changes to `GET /api/metrics/tasks` output (snapshot test)

## Tests

- [ ] service: acceptance math per slot incl. ignored-rows exclusion; empty log
      → typed no-data, not zeros
- [ ] deficit response: seeded acted-on Novel pick in an under-served category +
      minutes movement → delta reported; no movement → "no change", not 0-as-signal
- [ ] weights absent (pre-T8) → nulls, endpoint still 200
- [ ] route: flag-off 404; cross-tenant isolation (two-owner fixture)
- [ ] client: tiles render fixtures; no-data copy verbatim; reset button hidden
      in weights-null state
- [ ] snapshot: `metrics/tasks` response unchanged

Verify: `pnpm --filter server test` · `pnpm --filter client test` · both typechecks.

## Acceptance Criteria

An owner two weeks into using the banner opens Balance → Metrics and can answer:
which slot do I actually take, is Novel earning its place, and did following the
pulls move my under-served categories — each answer visibly windowed and honestly
empty where the data is thin.

## Subtasks

1. `triality-metrics.ts` service + tests
2. Route + api.ts
3. Tiles + empty states + tests
4. Reset button (hidden-until-weights) wiring
