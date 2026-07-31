# [Factory] Triality T8 — bounded learning loop (`calibrate_triality`)

> **Type:** Backend · **Phase:** Triality Wave 5 · **Branch:** `feat/triality-learning` · **Commit style:** `feat(triality): weekly weight calibration from outcome log` · **Design:** `docs/triality-design.md` §6b (owner-locked: the system learns over time, bounded) · **Dependencies:** T3 (getWeights seam), T4 (outcomes exist); T7 recommended first (metrics display the result) but not required.

## Goal

The `calibrate_estimates` pattern applied to Triality: a weekly, owner-scoped
`calibrate_triality` job recomputes per-(owner, slot) weight adjustments from
`triality_log` outcomes into the regenerable `triality_weights` table; the T3
`getWeights` seam starts reading it; a reset route drops it. Deterministic,
clamped, floored, visible.

## Non-goals

No online/mid-request updates. No new signals beyond the §6b reward map. No
per-category or per-time-of-day weight splits (v2 at the earliest). **No
learning-rate knob, ever** — the 0.5 factor is a named constant, and the pinned
response to weak learning is widening the blanket (T2's dim registry, design
§2b), not turning this up. No UI beyond
what T7 already built (this ticket makes T7's weights tile light up). No changes
to defaults or slot targets. No cross-owner pooling — ever.

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- **Update rule = §6b verbatim:** reward map (staged +1 · opened +0.5 ·
  dismissed −1 · shown>24h −0.25), 90d window, `delta_k = mean(reward_i ·
  (s_k,i − mean(s_k)))` per component from the persisted `scores` JSON,
  `w_k = clamp(default_k·(1+0.5·delta_k), 0.5·default_k, 2·default_k)`,
  renormalize to the default sum. Floor: <20 outcome-bearing rows per slot →
  no row written (absence = defaults).
- Job registration: the 0136 `enrich_tasks` migration is the model — `INSERT OR
  IGNORE INTO scheduled_jobs (id, name, kind, cron)` with a weekly cron; add the
  `case 'calibrate_triality'` to the `execute` switch in `jobs/index.ts`, and
  **add the kind to `OWNER_SCOPED_KINDS`** (jobs/index.ts ~L406–425 region —
  per-owner fan-out; the purge_objectives comment explains the distinction).
- ⚠️ WHO-stamp rule (owner ruling 2026-07-16): this is a cron/agent write — it
  must NOT stamp owner attribution; judge stampRow by its caller.
- `calibrate_estimates` + `calibration_history` (0138 header) are the shape to
  study: rollup regenerable & replaced wholesale; history lives elsewhere
  (here: `triality_log` itself — no new history table).
- Reset: `DELETE /api/triality/weights` in `routes/triality.ts` — owner-initiated,
  write scope, audited (`writeAudit`, owner actor), deletes the owner's rows only;
  T7's button is already wired to it.
- Migration: `triality_weights` — `owner_id` TEXT NOT NULL REFERENCES owners(id)
  ON DELETE CASCADE · `slot` TEXT NOT NULL · `weights` TEXT NOT NULL (JSON) ·
  `sample_count` INTEGER NOT NULL · `computed_date` TEXT NOT NULL · PRIMARY KEY
  (owner_id, slot). Next-free number; **add to `resetDb`**.
- Job counts move: 19→20 cron rows, 20→21 kinds — the doc edits land in T9, but
  this ticket's DoD includes flagging it there.

## Before implementation

Read: design §6b in full; `jobs/index.ts` (`execute` switch, `OWNER_SCOPED_KINDS`,
`runScheduledJob`); the `calibrate_estimates` service; 0136/0138 migrations;
T3's `getWeights` seam and its stub test.

## Files impacted

- **New:** `server/src/db/migrations/<next-free>_triality_weights.ts`,
  `server/src/services/triality-learning.ts`,
  `server/test/triality-learning.test.ts`
- **Changed:** `server/src/db/migrations/index.ts`, `server/src/db/schema.ts`,
  `server/src/jobs/index.ts`, `server/src/services/triality.ts` (getWeights reads
  the table), `server/src/routes/triality.ts` (reset route),
  `server/test/helpers.ts` (resetDb)

## Schema required

`triality_weights` as pinned above. No CHECK constraints (repo convention —
enums enforced in code).

## Definition of Done

- [ ] Weekly job computes and replaces rows wholesale per owner; floored slots
      write nothing
- [ ] `getWeights` returns learned weights when a row exists, defaults otherwise —
      engine code untouched beyond the seam
- [ ] Reset route deletes the owner's rows, audits, and the next `next` request
      scores on defaults
- [ ] T7's weights tile shows effective vs default + sample counts after a run
- [ ] `resetDb` covers the table; migrations idempotent

## Tests

- [ ] determinism: same log fixture twice → identical weights (float-exact)
- [ ] reward map: each outcome kind moves delta the documented direction; a
      >24h-old unactioned `shown` row counts −0.25, a fresh one counts nothing
- [ ] clamps: all-dismissed log pins at 0.5×; all-staged pins at 2×; sum stays
      the default sum after renormalization
- [ ] floor: 19 outcome rows → no row; 20 → row written
- [ ] per-owner fan-out: two-owner fixture — each owner's weights from their own
      log only; cron path via `runScheduledJob` writes both
- [ ] no owner stamp on job writes (WHO-rule assertion)
- [ ] reset: rows gone, log intact, audit row written, defaults resume
- [ ] end-to-end: seeded acceptances that favor F → Contextual's learned F weight
      rises and the engine's next pick order shifts accordingly (the point of it all)

Verify: `pnpm --filter server test` · `pnpm typecheck`.

## Acceptance Criteria

After a simulated month of consistent behavior the system's picks visibly adapt
(the end-to-end test), the adaptation is inspectable on Balance → Metrics, one
click undoes it, and an owner who never interacts stays on defaults forever.

## Subtasks

1. Migration + schema + resetDb
2. `triality-learning.ts` (pure update rule) + tests
3. Job kind + cron row + OWNER_SCOPED_KINDS
4. getWeights table read + reset route
5. End-to-end adaptation test
