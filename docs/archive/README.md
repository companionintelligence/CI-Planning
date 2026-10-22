# Archived planning docs

These docs are **complete or superseded** — kept for history, not maintained. The
live plan of record is [../ROADMAP.md](../ROADMAP.md); the canonical vocabulary is
[../GLOSSARY.md](../GLOSSARY.md). Links *inside* these archived files may still point
at pre-archive locations — that's expected.

## Consolidation pass (CON-1…CON-5) — shipped 2026-06-21 (#73–#78)
- **consolidation-plan.md** — the five-step overview (vocab · UUIDv7 · schema canon · recurrence · write-capable drag). All passes merged.
- **con-1-uuidv7-design.md** — UUIDv7 identity design (CON-1). Shipped #74/#76, migration `0030`.
- **con-2b-brief.md** — user-facing vocabulary relabel (CON-2b). Merged in CON-2 #76.
- **con-2c-brief.md** — `tasks.subtype` canonical field (CON-2c). Merged #76.
- **con-2d-brief.md** — ConceptLane removal (CON-2d). Deferred, then obsoleted by the `/calendar` restore (#92).
- **con-3-brief.md** — `entity_tags` store handoff (CON-3). Superseded by `con-3-finish-plan.md`.
- **con-3-finish-plan.md** — finish CON-3 (flip reads, drop `task_tags`). Done 2026-06-22, migrations `0033`→`0041`.

## Reconciliation
- **phase-0-reconciliation-plan.md** — Phase-0/0.5 ratify-as-built plan. 4 of 5 items done (§5a shipped #113/#114; only the §3b `patterns`→`routines` rename stays deferred).

## Superseded designs
- **cockpit-v2-plan.md** — cockpit-v2 UI batch. Shipped (#77); its `/calendar` decision was later reversed by #92.
- **G-rituals-reflection.md** — original Phase-G spec (old `pattern_types`-as-routine model). Superseded by the as-built cockpit; the UX source of truth is [design-today-cockpit.md](design-today-cockpit.md).
- **E-recurring-habits.md** — original Phase-E spec; the E′ habit→pattern revision shipped under G.
- **design-brief-recurrence-settings.md** — design brief for the recurrence editor + settings; landed via E and #83.
- **settings-direction-prefs-plan.md** — settings rework plan; shipped as #83 (2026-06-22, "pattern rename + per-pattern fill").

## Superseded by a newer phase
- **K-auto-defense.md** — Phase-K auto-defense spec. **Folded into Phase M** ([M-ai-scheduler.md](M-ai-scheduler.md)), whose Workstream B is the code-accurate version (it wraps `placeFlightPlan`, not `runScheduler`). Retained for the anti-thrash rules M reuses.

## A–S phase specs — archived 2026-07-02 (schema cleanup done → multi-tenant next)

> The live cross-phase summary is **[../recap_state_A-S.md](../recap_state_A-S.md)** — open issues, deferrals, invariants, and the T–Y hand-off. **Q-schema-hygiene.md** and **S-schema-consolidation.md** stay live in `docs/` (the multi-tenant bridge the handoff points at). Inbound links in `ROADMAP.md`/`Q` were repointed here.

**Foundation & feature specs (shipped unless noted):**
- **B0-migration-runner.md** — migration runner + owner-scoped data model.
- **C-task-semantics.md** — deps / defer / NL quick-add.
- **D-time-tracking.md** — timers + actuals. (No manual-entry UI; cross-task rollups unscheduled.)
- **F-calendar-grid.md** — 2-D grid (F′ shipped under G).
- **H-notifications-webpush.md** — SW + Web Push. **Needs VAPID keys to go live.**
  - **H-notifications-webpush.branch-2026-06-21.md** — the H spec as revised for the post-consolidation base (UUIDv7 ids, CON-2 vocabulary, CON-4 gating, migration `0036`). Never committed; rescued from the orphaned `CP-h-doc` worktree.
  - **H-fanout-briefs.md** — Lane A/B/C parallel-build briefs for H with the frozen inter-lane contracts. Same rescue.
- **I-identity-auth.md** — auth/connectors. ⚠️ **PARTIAL** — API-key path only; JWKS/SSO "PR2" never built → **Phase U**.
- **J-calendar-sync.md** — inbound sync + Google connectors.
- **L-multi-device-sync.md** — op-log / field-merge. 3 P3 gaps + offline-create deferred.
- **M-ai-scheduler.md** — LLM day-plan + reflow (absorbs K). B1/B4/A3 sub-items deferred.
- **N-life-planning.md** — objectives / reflections / review. N2 enforcement + N4 R4 deferred.
- **O-gamified-stars.md** — 5-star day. O4 streaks not specced.
- **P-planner-hygiene.md** — recurrence horizon + Clear Date Range.
- **R-backups-restore.md** — backups / export / audit. ⚠️ `backup.ts` owner-less-table wipe is a **Phase-T landmine** (recap §2 R / §8).

**Phase A & Phase G design:**
- **auto-scheduling-plan.md**, **auto-scheduling-prompt.md** — Phase-A auto-scheduling (autoplan #121–#129).
- **design-today-cockpit.md** — the TODAY cockpit UX (Phase-G source of truth).

**Completed non-lettered plans:**
- **ingestion-plan.md** — inbox ingestion product framing.
- **time-block-categories-plan.md** — Categories axis. Shipped.
- **cockpit-auto-simplification-prompt.md**, **corrections-prompt.md** — historical agent build prompts.
- **HANDOFF-objectives-followups.md** — Phase-N objectives follow-ups. **Resolved** (#191 parent-picker, #193 objective sync + monotonic guard).

> **Kept LIVE in `docs/` (not archived) — open/unbuilt work:** `F2-calendar-improvements.md` (whole phase unbuilt), `tasks-planner-ui-overhaul.md` (Wave 2 open), `plan-import.md` (PI dedup/merge unbuilt), `ftue-plan.md` (status unclear).
