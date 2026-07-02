# Handoff — schema cleanup (Phases Q + S) complete → next up is multi-tenant

**Written 2026-07-02.** A session-continuity handoff. Read this, then `git fetch origin main` and re-verify the head before doing anything (see Gotcha #1).

---

## 1. Current state (verify, don't trust)

- **`main` migration head: `0097_tag_prefs`.** All schema-cleanup work (Phases Q + S) is merged.
- The app is single-owner (`owners.id` = the `SYSTEM_OWNER_ID` UUIDv7 sentinel), local-first SQLite (better-sqlite3 + drizzle), Koa API + SolidJS client. Identity is UUIDv7 TEXT everywhere (since `0030`).
- **Verify on arrival:** `git fetch origin main && ls server/src/db/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -1` → should be `0097_tag_prefs.ts`. `pnpm --filter server test` (under `TZ=UTC`) + `pnpm --filter server typecheck` should be green.

## 2. What shipped in the Q + S work (all merged to `main`)

**Phase Q — schema hygiene (pre-multi-tenant):** spec PR #204, impl PR #205. Migrations `0092`–`0094`.
- `0092` FK-path indexes; a shared `openDb()` ([`../server/src/db/open.ts`](../server/src/db/open.ts)) so every writable connection sets `foreign_keys=ON`; `0093` `flight_plan.owner_id → TEXT NOT NULL`; `0094` drop `daily_summaries`'s bogus `owner_id DEFAULT 1`; integrity-check test. Spec: [Q-schema-hygiene.md](Q-schema-hygiene.md).

**Phase S — table consolidation:** plan PR #207, impls #208/#209/#211, recurrence fix #210. Migrations `0095`–`0097`. Spec: [S-schema-consolidation.md](S-schema-consolidation.md).
- **S1-A (`0095`)** — dropped the dead `plan_outcomes` table + retired its `aggregate_plan_outcomes` cron (zero production readers).
- **S1-B (`0096`)** — merged `daily_summaries` + `day_stars` → **`daily_recap`** (one row per `(owner,date)`). Load-bearing detail: the star freeze's first-freeze-wins now keys on **`frozen_at IS NOT NULL`**, not row existence, with a `WHERE frozen_at IS NULL` guarded partial upsert (see Gotcha #5).
- **S2 (`0097`)** — merged `pattern_prefs` + `category_prefs` → **`tag_prefs`** with a `kind` (`'pattern'|'category'`) discriminator; upserts normalize `kind` on conflict.
- Net: **−3 tables** (`plan_outcomes`, `day_stars`, `category_prefs` gone). **All four HTTP contracts unchanged** (`GET /api/summary`, `GET /api/stars`, `GET/PUT /api/pattern-prefs`, `GET/PUT /api/category-prefs`).

`Q2-table-consolidation.md` was an earlier duplicate of the S plan; it was superseded and its PR (#206) **closed** (so it is not in the repo). [S-schema-consolidation.md](S-schema-consolidation.md) is the canonical record.

## 3. THE NEXT PHASE — multi-tenant + OIDC/OAuth (this is why Q + S happened)

Q + S were explicitly the "make the schema correct before multi-tenant" work. The schema is now clean, but **the consolidations were NOT multi-tenant blockers** — the day/prefs tables were already owner-scoped. The real multi-tenant work is elsewhere. Start from [Q-schema-hygiene.md](Q-schema-hygiene.md) → **"Multi-tenant bridge"** section, which maps it:

- **Owner-*less* tables (rows can't be isolated per tenant) — the actual blockers:**
  - **`time_blocks`** — the calendar; owner-less since the single-owner era (only reachable via `task_id → tasks.owner_id`, which breaks for owner-less blocks like synced meetings). **Blocker #1.**
  - **The tag axis** — `tags`, `tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags` are all tenant-global today. (Note: `tag_prefs`, new in S2, IS owner-scoped, but its `tag_id` FK points at the tenant-global `tags` table.)
  - **`scheduled_jobs`** (+ `job_runs`) — global cron registry; needs per-owner scoping or an account-level runner.
- **OIDC:** `owners.id` is a single `SYSTEM_OWNER_ID` sentinel today. OIDC introduces real subjects — plan an `owners` ↔ OIDC-subject mapping (new column or table) as part of that phase.
- Adding `owner_id` to the owner-less tables ripples into every query, the sync layer, and the calendar, and needs a backfill strategy — this is a real phase, design-first, like Q/S were.

## 4. Conventions you must follow (learned/confirmed in Q + S)

- **Migrations** live in `server/src/db/migrations/NNNN_name.ts`, are **forward-only + idempotent**, and MUST be registered in [`../server/src/db/migrations/index.ts`](../server/src/db/migrations/index.ts) (`import * as mNNNN from './NNNN_name.js'` — note `.js` — plus append to the `MIGRATIONS` array). An unregistered file never runs.
- **SQLite can't `ALTER COLUMN` / drop a default / change a PK / merge tables in place.** For rebuilds/merges use the shared **`rebuildTable`** helper ([`../server/src/db/migrate.ts`](../server/src/db/migrate.ts)) OR a bespoke migration, and mark it **`export const manual = true`** so it runs outside the runner's auto-transaction and can toggle `PRAGMA foreign_keys=OFF` for the swap (a no-op inside a transaction). Exemplars: `0030_uuidv7_identity`, `0068_day_types`, and Q/S's `0093`/`0094`/`0096`/`0097`. Leaf tables can technically skip `manual`, but prefer it for consistency + forward-safety.
- **[`../server/test/__snapshots__/baseline.characterization.test.ts.snap`](../server/test/__snapshots__/baseline.characterization.test.ts.snap)** pins every table's name + column list. Any schema change fails it — regenerate deliberately (`pnpm --filter server exec vitest run baseline.characterization -u`) and **eyeball the diff** (it's your proof you changed exactly what you intended, nothing else).
- **Backup/export-import** ([`../server/src/routes/backup.ts`](../server/src/routes/backup.ts)): a `OWNER_TABLES` list + payload keys + import delete/insert, gated by **`EXPORT_VERSION`** (now `'3'`). Any table rename in the export payload requires updating all of those **and bumping `EXPORT_VERSION`**.
- **`resetDb()`** ([`../server/test/helpers.ts`](../server/test/helpers.ts)): a table depended on by tests must be cleared here (or cascade-cleared via a parent FK). Prefs tables are intentionally kept seeded / cascade via `tags`.
- **`schema.ts` drizzle model** can drift from the DB. [`../server/test/schema-parity.test.ts`](../server/test/schema-parity.test.ts) guards ONE table (now `tag_prefs`) for column parity. Not every table is in `schema.ts` (e.g. `daily_recap` is migration-only) — that's fine.
- **Test harness:** one shared SQLite DB, files run **sequentially** (`fileParallelism:false`), migrations run on import, the test DB is **pid-keyed** (concurrent `vitest` processes don't collide). **Always run tests with `TZ=UTC` and pin all dates** — the repo's #1 flake source.

## 5. Hard-won gotchas from the Q + S work (avoid repeating)

1. **The default worktree is often STALE.** Multiple audits misread the migration head. Always branch fresh from `origin/main` and confirm the head before writing SQL.
2. **Stacked-PR merge trap.** If a PR's base is another *feature branch* (not `main`), merging it lands the content in **that branch, not `main`**. In S, S1-B (#209, base = the S1-A branch) merged into the intermediate branch and never reached `main`; the recovery was to have #211 carry both S1-B + S2 onto `main`. **Prefer PRs based on `main`; if you must stack, verify the content actually reached `main` after each merge** — and note `git ls-tree origin/main -- <path>` **exits 0 even for a missing path** (false "present"); verify with a real content `grep` instead.
3. **Non-UTC time-bomb tests.** A test that derives "today" from the real clock in a non-UTC prefs timezone flakes near the UTC/local midnight boundary (it reddens CI for hours). Fix: `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(<fixed noon-UTC instant>)`, and pin the anchor. (This bit `recurrence-horizon.test.ts`; fixed in #210.) Such a flake is **latent in `main`** until its fix merges, so it can redden *any* PR's CI near the boundary.
4. **A review bot** ("**Potential fix for pull request finding**", authored by the repo owner's account = Copilot autofix) pushes small commits directly onto open PR branches. **Reconcile (rebase), don't force-clobber.** It touched `open.ts` (#205) and doc wording (#207) during Q/S.
5. **Merging a mutable cache with a write-once immutable freeze** (S1-B): the immutability guard must key on the freeze marker (`frozen_at IS NOT NULL`), not row existence, once another writer can create the row first — and each writer must do a **column-scoped partial upsert** so they don't clobber each other's group. A naive port silently breaks freezing. Test both orderings (freeze-then-write AND write-then-freeze).

## 6. Verification discipline that worked (reuse it)

- **Plan → adversarial critique → harden → implement → adversarially verify.** For each substantive ticket, spread reviewers across dimensions, then skeptically verify each finding. The critique of the *plan* caught real bugs before any code (e.g. the freeze-guard trap; two hidden raw-SQL readers `engine/reminders.ts` + `routes/reflections.ts` that bypass the service layer). Implementation-verification passes returned 0 findings on the final code.
- Always: full suite under `TZ=UTC` + typecheck before pushing; regenerate + eyeball the baseline golden; grep the *whole* repo (server **and** client **and** tests) for raw references to a renamed/dropped table — the service layer isn't the only reader.

## 7. Map of where things live

- **Specs / handoffs:** [Q-schema-hygiene.md](Q-schema-hygiene.md) (Q + the multi-tenant bridge map), [S-schema-consolidation.md](S-schema-consolidation.md) (S, marked implemented).
- **As-built refs (kept current):** [../ARCHITECTURE.md](../ARCHITECTURE.md) (schema tables, ER + sequence diagrams, cron table, migration head), [../README.md](../README.md) (schema overview), [GLOSSARY.md](GLOSSARY.md) (canonical nouns — a strict "noun budget"; respect it).
- **Migration mechanics:** [`../server/src/db/migrate.ts`](../server/src/db/migrate.ts) (`runMigrations`, `rebuildTable`), [`../server/src/db/migrations/index.ts`](../server/src/db/migrations/index.ts) (registry), [`../server/src/db/open.ts`](../server/src/db/open.ts) (the FK-on opener).

## 8. Recommended first moves to excel

1. `git fetch origin main`; confirm head `0097`, suite + typecheck green (`TZ=UTC`).
2. If starting multi-tenant: read the "Multi-tenant bridge" section of [Q-schema-hygiene.md](Q-schema-hygiene.md) + [../ARCHITECTURE.md](../ARCHITECTURE.md), then produce a **design-first plan doc** (same convention as Q/S) covering owner-scoping `time_blocks` / the tag axis / `scheduled_jobs` + the `owners`↔OIDC-subject mapping + a backfill strategy. Get owner sign-off on the mechanism before coding.
3. Ship in small, `main`-based, independently-verifiable PRs (avoid deep stacks — see Gotcha #2).
4. Keep the plan→critique→verify loop; hold the line on frozen HTTP contracts + the baseline golden + `EXPORT_VERSION`.

## 9. Fenced off — do NOT touch without explicit owner sign-off

- **`scheduling_prefs` split** — reviewed and **declined** (owner decision, 2026-07-01). A wide 36-column single-row prefs table is fine here.
- **Recurrence unification** (`tasks`/`time_blocks`/`patterns` each carry near-identical recurrence columns) and **single-source "default minutes"** (~7 columns across several tables) — logic refactors, design-first, separate owner-initiated decisions. Not table-count issues.
