# Q2 — Table consolidation (the Tier-2 follow-on to Phase Q) — implementation handoff

**Status:** SPEC'd · not started · **`main` migration head `0094`** (verify before branching — see §0) · next free number **`0095`**. **Depends on:** Phase Q (merged, PR #205). Companion to [Q-schema-hygiene.md](Q-schema-hygiene.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md).

> **What this is.** Phase Q fenced "table-count reduction" as *design-first, not a bug*. This doc is that design, now owner-greenlit for two real candidates. **This plan was hardened by an adversarial review pass** — the write-ups below fold in 11 confirmed findings (a silent star-freeze breakage, two missed raw-SQL production call-sites, several missed test fixtures, and a risk/ROI reframing). Read the tiering in §Scope before committing scope.
>
> - **C1 — day-grain cleanup**, split into two tiers by risk:
>   - **C1-A (recommended, low risk): drop `plan_outcomes`** + retire its nightly cron. It has *zero* production readers.
>   - **C1-B (optional, higher risk): co-locate `daily_summaries` + `day_stars`** into one `day_records` table. This is where the real design work is (a self-invalidating mutable cache living in the same row as a write-once immutable freeze).
> - **C2 — prefs merge:** fold `category_prefs` (a literal "trimmed mirror") into `pattern_prefs` as one `tag_prefs` table with a `kind` discriminator. Modest ROI; several hidden raw-SQL readers.

> **Who this is for.** A fresh implementation chat. Unlike Phase Q (pure hygiene, no behavior change), **this phase touches business logic and client-facing API response shapes.** Overriding rule: **the GET/PUT JSON contracts must not change** — these are *storage* refactors behind the existing routes/services, not API redesigns. **Do not trust "just repoint the service": several readers issue raw SQL against the physical tables** (enumerated per ticket) and bypass the service layer entirely.

---

## §0 — READ FIRST: guardrails

1. **The default worktree is often STALE** (Phase Q's #1 gotcha). Branch fresh from `origin/main`, then confirm the head is `0094`:
   ```bash
   git fetch origin main
   ls server/src/db/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -3   # highest must be 0094
   ```
   If not `0094`, main moved — re-derive free numbers and re-verify every column list here against the live schema before writing SQL.

2. **Migration numbers are provisional** (`0095` = C1-A, `0096` = C1-B, `0097` = C2 — shift per whichever tiers ship and in what order). Register each in [`migrations/index.ts`](../server/src/db/migrations/index.ts) with the exact ESM pattern (`import * as mNNNN from './NNNN_name.js';` + append to `MIGRATIONS`). **Because three tickets each edit `migrations/index.ts`, `schema.ts`, and the baseline snapshot, ship them as separate PRs and expect merge-order renumbering** (append-only; cosmetic but must stay unique/ascending).

3. **C1-B and C2 are table *merges*, not single-table shape changes.** The repo's [`rebuildTable`](../server/src/db/migrate.ts) helper rebuilds *one* table in place; it does **not** fit a 2-into-1 merge. Write a **bespoke `manual` migration** that: `pragma foreign_keys=OFF` → in a tx: `CREATE` the new table, backfill via `INSERT ... SELECT`, `DROP` the old tables, recreate indexes → `finally pragma foreign_keys=ON`. Use `export const manual = true` (same reason as `0030`/`0068`/`0093`/`0094`). C1-A (a plain `DROP TABLE` + `DELETE FROM scheduled_jobs`) can be a normal non-manual migration (no FK toggle needed — dropping a leaf table with FK on is fine).

4. **SQLite can't `ALTER COLUMN` / drop a default / change a PK.** All migrations forward-only, additive/idempotent; guard on the target already existing/absent (e.g. `SELECT name FROM sqlite_master WHERE type='table' AND name='day_records'` → return early; for a drop, guard `IF EXISTS`).

5. **Identity is UUIDv7 TEXT** (post-`0030`); every table here is already `owner_id TEXT NOT NULL` after Phase Q. Trust the live shape / `schema.ts` over an old migration's declared type.

6. **The schema-shape golden WILL fail and must be regenerated in lockstep.** [`baseline.characterization.test.ts.snap`](../server/test/__snapshots__/baseline.characterization.test.ts.snap) pins every table's name + column list. Any table drop/add changes it. Regenerate deliberately (`vitest -u`) and **eyeball the diff** — it's your proof the migration changed exactly what you intended.

7. **Backup/export-import must keep working and `EXPORT_VERSION` must bump.** [`routes/backup.ts`](../server/src/routes/backup.ts): `OWNER_TABLES` list + `EXPORT_VERSION` (currently `'1'`; import rejects a mismatch at ~`:148-152`). Export asymmetry to respect: `daily_summaries`/`category_prefs`/`pattern_prefs` are exported; `plan_outcomes`/`day_stars` are **not**.

8. **Client API contracts are frozen.** `GET /api/summary`, `GET /api/stars`, `GET/PUT /api/pattern-prefs`, `GET/PUT /api/category-prefs` shapes must be byte-identical after the change (client types in [`client/src/lib/api.ts`](../client/src/lib/api.ts) + ~8 components depend on them). Routes/services become thin adapters over the merged storage.

9. **Test-harness rules** ([`server/test/helpers.ts`](../server/test/helpers.ts)): sequential shared DB, migrations on import, `TZ=UTC`, pin dates. Verify with `pnpm --filter server test` (`TZ=UTC`) + `pnpm --filter server typecheck`; both CI jobs green. **Many tests hit these tables by raw SQL** (enumerated per ticket) — those are not covered by "the service is a thin adapter" and must be rewritten.

10. **Docs are a required touch point** (the repo treats doc drift as ship-relevant — cf. PRs #203/#204). Each ticket's DoD includes syncing README.md + ARCHITECTURE.md (schema tables, ER-diagram nodes, cron table, sequence diagram, migration-head strings) and GLOSSARY.md.

11. **Review bots:** Copilot autofix may push to the branch — reconcile, don't clobber.

---

## Findings that shaped this plan (from a full readers/writers/tests/semantics audit)

**Day-grain trio — three tables, three *different* lifecycles (this is the crux):**

| Table | Lifecycle | Writer | Production readers | In `schema.ts`? | In backup? |
|---|---|---|---|---|---|
| `daily_summaries` | **Mutable cache**, self-invalidating via `inputs_hash`; upsert `ON CONFLICT DO UPDATE` | `agents/summarize.ts` | `GET /api/summary` | ❌ (migration-only) | ✅ exported |
| `plan_outcomes` | **Mutable rollup**, nightly-recomputed; upsert | `jobs/aggregate-plan-outcomes.ts` (cron 01:30) | **NONE** (grep-confirmed; only `learning-loops.test.ts` reads it) | ❌ | ❌ |
| `day_stars` | **Write-once immutable freeze**; plain `INSERT`, first-freeze-wins; `frozen_at NOT NULL` | `jobs/freeze-stars.ts` (cron 00:20) | `GET /api/stars` (frozen row if present, else live `computeStars()`) | ❌ | ❌ |

- **`plan_outcomes` is dead weight** — the near-certain cleanup (→ **C1-A**).
- The three **never join each other** and have **different row populations** per day → a merged row is legitimately sparse.
- **Co-locating an immutable freeze (`day_stars`) with a mutable cache (`daily_summaries`)** is the real design problem (→ **C1-B**). Solvable, but the immutability guard must change (see the ⚠️ in C1-B).

**Prefs pair — a deliberate mirror, with hidden raw-SQL readers:**
- `category_prefs` columns ⊂ `pattern_prefs`: shared `id, owner_id, <axis>_tag_id, color_token, default_minutes`; `pattern_prefs` adds `auto_fill, reminder_offsets, icon_shape`. Both key on `UNIQUE(owner_id, <axis>_tag_id)`, FK `→ tags(id) ON DELETE CASCADE`, distinguished by `tags.kind`.
- **Hidden raw-SQL readers that bypass the services** (must be repointed by hand): `engine/reminders.ts` (`SELECT reminder_offsets FROM pattern_prefs`), `routes/reflections.ts` (`LEFT JOIN category_prefs`). Plus ~6 test files with raw fixtures.
- **Behavioral divergence to preserve:** `category_prefs.color_token` is the source of a forward-only frozen stamp onto `time_blocks.color_token` (`routes/blocks.ts`); `pattern_prefs.color_token` has no such path. `category_prefs.default_minutes` **is** read (wizard prefill); `pattern_prefs.default_minutes` is **not** read by the server (vestigial).

---

## Scope map — three tickets, tiered by risk/ROI

| Ticket | Title | Migration | Risk | ROI | Recommend |
|---|---|---|---|---|---|
| **C1-A** | Drop `plan_outcomes` + retire its cron | `0095` | **low** (dead table; no cache/immutability/client/export impact) | **high** — one fewer table + one fewer nightly job, near-zero risk | ✅ **do it** |
| **C1-B** | Co-locate `daily_summaries` + `day_stars` → `day_records` | `0096` | **high** (two lifecycles in one row, business logic, client contracts) | medium — the phase's second table-drop, but the risk is concentrated here | ⚠️ optional |
| **C2** | Merge `category_prefs` → `pattern_prefs` as `tag_prefs` | `0097` | med (hidden raw-SQL readers) | modest — DRY + one fewer table; API surface unchanged | optional |

**Recommended path:** ship **C1-A** first (cheap win). Treat **C1-B** and **C2** as separate, explicitly-opted-in PRs. Do not bundle. See **Decision points** at the end.

---

## C1-A — Drop `plan_outcomes` and retire its cron (migration `0095`)

**Problem.** `plan_outcomes` (created `0083`) is written nightly by the `aggregate_plan_outcomes` job but **read by no production code** (grep-confirmed across `server/src` + `client/src`; only `learning-loops.test.ts` reads it). It isn't exported. It is dead weight. If a "planned vs completed" reader is ever wanted, it is trivially re-derivable on demand from `time_blocks`+`tasks` (that's all the job does).

**Goal.** Remove the table, the job, and its seeded cron row — with no production impact.

**Coupled removals (all four, or the build/cron breaks):**
1. **Migration `0095_drop_plan_outcomes.ts`** (non-manual is fine — leaf table): `DROP TABLE IF EXISTS plan_outcomes;` **and** `DELETE FROM scheduled_jobs WHERE kind='aggregate_plan_outcomes';` — the cron seed lives in *already-applied* `0083` (`INSERT OR IGNORE`), so editing `0083` cannot un-seed existing DBs; a new migration must delete the row, or [`startCronJobs`](../server/src/jobs/index.ts) will keep firing a job whose table is gone (a recurring failed `job_run`).
2. **Remove the dispatcher case** `case 'aggregate_plan_outcomes'` in [`jobs/index.ts`](../server/src/jobs/index.ts) (~`:193-200`) and its module import (~`:19`).
3. **Delete** [`jobs/aggregate-plan-outcomes.ts`](../server/src/jobs/aggregate-plan-outcomes.ts).
4. **Delete the `describe('aggregatePlanOutcomes', …)` block** in [`learning-loops.test.ts`](../server/test/learning-loops.test.ts) (~`:112-206`) — it imports the now-deleted module (so the file won't compile otherwise) and `SELECT`s `plan_outcomes`. **Keep the independent `calibrateEstimates` block** in the same file (separate module + `estimate_calibration`, untouched).

**Also:** remove `DELETE FROM plan_outcomes` from `resetDb` ([`helpers.ts`](../server/test/helpers.ts)); update the baseline golden (§0.6); docs (§0.10) — README schema-table row + enumeration, ARCHITECTURE §5.2 row + cron-table row (`aggregate_plan_outcomes | daily 01:30`) + the sequence-diagram step `Cron->>DB: aggregate_plan_outcomes (01:30)` + the ER node `PO["plan_outcomes"]`.

**Tests / DoD:** migration test (table gone, no orphaned enabled cron row, idempotent); suite + typecheck green; head `0095`.

---

## C1-B — Co-locate `daily_summaries` + `day_stars` into `day_records` (migration `0096`, HIGHER RISK)

> Assumes **C1-A shipped** (so no `plan_outcomes`/outcome columns). If the owner keeps `plan_outcomes` instead, add `planned`/`completed` columns + a third source in the backfill and keep that job repointed — but the recommended path is C1-A first.

**Goal.** One row per `(owner_id, date)` holding the day's summary + star data, preserving each sub-system's write semantics and both HTTP contracts (`GET /api/summary`, `GET /api/stars`) byte-for-byte.

### Proposed schema (`day_records`)
```sql
CREATE TABLE day_records (
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,                    -- local YYYY-MM-DD (owner tz)
  -- summary group (nullable: a day may have stars but no briefing yet). Cache.
  prose        TEXT,
  stats        TEXT,                             -- JSON {overdue,dueToday,open,blocks}
  focus        TEXT,                             -- JSON FocusItem[]
  llm          INTEGER,                          -- 0/1: prose from LLM vs fallback
  inputs_hash  TEXT,                             -- sha256 cache fingerprint
  summary_at   TEXT,                             -- was daily_summaries.updated_at
  -- stars group (nullable until frozen). Immutable once stars_frozen_at is set.
  star_objective INTEGER, star_habits INTEGER, star_tasks INTEGER,
  star_bonus     INTEGER, star_note   INTEGER,
  stars_total    INTEGER,
  stars_frozen_at TEXT,                          -- was day_stars.frozen_at; NULL = not frozen
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, date)
);
```
> Nullability note (corrected): today `focus` is `TEXT NOT NULL DEFAULT '[]'` and `stats` is `TEXT NOT NULL` (no default) in `daily_summaries`; the five `star_*` + `total` are `NOT NULL DEFAULT 0` and `frozen_at` is `NOT NULL` in `day_stars`. In `day_records` **both groups become nullable** because a row may have only one group populated. This is safe: the summary writer always supplies its columns explicitly, and the summary cache-hit path only `JSON.parse`s `stats`/`focus` when `inputs_hash` matches (impossible for a stars-only NULL-hash row). `day_stars.total` is renamed **`stars_total`** — note the rename when repointing readers/tests.

### ⚠️ Write-path reconciliation (the critical part — a naive port breaks freezing)

Each writer touches **only its own column group** via a column-scoped upsert:

- **Summary** ([`agents/summarize.ts`](../server/src/agents/summarize.ts)): `INSERT (owner,date, prose,stats,focus,llm,inputs_hash,summary_at) … ON CONFLICT(owner_id,date) DO UPDATE SET prose=…, stats=…, focus=…, llm=…, inputs_hash=…, summary_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP` — never mentions star columns.
- **Freeze** ([`jobs/freeze-stars.ts`](../server/src/jobs/freeze-stars.ts)) — **this is where the trap is.** Preserve first-freeze-wins with a **guarded** upsert:
  ```sql
  INSERT INTO day_records (owner_id,date, star_objective,…,stars_total, stars_frozen_at)
    VALUES (?,?, …, ?)
  ON CONFLICT(owner_id,date) DO UPDATE SET
    star_objective=excluded.star_objective, …, stars_total=excluded.stars_total,
    stars_frozen_at=excluded.stars_frozen_at, updated_at=CURRENT_TIMESTAMP
  WHERE day_records.stars_frozen_at IS NULL;      -- immutability: fill stars at most once
  ```
  **🚨 You MUST change (not "keep") the existing JS read-guard.** Today `freeze-stars.ts` early-returns `{created:false}` if a `day_stars` row *exists* — safe only because a `day_stars` row exists *only* when frozen. After the merge a **summary upsert creates the `(owner,date)` row first** (with `stars_frozen_at NULL`), so an existence-based guard would early-return and **stars would never freeze on any day the user opened a briefing.** Rewrite the guard to test frozen-ness: `SELECT stars_frozen_at FROM day_records WHERE owner_id=? AND date=?; if (row?.stars_frozen_at != null) return {created:false};` — matching the SQL `WHERE`. Do **not** describe this as belt-and-suspenders; the old predicate is actively wrong.

### Reader rewrites (contracts unchanged)
- `GET /api/summary` → `summarizeDay` reads `prose,stats,focus,llm,inputs_hash` from `day_records`; same cache-hit-on-`inputs_hash` logic; response JSON identical.
- `GET /api/stars` → returns the frozen row (`star_*`,`stars_total`) where `stars_frozen_at IS NOT NULL` (`frozen:true`), else `computeStars()` live (`frozen:false`); identical per-date `{date,objective,…,total,frozen}` output. `computeStars()` is unchanged (reads reflections/tasks/daily_plan, not these tables).

### Migration `0096_day_records.ts` (bespoke manual merge)
```ts
export const id = '0096_day_records';
export const manual = true; // bespoke 2->1 merge: toggles foreign_keys. CON-1.
export function up(db) {
  if (tableExists(db, 'day_records')) return;        // idempotency guard
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE day_records ( …as above… );`);
      db.exec(`
        INSERT INTO day_records (owner_id,date, prose,stats,focus,llm,inputs_hash,summary_at,
                                 star_objective,star_habits,star_tasks,star_bonus,star_note,stars_total,stars_frozen_at)
        SELECT k.owner_id, k.date,
               s.prose,s.stats,s.focus,s.llm,s.inputs_hash,s.updated_at,
               st.star_objective,st.star_habits,st.star_tasks,st.star_bonus,st.star_note,st.total,st.frozen_at
        FROM (SELECT owner_id,date FROM daily_summaries
              UNION SELECT owner_id,date FROM day_stars) k
        LEFT JOIN daily_summaries s ON s.owner_id=k.owner_id AND s.date=k.date
        LEFT JOIN day_stars       st ON st.owner_id=k.owner_id AND st.date=k.date;`);
      db.exec(`DROP TABLE daily_summaries; DROP TABLE day_stars;`);
    })();
  } finally { db.pragma('foreign_keys = ON'); }
}
```
> `daily_summaries` is a regenerable cache — copying is optional (rebuilds on next `/api/summary`) but cheap. The `UNION` handles sparse days (summary-only or stars-only).

### Other touch points
- **`schema.ts`:** add a `dayRecords` drizzle model (adds coverage none of the three had). Consider extending the schema-parity test to `day_records`.
- **`resetDb`:** replace the `daily_summaries` + `day_stars` DELETEs with one `DELETE FROM day_records`.
- **Backup** ([`routes/backup.ts`](../server/src/routes/backup.ts)): `OWNER_TABLES` swaps `daily_summaries → day_records`; export/delete/insert follow; **bump `EXPORT_VERSION` to `'2'`**. **DECISION D2:** the merged row now carries star columns that `day_stars` never exported — simplest is to export the whole `day_records` row (frozen stars re-derive; harmless).
- **Tests that break and MUST be updated** (all confirmed to touch the raw tables): [`daily-summaries-schema.test.ts`](../server/test/daily-summaries-schema.test.ts) — its whole premise (the `0094` rebuild of `daily_summaries`) is obsoleted; delete or rewrite against `day_records`; it also calls `m0094.up(db)` directly. [`migrate.test.ts`](../server/test/migrate.test.ts) `:29` (`cols(db,'daily_summaries')).toContain('focus')` → assert on `day_records`). [`stars.test.ts`](../server/test/stars.test.ts) `frozenRow()` helper + counts (`SELECT * FROM day_stars`, and it reads `total`/`star_objective` → remap to `day_records`/`stars_total`). Plus the new contract/immutability tests below.

### Tests (prove it)
- Migration: `day_records` exists with exact columns; the two old tables gone; rows preserved incl. sparse; `foreign_key_check` clean; idempotent.
- **Contract:** `GET /api/summary` same shape + regenerate-on-input-change; `GET /api/stars` frozen-over-live with boolean mapping intact.
- **Immutability (both orders — the second is the regression guard for the trap above):** (a) freeze then summary-refresh → frozen stars unchanged; **(b) summary-upsert first, THEN freeze → stars MUST actually freeze (`created:true`)**; re-run freeze → no-op.
- `export-import.test.ts` round-trip at `EXPORT_VERSION '2'`.
- Regenerate + eyeball the baseline golden. Docs sync (§0.10): README/ARCHITECTURE `daily_summaries`+`day_stars` rows, ER nodes, head strings; GLOSSARY `day_stars` line.

### DoD
- [ ] `day_records` created, both tables dropped, rows preserved, `foreign_key_check` clean, idempotent.
- [ ] `GET /api/summary` + `GET /api/stars` byte-identical; **freeze guard rewritten to frozen-ness; summary-then-freeze test passes.**
- [ ] `schema.ts`, `resetDb`, backup (+`EXPORT_VERSION` bump), all four broken test files, baseline golden, docs updated.
- [ ] Suite + typecheck green; head `0096`.

---

## C2 — Merge `category_prefs` into `pattern_prefs` as `tag_prefs` (migration `0097`)

**Goal.** One `tag_prefs` table for both axes, distinguished by `kind`, preserving both API contracts and the block-color-stamp behavior exactly.

### Proposed schema (`tag_prefs`)
```sql
CREATE TABLE tag_prefs (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES owners(id),
  tag_id       TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                    -- 'pattern' | 'category' (mirrors tags.kind)
  color_token   TEXT NOT NULL DEFAULT 'primary',
  default_minutes INTEGER NOT NULL DEFAULT 60,
  auto_fill        INTEGER NOT NULL DEFAULT 1,   -- pattern-only (default/unused on category rows)
  reminder_offsets TEXT NOT NULL DEFAULT '[]',   -- pattern-only
  icon_shape       TEXT NOT NULL DEFAULT 'circle', -- pattern-only
  UNIQUE(owner_id, tag_id)
);
CREATE INDEX ix_tag_prefs_owner ON tag_prefs(owner_id);
```
> `UNIQUE(owner_id, tag_id)` prevents cross-axis collisions (a tag has exactly one kind). `kind` is denormalized from `tags.kind` so services/queries can filter without a join.

### Touch points — **including two hidden raw-SQL production readers the services don't cover:**
- **Services:** unify [`services/pattern-prefs.ts`](../server/src/services/pattern-prefs.ts) + [`services/category-prefs.ts`](../server/src/services/category-prefs.ts) onto `tag_prefs` filtered by `kind`; `getCategoryPrefs` returns only `{color_token,default_minutes}` (shape unchanged), `getPatternPrefs` returns all.
- **Routes:** `pattern-prefs.ts` / `category-prefs.ts` keep the same validation/404/422/audit and response shapes; only their service calls change.
- **🚨 `engine/reminders.ts` (~`:135`)** issues raw `SELECT reminder_offsets FROM pattern_prefs WHERE owner_id=?` — a **production** reader (push-notification offset scheduling, invoked on task create/update/recurrence/block-sync), *not* via the service. Repoint to `… FROM tag_prefs WHERE owner_id=? AND kind='pattern'`. (Numerically inert since category rows carry `reminder_offsets='[]'`, but the table name alone breaks it.)
- **🚨 `routes/reflections.ts` (~`:43` and `:52`)** issues raw `LEFT JOIN category_prefs cp ON cp.owner_id=r.owner_id AND cp.category_tag_id=r.category_id` in the today-goal + weekly-goal queries (backs `today.color_token` / `weekly[].color_token`). Rewrite both to `LEFT JOIN tag_prefs tp ON tp.owner_id=r.owner_id AND tp.tag_id=r.category_id AND tp.kind='category'`.
- **`routes/blocks.ts`:** preserve the forward-only color stamp (reads `getCategoryPrefs` → unchanged once the service is repointed). **`routes/tags.ts`:** on category-tag create it seeds a default pref via `setCategoryPref(...,{})` — preserve.
- **`schema.ts`:** replace `patternPrefs` + `categoryPrefs` with one `tagPrefs` model. **Update the schema-parity test** (currently guards `pattern_prefs`) to guard `tag_prefs`.
- **Backup:** the export payload **changes shape** — two top-level keys (`pattern_prefs` with `pattern_tag_id`+pattern-only cols, `category_prefs` with `category_tag_id`) collapse to one `tag_prefs` key (`tag_id`,`kind`,…). Rewrite `OWNER_TABLES`, the export object, the two DELETEs, the two `insertRows`; **bump `EXPORT_VERSION`**. (No silent data loss — import rejects the old version — but it's a real payload change, not a bare rename.)
- **`resetDb`:** unchanged — `tag_prefs` stays **out** of the clear list (both source tables were deliberately kept seeded).
- **Migration `0097_tag_prefs.ts`** (bespoke `manual` merge): create `tag_prefs`; `INSERT SELECT id,owner_id,pattern_tag_id,'pattern',color_token,default_minutes,auto_fill,reminder_offsets,icon_shape FROM pattern_prefs`; `INSERT SELECT id,owner_id,category_tag_id,'category',color_token,default_minutes,1,'[]','circle' FROM category_prefs`; recreate the owner index; drop both. Idempotency guard on `tag_prefs` existing.

### Tests
- **Only truly-unchanged (API-driven) tests:** [`blocks-category.test.ts`](../server/test/blocks-category.test.ts), [`category-fill.test.ts`](../server/test/category-fill.test.ts) (verified: zero prefs-table references).
- **MUST be rewritten** (raw SQL against the dropped tables/columns — the earlier draft wrongly called these "unchanged"): [`pattern-prefs.test.ts`](../server/test/pattern-prefs.test.ts) (`:42` SELECT, `:227` INSERT), [`reflections.test.ts`](../server/test/reflections.test.ts) (`:171` `INSERT INTO category_prefs`), [`reminders.test.ts`](../server/test/reminders.test.ts) (`:59`), [`pattern-blocks.test.ts`](../server/test/pattern-blocks.test.ts) (`:58`), [`cockpit-ux.test.ts`](../server/test/cockpit-ux.test.ts) (`:156-157`), [`audit.test.ts`](../server/test/audit.test.ts) (`:68`) → repoint to `tag_prefs(tag_id, kind=…)`. (Grep both table names + the drizzle exports `patternPrefs`/`categoryPrefs` across `server`+`client` to be exhaustive.)
- Migration test: both axes merged with correct `kind`; row counts preserved; `foreign_key_check` clean; idempotent. **Add an export-import round-trip test** at the bumped `EXPORT_VERSION`.
- Regenerate the baseline golden; docs sync (README `pattern_prefs` row + enumeration, ARCHITECTURE row; GLOSSARY `pattern_prefs` → `tag_prefs`).

### DoD
- [ ] `tag_prefs` created with both axes (correct `kind`); `pattern_prefs`/`category_prefs` dropped; rows preserved.
- [ ] All four routes' contracts unchanged; block-color-stamp + reflections color join + reminders offsets all preserved (raw-SQL readers repointed).
- [ ] `schema.ts`, parity test, backup (+version), all raw-SQL test fixtures, baseline golden, docs updated. Suite + typecheck green; head `0097`.

### ROI note (be honest)
API surface does **not** shrink (two contracts stay), so the win is: one fewer table, DRY on two near-identical services, one home for tag prefs — real but modest, and it carries more hidden call-sites than it first looks. Fine to defer.

---

## Decision points for the owner

- **D1 — scope of C1.** **Recommended: do C1-A (drop `plan_outcomes` + cron) now** — near-certain win, low risk, no cache/immutability/client/export impact. **Treat C1-B (co-locate summary+stars) as a separate, optional PR** — it's the phase's second table-drop but concentrates all the risk (guarded upserts, the freeze-guard rewrite, client-contract surface). Doing C1-A does not commit you to C1-B.
- **D2 — (only if C1-B) export the merged row's star data?** `day_stars` isn't exported today. **Recommendation:** export the whole `day_records` row (simplest; frozen stars re-derive), bump `EXPORT_VERSION`.
- **D3 — do C2 at all?** Modest ROI, several hidden raw-SQL readers. **Recommendation:** optional; if done, its own PR, after C1.

---

## DO NOT (out of scope)

- **Do not change any HTTP contract** (`/api/summary`, `/api/stars`, `/api/pattern-prefs`, `/api/category-prefs`). Storage-only.
- **Do not touch `daily_plan.outcome`** (migration `0084`) — a *different thing* from the `plan_outcomes` table; do not conflate.
- **Do not merge in `plan_hints`, `day_assignments`, or `daily_plan`** — they share the `(owner_id, date)` key but are different subjects.
- **Do not owner-scope the tag axis or touch `time_blocks`/`scheduled_jobs`** — that's the multi-tenant phase. `tag_prefs.tag_id` still points at the tenant-global `tags` axis; unchanged here.
- **Do not split `scheduling_prefs`** (owner-declined, standing decision).
