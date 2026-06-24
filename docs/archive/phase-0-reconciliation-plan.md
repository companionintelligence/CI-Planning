# Phase 0 / 0.5 — Reconciliation Plan *(ratify-as-built)*

> **Status (updated 2026-06-22, migration head `0047`):** partially executed.
> **§5b CON-3 done** (`task_tags` dropped in `0041`; `entity_tags` is the read path).
> **§3c direction→pattern residue done** (`0043` renamed `tag_directions`→`tag_patterns`).
> **§3b Routine rename DEFERRED** (the as-built `patterns` naming is ratified; not abandoned, not in-flight).
> **§5a done** — W1-A shipped (PRs #113/#114, migration `0048_drop_habit_booleans`, 2026-06-23): reads repointed to `subtype`, the boolean columns dropped. *(Was "still open" at head 0047; now 4/5 items complete, only §3b deferred.)*
> **§5c reclassified** — `planning_mode` is **kept** (dormant, pending a future AI-reorder UI), *not* dropped; doc-only relabel done.
> Original draft (below) was produced against head `0039`. Companion to the divergence assessment.
>
> **Governing decision (with the user):** *Ratify the as-built code.* `tags.kind='pattern'`
> is accepted as intended (the PR #83 rename stands). We make the **docs and the
> Routine-system naming** conform to the code — not the other way round. The word
> **"pattern" is reserved for the Tag-category axis**; the Routine/Habit/Ritual
> collection system is renamed off it.

---

## 1. Objectives & non-objectives

**Objectives**
1. **One source of truth.** Docs describe the app that exists; the code uses one word per concept.
2. **De-collide "pattern."** Tag-category axis keeps it; the Routine collection system loses it.
3. **End the parallel truths** left by half-finished migrations (Phase 0.5): `is_habit`↔`subtype`, the unread `entity_tags`, the dead `planning_mode`.
4. **Behavior-preserving.** Zero user-visible behavior change in Phase 0/0B. The characterization suite is the gate.

**Non-objectives (explicitly out of scope here)**
- No new features; no roadmap phases (H/R/I…) — those resume *after* this.
- No rewrite of historical migrations. `db/migrations/0001–0039` are **immutable history**; all schema changes land as **new** migrations (`0040+`).
- No change to the Routine ↔ Habit ↔ Ritual product model — only its *naming*.

---

## 2. Guiding rules (apply to every step)

- **Migrations are append-only.** The ~15 `0001–0039` files holding `pattern` tokens are *not* edited. Renames happen in new `0040+` migrations that follow the `0030` precedent (`manual: true`, own transaction + FK pragma).
- **Schema + DB + call-sites move together.** A table rename touches: `schema.ts` (Drizzle view), a new migration (the DB), and every raw-SQL string / identifier in services, routes, engine, client, and tests. Partial renames compile but break at runtime.
- **Test-gated per PR.** Server Vitest + client suite + `pnpm typecheck` green before merge. Run under Node 26 (see §7 hazards).
- **The characterization snapshot is a tripwire, not noise.** `server/test/__snapshots__/baseline.characterization.test.ts.snap` *will* move when names change. Regenerate it **deliberately** and review the diff to confirm **only identifiers changed, no values/counts**. A row-count or behavior delta in that diff is a STOP.

---

## 3. The naming scheme (the classification rule)

Every `pattern` token gets classified by **which system it belongs to**:

| Belongs to | Rule | Action |
|---|---|---|
| **Tag-category axis** (the `tags.kind` taxonomy + its windows/prefs) | "pattern" is correct here | **KEEP** |
| **Routine collection system** (the Routine/Habit/Ritual bundles) | "pattern" is the collision | **RENAME → `routine*`** |
| **Tag-side "direction" residue** (column/label names left from the 0036→0038 value-only rename) | inconsistent with `kind='pattern'` | **RENAME → `pattern*`** |

### 3a. KEEP — Tag-category axis (already correct)
- `tags.kind = 'pattern' | 'intention'` — the taxonomy level. Untouched.
- `pattern_blocks` table (availability windows, GLOSSARY noun #8 "Pattern-block").
- `pattern_prefs` table (`pattern_tag_id` already correct).
- Services/routes: `services/pattern-blocks.ts`, `services/pattern-prefs.ts`, `routes/pattern-blocks.ts`, `routes/pattern-prefs.ts`.
- Client: `PatternBlockSettings.tsx`, `PatternBlockOverlay.tsx`, the `patternBlocks` / `patternPrefs` stores + `api.patternBlocks` / `api.patternPrefs`.
- Engine: the `kind='pattern'` matcher in `autoplan.ts:303`; the `kind='pattern'` lookup in `routes/tags.ts:9`.

### 3b. RENAME — Routine collection system (`pattern* → routine*`)  *(⏸ DEFERRED — the as-built `patterns` naming is ratified; this table is the future-cleanup map if §3b is ever revived.)*
| Now | Becomes | Kind |
|---|---|---|
| `pattern_types` (table) | `routine_types` | DB + schema |
| `patterns` (table) | `routines` | DB + schema |
| `pattern_tasks` (table), `pattern_id` (col) | `routine_tasks`, `routine_id` | DB + schema |
| `flight_plan.source_pattern_id` | `flight_plan.source_routine_id` | DB + schema |
| `time_blocks.source_kind` **value** `'pattern'` | `'routine'` | DB **data** (UPDATE) + every reader/writer of that marker |
| `scheduling_prefs.recall_keeps_pattern` | `recall_keeps_routine` | DB + schema (it gates Routine membership on recall) |
| `services/patterns.ts` | `services/routines.ts` | file + symbols |
| `engine/patterns-place.ts` | `engine/routines-place.ts` | file + symbols |
| `routes/patterns.ts` (129 tokens) → `/api/patterns`, `/api/pattern-types`, `/api/patterns/:id/place-today` | `routes/routines.ts` → `/api/routines`, `/api/routine-types`, `/api/routines/:id/place-today` | file + **HTTP contract** |
| client `views/Patterns.tsx`, route `/patterns` | `views/Routines.tsx`, `/routines` | file + route + nav |
| client stores `patterns`, `patternTypes`, `patternByTaskId`, `patternForTask` | `routines`, `routineTypes`, `routineByTaskId`, `routineForTask` | symbols |
| client `lib/api.ts` `api.patterns`, `api.patternTypes` | `api.routines`, `api.routineTypes` | symbols + fetch paths |
| client `lib/pattern-meta.ts` | `lib/routine-meta.ts` | file + symbols |
| tests `patterns.test.ts`, `patterns-place.test.ts`, `patterns-promote.test.ts`, `pattern-recurrence.test.ts`, `habit-patterns.test.ts` | `routine*` | files + assertions |

> Note `entity_tags.entity_kind` **already uses `'routine'`** — no change needed there; it confirms `routine` is the right target word.

### 3c. RENAME — Tag-side "direction" residue (`direction* → pattern*`)
The 0038 migration changed the *value* `direction→pattern` but left these names:
| Now | Becomes |
|---|---|
| `tag_directions` (table), `direction_tag_id` (col) | `tag_patterns`, `pattern_tag_id` *(keeps `intention_tag_id`)* |
| `pattern_blocks.direction_tag_id` | `pattern_blocks.pattern_tag_id` |
| client/server identifiers `directionTag*`, `directionTags` (e.g. `TaskForm.tsx`) | `patternTag*` |
| UI copy "per-direction availability windows", "Schedule Patterns" (`Settings.tsx`) | "per-pattern availability windows" (settle one label) |

> **Scope flag:** 3c is genuinely optional for *correctness* (it's internal naming), but skipping it leaves "direction" as an orphaned third word — re-creating a mini-divergence. Recommend doing it **in the same pass** as 3b while the tag code is already open. If scope must shrink, 3c can be a fast follow-on PR.

---

## 4. Phase 0A — Documentation reconciliation *(zero code risk — do first)*

Pure doc edits; can merge immediately, independent of the rename.

| File | Change |
|---|---|
| `docs/ROADMAP.md` | Fix the phase-status table: **A–G are shipped** (cockpit, Planner, flight-plan, patterns/routines, time-blocks all landed via #60–#65, #77). Mark "Settings"/"Responsive" done. Re-point "next build" to **Phase 0 (this) → H → R**. Remove the stale "G not built yet" framing. |
| `docs/GLOSSARY.md` | Reconcile to as-built: noun **"Routine"** internal table is now `routines` (not `patterns`). Note `tags.kind='pattern'`/`'intention'` is the **tag taxonomy axis**, distinct from the Routine noun. Resolve the Habit contradiction (see §5 decision). Update noun #8 wording (windows key off a **pattern** tag, not "direction"). |
| `docs/consolidation-plan.md` | **✅ Annotated in place** — HISTORICAL banner added (booleans kept; `/calendar` restored #92). Kept in `docs/`, not moved/deleted. |
| `docs/cockpit-v2-plan.md` | **✅ Annotated in place** — HISTORICAL banner added (`/calendar` reversal #92). |
| `docs/G-rituals-reflection.md` | **✅ Annotated in place** — HISTORICAL banner added (old `pattern_types` model; Routine system kept, renamed → `routine*`). |
| `docs/settings-direction-prefs-plan.md` | Note the `direction→pattern` rename shipped; cross-link the residue cleanup (§3c). |
| `README.md` / `ARCHITECTURE.md` | Update "what ships today": G is in. Fix the "A–F is all that ships" line. One source-of-truth pointer. |

**Acceptance 0A:** every plan doc's status matches `git log` reality; no doc claims a model the code doesn't implement; one explicit "source of truth" statement that the others defer to.

---

## 5. Phase 0.5 — Finish the half-done contracts *(decisions to confirm)*

These are the latent-bug sources. Each carries a recommendation; all are **behavior-preserving** if done as written.

### 5a. Habit triplication → one source of truth  *(⏳ OPEN — ticket W1-A; recommended path below confirmed: make `subtype` canonical, then drop the booleans)*
Today: `is_habit` (bool, **authoritative** — engine reads it at `recurrence-generate.ts:99,120,134,176,181`), `is_fast_task` (bool), `subtype` ('standard|habit|quick', **declared canonical but unread**).

- **Recommended — make `subtype` canonical, finish the contract:**
  1. Repoint the recurrence engine (`recurrence-generate.ts`, `recurrence-ops.ts`) to read/write `subtype` instead of `is_habit`; map `is_fast_task`→`subtype='quick'`.
  2. Verify `generate.test.ts` + `recurrence-ops.test.ts` + `habit-patterns.test.ts` green **without** changing their expectations (proves equivalence).
  3. *Then* a `0041` migration backfills `subtype` from the bools (already in sync) and **drops** `is_habit`/`is_fast_task` (the contract step CON-2 skipped).
- **Lower-effort alternative (also valid under "ratify as-built"):** keep `is_habit`/`is_fast_task` as the engine's source of truth and **drop `subtype`** instead. Less churn, but loses the cleaner single-column model and re-contradicts the GLOSSARY's "Habit = subtype." Not recommended.

> Either way the **end state is ONE representation.** This is the single most important regression-prevention step: do **not** drop a column before its readers move.

### 5b. `entity_tags` — wire up or remove  *(✅ DECIDED: **finish CON-3** — make it the read path, drop `task_tags`, keep `.tag` as the mirror. Full wave plan: [con-3-finish-plan.md](con-3-finish-plan.md).)*
Confirmed: written + cascaded by the tag-repo (`services/tags.ts`) and a few mutate routes, but **read by nothing** (schema comment lines 286–292 says reads still use `task_tags`/`time_blocks.tag`/`patterns.tag`; it's staged for a "Phase 5 dilution" that never landed).

- **If tag levels/dilution is on the near roadmap (≤1–2 phases out):** keep it, but add a **sync-integrity test** (write a tagged entity → assert `entity_tags` matches the legacy store) so the parallel store can't drift silently, and file the "Phase 5 makes it the read path" ticket.
- **If dilution is not planned soon (recommended default):** **remove it** — drop the table in `0040`, delete the sync/cascade calls, keep the legacy stores. Stops maintaining four tag stores for an unused fifth. Re-introduce cleanly when dilution is actually built.

*Execution gate:* before removing, re-grep for any `SELECT … FROM entity_tags` read site to confirm zero readers (the audit in §6 step 1 produces this list).

### 5c. `planning_mode` column  *(✅ DECIDED: **KEEP** — reclassified, not dropped)*
`scheduling_prefs.planning_mode` (default `'ritual'`) has **no UI** but is **still read** at
[`agents/plan.ts`](../server/src/agents/plan.ts) — it gates the LLM task-reorder path (only runs when `'auto'`,
which nothing currently sets, so it is dormant rather than dead). Decision: **keep** the column and the
reader for a future AI-reorder toggle; relabel docs/comments from "retired" to "dormant, pending UI".
Original "drop it" recommendation is **superseded** — do **not** drop. (Doc/comment relabel done in Wave 0.)

---

## 6. Phase 0B — The de-collision rename *(the risky mechanical pass)*

**Step 1 — Classification audit (no edits).** Produce the authoritative KEEP/RENAME map by grepping every `pattern`/`Pattern`/`direction`/`Direction` token across `server/src`, `client/src`, `server/test`, `client/src/**/*.test.*` and tagging each per §3. Output a checklist. *This is the first execution artifact and the review checkpoint.* (Sizing from this plan's survey: ~437 server-src, ~369 client-src, ~372 server-test occurrences — but a large fraction of server-src is in immutable migrations and is excluded.)

**Step 2 — Schema + migration (`0040_routine_rename`, `manual: true`).** Following the `0030` precedent: `PRAGMA foreign_keys=OFF` in a single tx → `ALTER TABLE … RENAME` for `pattern_types/patterns/pattern_tasks` (+ `RENAME COLUMN` for `pattern_id`, `source_pattern_id`, `recall_keeps_pattern`) → `UPDATE time_blocks SET source_kind='routine' WHERE source_kind='pattern'` → tag-side residue renames (§3c) → `PRAGMA foreign_key_check` → re-enable. Mirror the same renames in `schema.ts`. (Optionally fold 0.5's drops into this migration or keep `0041` separate for reviewability — recommend **separate** so a rename bug and a drop bug don't share a blast radius.)

**Step 3 — Server call-sites.** Rename files (`patterns.ts→routines.ts`, `patterns-place.ts→routines-place.ts`, `routes/patterns.ts→routes/routines.ts`), update `routes/index.ts` registration + HTTP paths, and every raw-SQL string referencing renamed tables/columns/marker-values. The `source_kind='pattern'` literal appears in `patterns-place.ts`, `routes/patterns.ts`, and several tests — all must flip to `'routine'` in lockstep with the data UPDATE.

**Step 4 — Client call-sites.** Rename `views/Patterns.tsx→Routines.tsx` + route `/patterns→/routines` (`App.tsx`, `Nav.tsx`, `BottomNav.tsx`), `lib/pattern-meta.ts→routine-meta.ts`, store symbols, `api.ts` namespaces + fetch paths. **Verify in the preview** (the nav already shows "Routines" to users, so user-facing copy is mostly already correct — this is internal symbol alignment).

**Step 5 — Tests.** Rename the Routine-side test files + identifiers; flip `source_kind` literals; **regenerate the characterization snapshot deliberately** and review its diff (§2).

**Acceptance 0B:** `grep -rn "pattern" server/src client/src` returns **only** tag-axis hits (`tags.kind`, `pattern_blocks`, `pattern_prefs` + their services/routes/components) — a greppable gate. `routine` is the only word for the collection system. All suites green with **no expectation changes** except identifier renames + the reviewed snapshot. HTTP `/api/routines*` serves what `/api/patterns*` did.

---

## 7. Regression strategy & hazards

- **Characterization snapshot** = the behavior tripwire. Identifier-only diff = OK; any value/count change = STOP and investigate.
- **Shared dev DB.** `companion.db` is one fixed AppData path across **all** worktrees. Run `0040`/`0041` against a **copy** first; never point the dev server at the shared DB to "try" a migration mid-review.
- **Node 26 vs installed 24.** `tsx watch` crashes every 1–2 min on 24. Verify with the server run **without** `watch` (`cd server && PORT=<free> pnpm exec tsx src/index.ts`) + Vite preview proxying `/api`.
- **Migration safety.** Renames touch FK'd tables → use the `manual` tx + FK pragma + `foreign_key_check`, exactly as `0030` did. Idempotency: the `migrate.test.ts` fixture-DB check must stay green.
- **Don't drop before readers move (5a/5b/5c).** Every column/table drop is gated on a grep proving zero readers remain.

---

## 8. Suggested PR sequence

| PR | Scope | Risk | Gate |
|---|---|---|---|
| **0A-docs** | §4 doc reconciliation only | none | review reads true vs `git log` |
| **0.5a-habit** | §5a repoint engine → `subtype` (no column drop yet) | med | recurrence/habit suites green, expectations unchanged |
| **0B-rename** | §6 Routine off "pattern" + §3c direction residue (schema + `0040` + all call-sites) | **high** | greppable acceptance + reviewed snapshot |
| **0.5b-contract** | drop `is_habit`/`is_fast_task` (post-0.5a) + `entity_tags` decision + `planning_mode` (`0041`) | med | zero-reader greps; suites green |

Order rationale: docs first (free, stops the bleed). Engine repoint (5a) **before** the rename so the riskiest two changes don't interleave. Rename (0B) as its own blast radius. Column drops last, each behind a zero-reader proof.

---

## 9. Decisions (all resolved 2026-06-22)
1. ~~**§5a** — make `subtype` canonical or ratify the booleans?~~ **✅ RESOLVED — `subtype` canonical**, then drop `is_habit`/`is_fast_task` (expand→contract). Tracked as ticket **W1-A**.
2. ~~**§5b** — `entity_tags` keep or remove?~~ **✅ RESOLVED — finished CON-3** (entity_tags read path; `task_tags` dropped in `0041`). Wave plan: [con-3-finish-plan.md](con-3-finish-plan.md).
3. ~~**§3c** — direction → pattern residue rename, same pass or follow-on?~~ **✅ DONE** in `0043` (`tag_directions`→`tag_patterns`, `direction_tag_id`→`pattern_tag_id`).
4. ~~**Migration packaging** for the §3b rename + drops?~~ **N/A — §3b rename DEFERRED.** The only remaining drop (W1-A's booleans) lands as its own migration (`0048+`).
5. *(added)* **§3b Routine rename** — **DEFERRED** (ratify as-built `patterns`); **§5c `planning_mode`** — **KEEP** (dormant, not dropped). See banner.
