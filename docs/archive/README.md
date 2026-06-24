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
- **G-rituals-reflection.md** — original Phase-G spec (old `pattern_types`-as-routine model). Superseded by the as-built cockpit; the UX source of truth is [../design-today-cockpit.md](../design-today-cockpit.md).
- **E-recurring-habits.md** — original Phase-E spec; the E′ habit→pattern revision shipped under G.
- **design-brief-recurrence-settings.md** — design brief for the recurrence editor + settings; landed via E and #83.
- **settings-direction-prefs-plan.md** — settings rework plan; shipped as #83 (2026-06-22, "pattern rename + per-pattern fill").

## Superseded by a newer phase
- **K-auto-defense.md** — Phase-K auto-defense spec. **Folded into Phase M** ([../M-ai-scheduler.md](../M-ai-scheduler.md)), whose Workstream B is the code-accurate version (it wraps `placeFlightPlan`, not `runScheduler`). Retained for the anti-thrash rules M reuses.
