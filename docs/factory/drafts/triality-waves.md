# Triality — ticket set & wave plan (LOCAL DRAFTS — not on the Factory board)

> **Status:** drafted 2026-07-29 against `docs/triality-design.md` (all owner decisions
> locked) and a same-day pin-verification pass of the live tree (migration head
> `0138_calibration_history`). **These files are deliberately NOT committed and NOT
> GitHub issues yet** — owner asked for local drafts only. Promote with
> `scripts/factory/factory.sh create --body-file <draft>` when ready.
>
> ⚠️ Standing lesson (HANDOFF-2026-07-19): every pinned symbol below was verified
> today, and will be stale by build time. Each ticket's **Before implementation**
> section re-verifies its own pins. Migration numbers are written as `next-free` —
> check `server/src/db/migrations/index.ts` first, always.

## Waves (parallel-safe groups; a wave starts only when the prior wave is merged)

| Wave | Tickets | Parallel? | Why safe |
|---|---|---|---|
| **1 — dark foundation** | T1 flag + log schema · T2 situation vector · T2b motivation axis (me/us/them, LLM-first) | yes | disjoint files; T2's `motivation_balance` dim ships encoder-ready and reads 0 until T2b's column exists |
| **2 — scoring engine** | T3 engine (candidates → scores → slots → refusal + log helpers + `getWeights` seam) | — | needs T1 (table) + T2 (vector) |
| **3 — API surfaces** | T4 REST routes · T5 GraphQL parity | yes | both are thin adapters over T3's service; no shared files (graphql/ auto-globs) |
| **4 — surfaces** | T6 Focus banner (suggestions) · T7 Balance Triality metrics (measurement) | yes | disjoint files; T7's weights tile no-data-states until T8 |
| **5 — learning + polish** | T8 learning loop (`calibrate_triality`) · T9 rationale garnish + GLOSSARY/docs | T8 then T9 | T9 documents T8's job counts; T8 lights up T7's weights tile |

Every wave leaves `main` shippable: the flag defaults off and nothing renders or
mounts until T4/T6, so waves 1–3 are byte-identical for a flag-off owner, and
learning (wave 5) degrades to defaults when absent.

## Ticket files

1. [triality-t1-flag-and-log.md](triality-t1-flag-and-log.md) — `triality_enabled` + `triality_log` migrations, prefs plumbing, Settings toggle
2. [triality-t2-situation-vector.md](triality-t2-situation-vector.md) — balanced-ternary situation vector builder (pure, honest zeros; incl. `motivation_balance`)
2b. [triality-t2b-motivation-axis.md](triality-t2b-motivation-axis.md) — motivation me/us/them on tasks (nullable — NULL ≠ `us`), **LLM-first tagging** (`generateJson` + rubric, unsure⇒NULL, `motivation_source` user|llm), wizard override wins
3. [triality-t3-scoring-engine.md](triality-t3-scoring-engine.md) — candidates, capacity filter, F/H/Q/N/C, slot assignment, refusal floor, log helpers, `getWeights` seam
4. [triality-t4-rest-routes.md](triality-t4-rest-routes.md) — `GET /api/triality/next` + `POST /api/triality/feedback` (404-when-flag-off idiom)
5. [triality-t5-graphql-parity.md](triality-t5-graphql-parity.md) — `trialityNext` query + `trialityFeedback` mutation (shared service layer)
6. [triality-t6-focus-banner.md](triality-t6-focus-banner.md) — dismissable suggestion banner on Focus (Habitual · Contextual · Novel; day-scoped dismissal)
7. [triality-t7-balance-triality-metrics.md](triality-t7-balance-triality-metrics.md) — Triality outcome metrics + weights tiles on Balance → Metrics (`GET /api/metrics/triality`)
8. [triality-t8-learning-loop.md](triality-t8-learning-loop.md) — bounded weekly weight calibration (`calibrate_triality`, `triality_weights`, reset route)
9. [triality-t9-garnish-and-docs.md](triality-t9-garnish-and-docs.md) — optional Ollama one-liners, GLOSSARY entries, README/ARCHITECTURE sync (incl. job-count bump)

## Global pinned conventions (verified 2026-07-29 — every ticket inherits these)

- **Flag storage:** boolean column on `scheduling_prefs`, default `0` — the
  `time_sense_enabled` shape (`schema.ts` ~L265). Exposure via `services/prefs.ts`
  (`getPrefs` / `updatePrefs` / `serializePrefs`) — routes/prefs.ts is a thin shell.
- **Flag-gated routes 404 while off** — the shipped idiom (`routes/calibration.ts`
  header comment); clients gate UI on the flag from `GET /api/prefs`.
- **Migrations:** plain TS, `export const id` + `up(db)`, idempotent
  (addColumn-if-missing per 0137; `CREATE TABLE IF NOT EXISTS` per 0138); append to
  the `MIGRATIONS` array in `migrations/index.ts`. Ids via the `uuid7()` UDF.
- **resetDb** (`server/test/helpers.ts:27`) must delete every new table — it already
  covers `calibration_history` (L62) and `copy_history` (L64); 0137/0138 lesson.
- **GraphQL is schema-first and auto-globbed:** drop `<name>.graphql` +
  `<name>-resolvers.ts` into `server/src/graphql/` — `index.ts` readdirSync picks
  both up; no registration edit.
- **Determinism in tests:** thread injectable fns the way `services/possibles.ts`
  threads `opts.embedFn` (L183–189); `TZ=UTC`, frozen clocks, no wall-clock date
  literals (time-bomb rule).
- **Owner scoping:** every read/write keyed by `currentOwnerId()` (`lib/context.ts`);
  jobs are irrelevant here (Triality has no cron).
- **Timezone:** owner-local dates via `localDateInTZ` (`lib/tz.ts:84`) + `addDays`
  (`lib/dates.ts`).
- **Canonical vocabulary:** `habitual` · `contextual` · `novel` — enum values,
  constants, UI copy. Never `normal`/`adjacent` (thesis terms live only in the
  design doc's provenance notes).
