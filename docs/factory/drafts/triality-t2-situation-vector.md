# [Factory] Triality T2 — balanced-ternary situation vector builder

> **Type:** Backend (pure service) · **Phase:** Triality Wave 1 · **Branch:** `feat/triality-vector` · **Commit style:** `feat(triality): situation vector builder with honest zeros` · **Design:** `docs/triality-design.md` §3 + §6 · **Dependencies:** none (0137 mood columns already shipped)

## Goal

`server/src/services/triality-vector.ts`: build the owner's situation vector `s` —
every dimension ∈ {−1, 0, +1}, every dimension **0 when its source has no data**
(the honest-zero rule is this ticket's entire soul; test it dimension by dimension).

## Non-goals

No scoring, no candidates, no dot products (T3). No routes. No new tables. No
external context (weather/location/social are *rejected* dims — design §3). No
LLM anywhere.

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- Dimensions and encodings: the table in design §3 is normative. Sources:
  - work hours + tz: `scheduling_prefs` via `getPrefs` (`services/prefs.ts`)
  - `day_energy`: latest `tasks.completion_mood` whose `reaction_at` is within 3h
    (0137 columns; `reaction_at ≠ completed_at` — use `reaction_at`)
  - `free_gap`: next locked/meeting `time_blocks` row after now, owner-tz
  - `day_type`: `resolveDayType(ownerId, date)` (`services/day-types.ts:26`)
  - `momentum`: running timer = `time_entries.ended_at IS NULL`, else last
    `completed_at` within 30m; −1 = idle >3h during work hours
  - `memory_context`: ONLY when `memory_pull_enabled`; reuse the Phase AA connector
    (`connectors/memory.ts`) with its existing not-connected no-op → 0
  - `cat_deficit[c]` ×6: §6 formula — `stated` from `life_priorities`, `measured`
    from `taskMetrics(owner, days)` (`services/task-metrics.ts:177`) minute shares
    vs `target_hours_per_week`. Missing self-audit or empty window → 0.
  - `motivation_balance` (§3b, needs T2b's column): homeostatic — 30d me-share
    of timed minutes vs the owner's own 90d baseline, ternarized (more
    them-directed than their norm → +1 pull toward `me`; more me-directed → −1;
    in-band or unlabeled-heavy window → 0). ⚠️ scoring treats `us` and NULL both
    as 0, but the share math EXCLUDES NULL-labeled minutes from numerator *and*
    denominator — unlabeled work is unsensed, not shared.
- Owner-tz dates: `localDateInTZ` (`lib/tz.ts:84`); `addDays` (`lib/dates.ts`).
- Injectable clock: take `now: Date` as an argument (callers pass it) — never read
  wall clock inside; this is what makes the whole engine testable and resumable.
- Category vocabulary: the six Balance dimensions
  (health/career/relationships/growth/leisure/finance, mig 0134) — read from
  `tags.kind='category'` `is_base=1`, don't hardcode order.

## Before implementation

Read: design §3/§6 tables; `services/task-metrics.ts` (AxisMetrics shape);
`services/day-types.ts`; the 0137 migration header (mood vocabulary);
`connectors/memory.ts` degradation contract.

## Files impacted

- **New:** `server/src/services/triality-vector.ts`,
  `server/test/triality-vector.test.ts`
- **Changed:** none

## Schema required

None.

## Definition of Done

- [ ] `buildSituationVector(ownerId, now)` returns a typed record of named ternary
      dims + a `meta` block naming which dims were active (non-zero-capable) —
      T3 needs the active-dim count for F normalization
- [ ] Every dim's −1/0/+1 matches the §3 table exactly
- [ ] Zero I/O beyond SQLite reads; deterministic for a fixed DB + `now`

## Tests (`TZ=UTC`, fixed `now`, seeded fixture DB per case — the repo's shared-DB
sequential idiom in `test/helpers.ts`)

- [ ] each dim: one test per row of the §3 table — the +1 state, the −1 state, and
      **the no-data → 0 state** (mandatory per dim; this is the honest-zero contract)
- [ ] `day_energy`: mood 4h old → 0 (recency window); `reaction_at` used, not
      `completed_at` (fixture with divergent stamps)
- [ ] `memory_context`: flag off → 0 without touching the connector (spy/stub)
- [ ] `cat_deficit`: §6 arithmetic spot-checks incl. clamp bounds; no self-audit → all 0
- [ ] determinism: same DB + same `now` twice → deep-equal vectors

Verify: `pnpm --filter server test` · `pnpm typecheck`.

## Acceptance Criteria

A reviewer can map every line of the §3 table to exactly one test name.

## Design note

The dim registry is the system's **blanket-widening point** (design §2b): the
pinned v2 response to plateaued learning is adding dims here, never tuning the
learning rate. Build the registry so a new dim is one entry (name, source,
encoder) plus its tests — no engine changes.

## Subtasks

1. Types + dim registry (name, source, encoder)
2. Encoders per dim, honest-zero first
3. Deficit math on `taskMetrics` + `life_priorities`
4. Test file mirroring the §3 table
