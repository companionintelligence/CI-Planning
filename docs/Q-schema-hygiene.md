# Q — Schema hygiene (pre-multi-tenant) — implementation handoff

**Status:** ✅ IMPLEMENTED 2026-07-01 (Q1–Q5 all shipped) · **migration head now `0094`** (was 0091). **Depends on:** nothing; **must precede** the Multi-tenant + OIDC/OAuth phase. Companion to [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md), [ARCHITECTURE.md](../ARCHITECTURE.md), the test-harness notes, and [P-planner-hygiene.md](archive/P-planner-hygiene.md) (recent example of this repo's migration + ticket-board conventions).

> **✅ As-built note (implemented 2026-07-01).** All five tickets shipped; migration head is now `0094`; full server suite + typecheck green. Two deliberate departures from the drafts below, for correctness/consistency:
> 1. **Q3/Q4 use the repo's `rebuildTable` helper + `export const manual = true`** (the `0030`/`0068` pattern) — **not** the hand-written, non-`manual` rebuild drafted here. Consequently **§0.5 as originally written is wrong**: `PRAGMA foreign_keys=OFF` during a rebuild *is* used and *does* work — that is exactly what `manual` migrations exist for (they run outside the runner's auto-transaction). `rebuildTable` sets it OFF for the swap and restores ON in a `finally`; blanket FK-off is the forward-safe posture for the non-leaf rebuilds the multi-tenant phase will need. §0.5 has been corrected below.
> 2. **The rebuilds are faithful except the intended change.** Q3 preserves `flight_plan`'s live physical column order (`owner_id, task_id, selected, position, added_at, source_kind, source_ref`) and `source_kind`'s `NOT NULL DEFAULT 'manual'` (added in 0081) — the draft's column order was wrong and would have (a) failed the schema-shape characterization golden and (b) silently dropped `source_kind`'s NOT NULL. Q4 likewise preserves order + constraints, dropping only the bogus default.
>
> Minor corrections: **Q4's premise** — `daily_summaries.owner_id` is already **`TEXT`** today (0030 retyped it), currently `TEXT NOT NULL DEFAULT 1`; only the default is dropped (not the type). **Q1 build note** — the bundled `better-sqlite3` binary happens to default `foreign_keys` **ON**, so `openDb()` is portability/defensive hardening here rather than an active-bug fix (kept anyway; the SQLite *library* default is OFF). Also fixed a pre-existing drift: `schema.ts` `flightPlan.sourceKind` gained `.notNull()` to match the DB.
>
> **Who this is for.** A fresh implementation chat (assume a mid-tier model). This doc is self-contained: it states the goal, the exact scope, the migrations to write (with drafts), the tests that *prove* the goal, and — importantly — an explicit **DO NOT** list, because several tempting "simplifications" are risky refactors that must be designed first, not attempted here.

> **Why now.** The app is early-stage (tiny row counts) but about to gain **multi-tenant users + OIDC/OAuth**. Multi-tenant amplifies exactly the integrity gaps that are harmless in single-owner mode (a nullable owner in a PK, an integer owner-default on a now-UUID column, FK enforcement that isn't guaranteed on every connection, missing indexes on cascade paths). This phase makes the schema **correct and consistent** first. It deliberately does **not** simplify table count — that's higher-risk, lower-ROI right now, and is fenced off in §Tier 2.

---

## §0 — READ FIRST: guardrails (this is where a rushed implementer breaks things)

1. **The default worktree is probably STALE.** This repo has many concurrent branches; the session's default worktree can be many migrations behind `main`. Two separate audits for this very doc were run against a `0084`-era worktree and reported the wrong migration head. **Always** branch a fresh worktree from `origin/main`, then confirm the head:
   ```bash
   git fetch origin main
   ls server/src/db/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -3   # numbered files only (excludes index.ts); highest must be 0091
   ```
   If the highest is **not** `0091`, main has moved — re-derive the next free numbers and re-verify every column list in this doc against the actual schema before writing SQL.

2. **Migration numbers are PINNED here as `0092`/`0093`/`0094`** on the assumption head is `0091`. If another lane merged migrations since, renumber (they're append-only; the number is cosmetic but must be unique and ascending). Register each new file in [`server/src/db/migrations/index.ts`](../server/src/db/migrations/index.ts) — match the existing ESM pattern exactly: `import * as mNNNN from './NNNN_name.js';` (note the **`.js`** extension — the imports use compiled-output paths) + append `mNNNN` to the `MIGRATIONS` array. A file that isn't registered never runs.

3. **Migrations are forward-only and additive/idempotent.** Guard with `IF NOT EXISTS` / `PRAGMA table_info` existence checks (see [`0073_enable_routines.ts`](../server/src/db/migrations/0073_enable_routines.ts) for the PRAGMA-guard idiom). A data-reinterpreting migration warrants a release note.

4. **SQLite cannot** `ALTER COLUMN`, `DROP DEFAULT`, add `NOT NULL` to an existing column, or change a `PRIMARY KEY`. The **only** way to do any of those is the **12-step table rebuild** (§ Q3). Do not attempt `ALTER TABLE ... ALTER COLUMN` — it is not valid SQLite and will fail.

5. **`PRAGMA foreign_keys` cannot be toggled inside a transaction** (SQLite silently ignores it mid-transaction). The runner wraps each **non-`manual`** migration in a transaction; a migration that needs to toggle FK must therefore export **`manual = true`** so it runs *outside* that transaction (see [`0030_uuidv7_identity`](../server/src/db/migrations/0030_uuidv7_identity.ts) and [`0068_day_types`](../server/src/db/migrations/0068_day_types.ts)). **The Q3/Q4 rebuilds do exactly this**, via the shared [`rebuildTable`](../server/src/db/migrate.ts) helper, which sets `foreign_keys = OFF` for the swap and restores `ON` in a `finally`. *(This corrects an earlier draft of this section, which claimed the toggle "isn't needed / won't work." The leaf-table observation — `flight_plan`/`daily_summaries` have no inbound FKs — is true and means a bespoke non-`manual` rebuild would also be safe; but blanket FK-off via `manual` + `rebuildTable` is the repo convention and stays safe for the **non-leaf** rebuilds the multi-tenant phase will need, so that's what shipped.)*

6. **Identity is UUIDv7 TEXT, not integer.** `0001_baseline` created `owners.id` as `INTEGER PRIMARY KEY AUTOINCREMENT`; **`0030_uuidv7_identity` converted all identity to UUIDv7 TEXT** and remapped legacy owner `1` → the `SYSTEM_OWNER_ID` sentinel. Some *old* migrations still literally say `INTEGER` for owner/task columns (e.g. `flight_plan` in `0016`, `daily_summaries` in `0001`); those columns now hold TEXT UUIDs via SQLite's flexible typing. `schema.ts` reflects the logical (post-0030) TEXT reality. Never assume a column's declared type in an old migration is what it holds today. `currentOwnerId()` ([`server/src/lib/context.ts`](../server/src/lib/context.ts)) returns a `string`.

7. **Test-harness rules** ([`server/test/helpers.ts`](../server/test/helpers.ts), and the repo's test-gotchas notes):
   - Tests run **sequentially against one shared SQLite DB**; migrations run **on import**.
   - Reproduce CI-only failures locally with `TZ=UTC`. **Pin all dates** in tests (no `Date.now()` time-bombs).
   - `resetDb()` clears an explicit table list. **If a test depends on a table's rows, that table must be in `resetDb`'s clear list** or state leaks between tests. If you add a table (you don't in this phase) or newly depend on one, update `resetDb`.
   - Verify with: `pnpm --filter server test` (run under `TZ=UTC`) and `pnpm --filter server typecheck`. CI runs "Typecheck + Unit + Integration" and "Build, screenshot-test, publish"; both must be green.

8. **A note on review bots:** GitHub Copilot's autofix bot sometimes pushes commits directly onto an open PR branch. If you see unexpected commits, reconcile rather than force-push over them.

---

## Goal (phase-level)

Make the schema **integrity-correct and owner-identity-consistent** so the multi-tenant + OIDC phase starts from a clean base — **without** changing table count, business logic, or user-visible behavior.

## Definition of done (phase-level)

- [x] FK enforcement is guaranteed on **every** connection the app opens (main + backup + restore + migrate), proven by a test. *(via shared `openDb()`; read-only/never-writing opens intentionally left raw.)*
- [x] Every FK column on a hot cascade/join path has a supporting index (additive migration `0092`).
- [x] `flight_plan.owner_id` is `TEXT NOT NULL` and correctly typed; the composite PK can no longer admit a NULL/duplicate owner (rebuild `0093`). *(column order + `source_kind` NOT NULL preserved.)*
- [x] `daily_summaries.owner_id` no longer carries the bogus integer `DEFAULT 1`; it's `TEXT NOT NULL` (rebuild `0094`).
- [x] `PRAGMA integrity_check` = `ok` and `PRAGMA foreign_key_check` = no rows, asserted in a test after all migrations.
- [x] `schema.ts` matches the post-migration reality (`flight_plan.owner_id` + `sourceKind` gained `.notNull()`).
- [x] Server test suite (113 files / 1075 tests) + typecheck green; migration head is `0094`.
- [x] The **Tier 2 / multi-tenant-bridge** items in this doc are left untouched (they are explicitly out of scope) and remain documented for the next phase.

---

## Scope map (tickets)

| Ticket | Title | Migration | Risk | Parallel-safe with |
|---|---|---|---|---|
| **Q1** | FK enforcement on all connections | none (code) | low | Q2, Q3, Q4 |
| **Q2** | FK index coverage | `0092` | **lowest** (purely additive) | Q1 (Q3/Q4 touch different tables) |
| **Q3** | `flight_plan` integrity rebuild | `0093` | **highest in phase** (table rebuild) | Q1, Q2 |
| **Q4** | `daily_summaries` default fix rebuild | `0094` | low-med (regenerable cache) | Q1, Q2 |
| **Q5** | Post-migration integrity assertion + docs | none (test + docs) | low | after Q1–Q4 |

**Recommended order:** Q2 first (safe confidence-builder + proves the migration/test loop), then Q1 (code), then Q3, then Q4, then Q5. Q3 and Q4 share the rebuild recipe — do Q3 first (harder), reuse the pattern for Q4. **Do not** run Q3 and Q4 as a single migration; one file per concern for reviewability and safe rollback-by-revert.

---

## Q1 — FK enforcement on every connection

**Problem.** `foreign_keys` is a **per-connection, off-by-default** SQLite setting. The main app connection sets it ([`db/index.ts:11`](../server/src/db/index.ts) — `sqlite.pragma('foreign_keys = ON')`), but the backup, restore, and migrate scripts open their **own** `better-sqlite3` connections and may not. A connection with it off can insert orphans / skip cascades silently.

**Goal.** Every place that opens a `better-sqlite3` connection sets `foreign_keys = ON` immediately after open (ideally via one shared helper so it can't be forgotten again).

**Files / where to look:**
- [`server/src/db/index.ts`](../server/src/db/index.ts) — the canonical open (already correct; line ~11).
- [`server/src/lib/backup.ts`](../server/src/lib/backup.ts), [`server/src/scripts/restore.ts`](../server/src/scripts/restore.ts), [`server/src/scripts/migrate.ts`](../server/src/scripts/migrate.ts) — grep the repo for `new Database(` / `better-sqlite3` to find **all** open sites: `grep -rn "new Database\|better-sqlite3" server/src`.
- Preferred: add a tiny helper (e.g. `openDb(path)` in `db/index.ts` or `lib/`) that opens + sets `foreign_keys = ON` (+ `busy_timeout`), and route every open through it. If a shared helper is impractical for a given script, add the pragma inline and comment why.

**Definition of done:**
- [ ] Every `better-sqlite3` open in `server/src` sets `foreign_keys = ON` before use.
- [ ] No behavior change to the happy path (the main connection already did this).

**Tests planned (prove the goal):**
- [ ] Unit test: for each open site (or the shared `openDb` helper), assert `db.pragma('foreign_keys', { simple: true }) === 1` immediately after open.
- [ ] Integration test: open a fresh DB via the helper, attempt an insert that violates a FK (e.g. a `time_entries` row with a non-existent `task_id`), assert it **throws** (proves enforcement is live, not just the pragma value).

**Acceptance criteria:** grep shows no open site missing the pragma; the violation test throws; existing suite unchanged.

**Variables/connections:** `DB_PATH` (env, see [`config.ts`](../server/src/lib/config.ts)); the migrate/restore scripts run against the same file. No new env.

---

## Q2 — FK index coverage (migration `0092`, additive — do this first)

**Problem.** Several FK columns have no supporting index, so joins/cascade-deletes through them do full table scans. Harmless at 28 tasks, but multi-tenant + growth make cascade deletes (delete a task → cascades to `time_blocks`, `reminders`, `flight_plan`, …) the first thing to slow down.

**Goal.** Add a covering index for each unindexed FK column on a hot path. Purely additive — no data change, no behavior change.

**The gap list (verified against `main` @ 0091).** Already-indexed columns (e.g. all `owner_id`s, `time_blocks.parent_block_id` via `ix_time_blocks_parent` in 0023, `objective_tasks.task_id`, `time_entries.task_id`) are **not** re-added. Add indexes for:

- `time_blocks.task_id` — high-traffic cascade path (task delete → blocks)
- `time_blocks.category_id` → tags
- `reminders.task_id` — cascade path
- `reminders.block_id` — cascade path
- `tasks.parent_id` — subtask hierarchy self-join
- `tasks.recurrence_parent_id` — recurrence template link self-join
- `job_runs.job_id` → scheduled_jobs (job-monitoring queries)
- `daily_plan.block_id` → time_blocks (SET NULL path)
- `possible_tasks.proposed_owner_id` and `possible_tasks.promoted_task_id`

> Re-verify each column name against `schema.ts` in your fresh worktree before writing the SQL (a couple were renamed over time). Skip any that already have an index — check `SELECT name,sql FROM sqlite_master WHERE type='index'`.

**Migration draft — `0092_fk_indexes.ts`:**
```ts
import type { Database } from 'better-sqlite3';

export const id = '0092_fk_indexes';

/**
 * Add covering indexes for FK columns on hot cascade/join paths that lacked one.
 * Purely additive + idempotent (CREATE INDEX IF NOT EXISTS). No data change.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_time_blocks_task        ON time_blocks(task_id);
    CREATE INDEX IF NOT EXISTS ix_time_blocks_category    ON time_blocks(category_id);
    CREATE INDEX IF NOT EXISTS ix_reminders_task          ON reminders(task_id);
    CREATE INDEX IF NOT EXISTS ix_reminders_block         ON reminders(block_id);
    CREATE INDEX IF NOT EXISTS ix_tasks_parent            ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS ix_tasks_recurrence_parent ON tasks(recurrence_parent_id);
    CREATE INDEX IF NOT EXISTS ix_job_runs_job            ON job_runs(job_id);
    CREATE INDEX IF NOT EXISTS ix_daily_plan_block        ON daily_plan(block_id);
    CREATE INDEX IF NOT EXISTS ix_possible_tasks_proposed_owner ON possible_tasks(proposed_owner_id);
    CREATE INDEX IF NOT EXISTS ix_possible_tasks_promoted_task  ON possible_tasks(promoted_task_id);
  `);
}
```

**Definition of done:** migration registered in `index.ts`; each index exists after migration; no duplicate-index errors on re-run (IF NOT EXISTS).

**Tests planned (prove the goal):**
- [ ] Assert each new index exists: `SELECT count(*) FROM sqlite_master WHERE type='index' AND name = ?` returns 1 for each.
- [ ] (Optional, stronger) `EXPLAIN QUERY PLAN` for a delete/join through one path (e.g. `DELETE FROM tasks WHERE id=?`) mentions an index scan, not `SCAN time_blocks`.
- [ ] Re-running the migration is a no-op (idempotency).

**Acceptance criteria:** all listed indexes present; suite + typecheck green; no schema.ts change needed (indexes aren't modeled in drizzle here).

**Files:** new `server/src/db/migrations/0092_fk_indexes.ts`; edit `server/src/db/migrations/index.ts`; test `server/test/schema-indexes.test.ts` (new) or extend an existing migration test.

---

## Q3 — `flight_plan` integrity rebuild (migration `0093`, HIGHEST RISK — read §0.4/§0.5)

**Problem.** `flight_plan` ([`0016_flight_plan.ts`](../server/src/db/migrations/0016_flight_plan.ts)) has PK `(owner_id, task_id)`, but `owner_id` is **not** `NOT NULL` and was declared `INTEGER` (now holds TEXT UUIDs via flexible typing). SQLite doesn't imply NOT NULL for non-integer PK columns, so a NULL `owner_id` could slip in — and since `NULL ≠ NULL`, even duplicate `(NULL, task_id)` rows. Every other composite PK in the schema has `NOT NULL` on all key columns; this is the outlier. Multi-tenant makes a NULL/ambiguous owner a real isolation bug.

**Goal.** Rebuild `flight_plan` so `owner_id` is `TEXT NOT NULL`, correctly typed, still the composite PK — preserving all current columns and rows.

**Current columns (verify in your worktree — post-`0081` rework replaced `source_pattern_id` with `source_kind`/`source_ref`):** `owner_id`, `task_id`, `source_kind`, `source_ref`, `selected`, `position`, `added_at`.

**Why safe-ish:** `flight_plan` is a **leaf table** (verified — no other table references it via FK), and it has **no indexes besides the PK**. So the 12-step rebuild here does **not** need to disable FK checks or recreate child indexes.

**Migration draft — `0093_flight_plan_notnull.ts`:**
```ts
import type { Database } from 'better-sqlite3';

export const id = '0093_flight_plan_notnull';

/**
 * Rebuild flight_plan so owner_id is TEXT NOT NULL (it's a composite-PK column
 * but was nullable + declared INTEGER — the schema outlier). SQLite can't add
 * NOT NULL / change a PK column in place, so this is the standard table rebuild.
 * flight_plan is a LEAF table (no inbound FKs) with no extra indexes, so no
 * PRAGMA foreign_keys toggle and no index recreation are needed. Forward-only.
 *
 * NB: if any legacy row somehow has NULL owner_id, the INSERT ... SELECT below would
 * violate the new NOT NULL and fail the migration (correct — surface it). In
 * single-owner data there are none; if you want to be defensive, COALESCE to the
 * SYSTEM_OWNER_ID sentinel — but prefer failing loudly unless the owner asks.
 */
export function up(db: Database): void {
  // Idempotency guard: bail if owner_id is already NOT NULL (re-run safety).
  const col = (db.prepare(`PRAGMA table_info(flight_plan)`).all() as any[])
    .find((c) => c.name === 'owner_id');
  if (col && col.notnull === 1) return;

  db.exec(`
    CREATE TABLE flight_plan_new (
      owner_id    TEXT NOT NULL REFERENCES owners(id),
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      source_kind TEXT DEFAULT 'manual',
      source_ref  TEXT,
      selected    INTEGER DEFAULT 1,
      position    INTEGER DEFAULT 0,
      added_at    TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_id, task_id)
    );
    INSERT INTO flight_plan_new (owner_id, task_id, source_kind, source_ref, selected, position, added_at)
      SELECT owner_id, task_id, source_kind, source_ref, selected, position, added_at FROM flight_plan;
    DROP TABLE flight_plan;
    ALTER TABLE flight_plan_new RENAME TO flight_plan;
  `);
}
```

> **Implementer checks before shipping this SQL:**
> - Confirm the column list matches the *current* `flight_plan` exactly (add/remove columns to match — do not drop data).
> - Confirm no index exists on `flight_plan` other than the auto PK index (verified true on main; re-check). If one exists, recreate it after the rename.
> - Do **not** add `ON DELETE CASCADE` to `owner_id` — that's a behavior change; keep the FK as-is (owners are never deleted today). Note it as a multi-tenant follow-up if desired.

**Also update `schema.ts`:** `flight_plan.ownerId` currently lacks `.notNull()` — add it so drizzle types match the DB:
```ts
ownerId: text('owner_id').references(() => owners.id).notNull(),
```

**Definition of done:** `owner_id` is NOT NULL (PRAGMA table_info shows notnull=1); rows preserved; PK intact; `schema.ts` updated; `foreign_key_check` clean.

**Tests planned (prove the goal):**
- [ ] After migration, `PRAGMA table_info(flight_plan)` shows `owner_id` with `notnull=1`.
- [ ] Inserting a `flight_plan` row with `owner_id = NULL` **throws** (NOT NULL enforced).
- [ ] Row-count preserved: seed N flight_plan rows in a test DB state, run assertion that all survive (in practice, verify the copy logic in a focused test that seeds rows before the assertion — or trust the migration + add a "columns/PK unchanged" assertion).
- [ ] `PRAGMA foreign_key_check` returns no rows after migration.
- [ ] The composite PK still rejects duplicate `(owner, task)`.

**Acceptance criteria:** all DoD boxes; server suite + typecheck green; no other table references `flight_plan` broke (there are none).

**Files:** new `server/src/db/migrations/0093_flight_plan_notnull.ts`; `server/src/db/migrations/index.ts`; `server/src/db/schema.ts` (flight_plan); test `server/test/flight-plan-schema.test.ts` (new). Confirm `flight_plan` is in `resetDb`'s clear list (it should be; add if missing).

---

## Q4 — `daily_summaries` default fix rebuild (migration `0094`)

**Problem.** `daily_summaries` ([`0001_baseline.ts`](../server/src/db/migrations/0001_baseline.ts)) declared `owner_id INTEGER NOT NULL DEFAULT 1`; **0030 retyped it to `TEXT`** but kept the default, so today it's `TEXT NOT NULL DEFAULT 1` — an **integer literal default naming no real owner** (owners are UUIDv7 TEXT post-0030). It works only because nothing relies on the default (the app always supplies `owner_id`); a row that ever fell back to `1` would be a broken owner reference under multi-tenant.

**Goal.** Rebuild `daily_summaries` so `owner_id` is `TEXT NOT NULL` with **no** bogus default. `daily_summaries` is a **regenerable cache** (day briefings, keyed by `inputs_hash`) and a **leaf table** — lowest-consequence rebuild in the phase.

**Migration draft — `0094_daily_summaries_owner_default.ts`:** same rebuild shape as Q3. Current columns: `owner_id, date, prose, stats, focus, llm, inputs_hash, created_at, updated_at`; PK `(owner_id, date)`.
```ts
import type { Database } from 'better-sqlite3';

export const id = '0094_daily_summaries_owner_default';

/** Rebuild daily_summaries to drop the legacy `owner_id INTEGER DEFAULT 1`
 *  (a now-invalid default on a UUID-TEXT column). owner_id -> TEXT NOT NULL, no
 *  default. Leaf table + regenerable cache; standard rebuild, no FK toggle. */
export function up(db: Database): void {
  const col = (db.prepare(`PRAGMA table_info(daily_summaries)`).all() as any[])
    .find((c) => c.name === 'owner_id');
  if (col && col.dflt_value == null && col.notnull === 1 && (col.type || '').toUpperCase() === 'TEXT') return;

  db.exec(`
    CREATE TABLE daily_summaries_new (
      owner_id    TEXT NOT NULL REFERENCES owners(id),
      date        TEXT NOT NULL,
      prose       TEXT NOT NULL,
      stats       TEXT NOT NULL,
      focus       TEXT NOT NULL DEFAULT '[]',
      llm         INTEGER NOT NULL DEFAULT 0,
      inputs_hash TEXT NOT NULL,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_id, date)
    );
    INSERT INTO daily_summaries_new
      SELECT owner_id, date, prose, stats, focus, llm, inputs_hash, created_at, updated_at FROM daily_summaries;
    DROP TABLE daily_summaries;
    ALTER TABLE daily_summaries_new RENAME TO daily_summaries;
  `);
}
```
> Verify the current column list/order against the actual table (0002 added columns) before shipping.

**Definition of done / Tests / Acceptance:** as Q3 (table_info shows `owner_id` TEXT, notnull=1, `dflt_value` NULL; rows preserved; `foreign_key_check` clean; suite green). `daily_summaries` is migration-only (not in `schema.ts`) — no drizzle change. Confirm it's in `resetDb`'s clear list (it is).

---

## Q5 — Post-migration integrity assertion + doc sync

**Goal.** Lock in the invariants and keep docs honest.

**Tests planned:**
- [ ] A test that, after all migrations import, asserts `PRAGMA integrity_check` returns the single row `ok` and `PRAGMA foreign_key_check` returns **zero** rows. (This is the phase's top-level safety net; run it in the server suite so any future migration that introduces an orphan fails CI.)

**Docs:** update the migration-head references (`0091 → 0094`) in [README.md](../README.md) and [ARCHITECTURE.md](../ARCHITECTURE.md) (the mermaid "Migration runner" labels, the schema-table intro, the file-tree comment, the "Shipped phases" head number), and note the `flight_plan`/`daily_summaries` owner_id fixes in the schema tables. GLOSSARY needs no change (no noun change). See PR #203 for exactly which lines these live on.

---

## Tier 2 — DO NOT IMPLEMENT IN THIS PHASE (design-first)

These came up in the review. They are **explicitly out of scope** — each is a refactor that touches business logic and/or needs a design decision. Attempting them here (especially by a fast implementer) risks breakage that's expensive to unwind. Listed so the next phase can plan them.

- **`scheduling_prefs` stays a single table — DO NOT split it (owner decision, 2026-07-01).** It has 36 columns spanning scheduling, AI-model config, feature flags, memory-sync, planning/concept, and trust/automation. A split (`ai_settings` / `feature_flags` / `memory_config` / …) was considered and **explicitly declined**: it touches every prefs reader/writer + the Settings UI + `resetDb`'s prefs baseline for no functional gain at this scale, and it would complicate — not help — the multi-tenant work. Do not split it in this phase **or** the multi-tenant phase. A wide single-row prefs table is a fine pattern here; revisiting it is a separate, owner-initiated decision only.
- **Recurrence unification.** `tasks`, `time_blocks`, `patterns` each carry near-identical recurrence columns and each has its own expander. Consolidating is a logic refactor, not a schema tidy.
- **Single-source "default minutes."** ~7 columns across `block_templates`, `pattern_prefs`, `pattern_types`, `category_prefs`, `scheduling_prefs` (×2), plus `tasks.estimated_minutes`. Picking a source of truth is a product decision.
- **JSON-in-TEXT validation.** ~11 opaque JSON columns. Adding CHECK/validation is possible but low-ROI at current volume.
- **Table-count reduction generally.** 45+ tables is fine for the feature set; "too many tables" is not itself a bug.

---

## Multi-tenant bridge — the real prerequisite, but NOT this phase's job

The single biggest multi-tenant schema gap is **tables with no `owner_id`** (rows can't be isolated per tenant). Documented here so the multi-tenant phase has the map — but **owner-scoping these is that phase's work**, because adding `owner_id` ripples into every query, the sync layer, and the calendar, and needs a backfill strategy. Do **not** add `owner_id` to these in the hygiene phase.

Owner-less tables on `main` (verified @ 0091):
- **`time_blocks`** — the calendar; owner-less since the single-owner era (only reachable via `task_id → tasks.owner_id`, which breaks for owner-less blocks like synced meetings). **Multi-tenant blocker #1.**
- **`tags`, `tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags`** — the whole tag axis is tenant-global today.
- **`scheduled_jobs`** (+ `job_runs`) — global cron registry; multi-tenant needs per-owner scoping or an account-level runner.
- `sync_events` has an `owner_id` *value* but it isn't a FK column.
- Cascade-isolated junctions that are fine as-is (isolation flows through their parents' FKs): `pattern_tasks`, `task_dependencies`, `possible_task_tags`. `possible_tasks` uses `proposed_owner_id` (not `owner_id`) — reconcile naming when multi-tenant lands.

Also for multi-tenant/OIDC: `owners.id` is the UUIDv7 `SYSTEM_OWNER_ID` sentinel today (single owner). OIDC will introduce real subjects — plan the `owners` ↔ OIDC-subject mapping (a new column or table) as part of that phase, not here.

---

## Definition of done — checklist to hand back

- [ ] §0 guardrails read; branched from `origin/main`; head confirmed `0091`; numbers `0092/0093/0094` still free (else renumbered).
- [ ] Q1 helper + all connections set `foreign_keys = ON`; enforcement test throws on a violation.
- [ ] Q2 `0092` indexes present + idempotent.
- [ ] Q3 `0093` rebuild: `flight_plan.owner_id` TEXT NOT NULL, PK intact, rows preserved, `schema.ts` updated, NULL-insert throws.
- [ ] Q4 `0094` rebuild: `daily_summaries.owner_id` TEXT NOT NULL, no integer default, rows preserved.
- [ ] Q5 integrity/foreign_key_check test green; README + ARCHITECTURE head refs → `0094`.
- [ ] `pnpm --filter server test` (TZ=UTC) + `pnpm --filter server typecheck` green; CI green.
- [ ] Tier 2 + owner-less tables left untouched.
- [ ] One PR (or one per ticket if you prefer) against `main`; if Copilot autofix pushes to the branch, reconcile don't clobber.
